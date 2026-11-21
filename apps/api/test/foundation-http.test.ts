import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FoundationService } from "@painel/core";
import { createTestDatabase, FAST_ARGON2, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "@painel/core/testing";
import { loadConfig } from "../src/config.ts";
import { buildApiServer } from "../src/server.ts";

// Incremento 1 pela HTTP: sessão em cookie, CSRF, origem, status e isolamento (CA-020, CA-024).

const PASSWORD = "senha-forte-de-teste-1";
const ORIGIN = "http://localhost:8080";

interface Client {
  cookie: string;
  csrf: string;
  body: { organization: { id: string; role: string; permissions: Record<string, boolean> } | null };
}

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("api da fundação", () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let svc: FoundationService;

  async function login(email: string, password = PASSWORD): Promise<Client> {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    return { cookie, csrf: res.json().csrfToken, body: res.json() };
  }

  const call = (c: Client | undefined, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object, extra: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload } : {}),
      headers: { ...(c ? { cookie: c.cookie, "x-csrf-token": c.csrf } : {}), ...extra },
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    svc = new FoundationService(t.db, { argon2: FAST_ARGON2 });
    app = buildApiServer(loadConfig({ LOG_LEVEL: "fatal", AUTH_RATE_LIMIT_PER_MINUTE: "1000" }), {
      foundation: svc,
      checkDatabase: () => t.db.ping(),
    });
    const boot = await svc.bootstrapInstance(
      { adminEmail: "root@exemplo.test", adminName: "Root", organizationName: "Acme", organizationSlug: "acme" },
      { correlationId: "t" },
    );
    const res = await call(undefined, "POST", "/api/auth/password-reset/complete", { token: boot.link.token, password: PASSWORD });
    expect(res.statusCode).toBe(204);
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it("login define cookie HttpOnly e devolve papel e permissões", async () => {
    const res = await call(undefined, "POST", "/api/auth/login", { email: "root@exemplo.test", password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/^painel_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().organization).toMatchObject({ role: "admin", permissions: { manageUsers: true } });
  });

  it("login inválido: 401 com mensagem genérica", async () => {
    const res = await call(undefined, "POST", "/api/auth/login", { email: "root@exemplo.test", password: "errada-errada" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("sem sessão: 401", async () => {
    expect((await call(undefined, "GET", "/api/workspaces")).statusCode).toBe(401);
  });

  it("mutação sem token CSRF: 403; com token: 201", async () => {
    const c = await login("root@exemplo.test");
    const semCsrf = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "W1" }, headers: { cookie: c.cookie } });
    expect(semCsrf.statusCode).toBe(403);
    expect((await call(c, "POST", "/api/workspaces", { name: "W1" })).statusCode).toBe(201);
  });

  it("mutação vinda de outra origem: 403, mesmo com CSRF", async () => {
    const c = await login("root@exemplo.test");
    const res = await call(c, "POST", "/api/workspaces", { name: "W2" }, { origin: "https://malicioso.example" });
    expect(res.statusCode).toBe(403);
  });

  it("id malformado: 400, não 500", async () => {
    const c = await login("root@exemplo.test");
    expect((await call(c, "GET", "/api/projects/nao-e-uuid")).statusCode).toBe(400);
  });

  it("convite pela API devolve link com token no fragmento", async () => {
    const c = await login("root@exemplo.test");
    const res = await call(c, "POST", "/api/invites", { email: "op@exemplo.test", role: "operator" });
    expect(res.statusCode).toBe(201);
    const { url } = res.json();
    expect(url).toMatch(/^http:\/\/localhost:8080\/convite#token=[\w-]{43}$/);
    const token = url.split("#token=")[1];
    const accept = await call(undefined, "POST", "/api/auth/invites/accept", { token, password: PASSWORD, displayName: "Operadora" });
    expect(accept.statusCode).toBe(200);
    const op = await login("op@exemplo.test");
    expect(op.body.organization).toMatchObject({ role: "operator", permissions: { execute: true, createProjects: false } });
    expect((await call(op, "POST", "/api/workspaces", { name: "Proibido" })).statusCode).toBe(403);
  });

  it("CA-020 e CA-024 pela HTTP: outra organização é 404 até virar membro; a troca muda o contexto", async () => {
    const root = await login("root@exemplo.test");
    const created = await call(root, "POST", "/api/organizations", { name: "Globex", slug: "globex" });
    expect(created.statusCode).toBe(201);
    const globexId = created.json().id;

    const op = await login("op@exemplo.test");
    expect((await call(op, "POST", "/api/session/organization", { organizationId: globexId })).statusCode).toBe(404);

    const switched = await call(root, "POST", "/api/session/organization", { organizationId: globexId });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().organization).toMatchObject({ id: globexId, role: "admin" });
    expect((await call(root, "GET", "/api/workspaces")).json().items).toEqual([]);
  });

  it("logout limpa o cookie e encerra a sessão", async () => {
    const c = await login("root@exemplo.test");
    const res = await call(c, "POST", "/api/auth/logout");
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await call(c, "GET", "/api/session")).statusCode).toBe(401);
  });

  it("auditoria pela API: admin consulta, operador não", async () => {
    const root = await login("root@exemplo.test");
    const res = await call(root, "GET", "/api/audit?limit=5");
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(5);
    const op = await login("op@exemplo.test");
    expect((await call(op, "GET", "/api/audit")).statusCode).toBe(403);
  });
});

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("limite por IP no login", () => {
  it("responde 429 acima do limite", async () => {
    const t = await createTestDatabase();
    const app = buildApiServer(loadConfig({ LOG_LEVEL: "fatal", AUTH_RATE_LIMIT_PER_MINUTE: "2" }), {
      foundation: new FoundationService(t.db, { argon2: FAST_ARGON2 }),
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x@y.z", password: "p" } })).statusCode);
      }
      expect(codes).toEqual([401, 401, 429]);
    } finally {
      await app.close();
      await t.drop();
    }
  });
});
