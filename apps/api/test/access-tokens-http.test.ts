import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FoundationService } from "@painel/core";
import { createTestDatabase, FAST_ARGON2, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "@painel/core/testing";
import { loadConfig } from "../src/config.ts";
import { buildApiServer } from "../src/server.ts";

// Tokens pessoais de acesso e servidor MCP pela HTTP (ADR-017): o token tem as permissões do papel,
// fica preso à organização, não vale como cookie (nem o cookie como token) e morre com a revogação.

const PASSWORD = "senha-forte-de-teste-1";
const ORIGIN = "http://localhost:8080";

interface Client {
  cookie: string;
  csrf: string;
}

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("tokens de acesso e MCP", () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let svc: FoundationService;

  async function login(email: string): Promise<Client> {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD }, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(200);
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: res.json().csrfToken };
  }

  const call = (c: Client | undefined, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), headers: c ? { cookie: c.cookie, "x-csrf-token": c.csrf } : {} });

  const bearer = (token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });

  const mcp = (token: string, method: string, params?: object) =>
    bearer(token, "POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

  async function newToken(c: Client, name = "claude-code", days = 30): Promise<{ token: string; id: string }> {
    const res = await call(c, "POST", "/api/access-tokens", { name, days });
    expect(res.statusCode).toBe(201);
    return { token: res.json().token, id: res.json().accessToken.id };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    svc = new FoundationService(t.db, { argon2: FAST_ARGON2 });
    app = buildApiServer(loadConfig({ LOG_LEVEL: "fatal", AUTH_RATE_LIMIT_PER_MINUTE: "1000" }), { foundation: svc, checkDatabase: () => t.db.ping() });
    const boot = await svc.bootstrapInstance(
      { adminEmail: "root@exemplo.test", adminName: "Root", organizationName: "Acme", organizationSlug: "acme" },
      { correlationId: "t" },
    );
    expect((await call(undefined, "POST", "/api/auth/password-reset/complete", { token: boot.link.token, password: PASSWORD })).statusCode).toBe(204);
    // Uma pessoa com papel de leitura, para conferir que o token herda as limitações do papel.
    const root = await login("root@exemplo.test");
    const invite = await call(root, "POST", "/api/invites", { email: "leitura@exemplo.test", role: "reader" });
    const inviteToken = invite.json().url.split("#token=")[1];
    expect((await call(undefined, "POST", "/api/auth/invites/accept", { token: inviteToken, password: PASSWORD, displayName: "Leitora" })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it("cria o token uma vez, com prefixo, e lista sem o valor", async () => {
    const root = await login("root@exemplo.test");
    const { token, id } = await newToken(root);
    expect(token).toMatch(/^nexo_pat_[\w-]{43}$/);
    const list = await call(root, "GET", "/api/access-tokens");
    expect(list.json().items).toEqual([expect.objectContaining({ id, name: "claude-code", organizationName: "Acme" })]);
    expect(list.body).not.toContain(token);
  });

  it("valida nome e validade", async () => {
    const root = await login("root@exemplo.test");
    expect((await call(root, "POST", "/api/access-tokens", { name: "", days: 30 })).statusCode).toBe(400);
    expect((await call(root, "POST", "/api/access-tokens", { name: "x", days: 0 })).statusCode).toBe(400);
    expect((await call(root, "POST", "/api/access-tokens", { name: "x", days: 366 })).statusCode).toBe(400);
  });

  it("o token autentica pelo cabeçalho, sem CSRF, na organização em que nasceu", async () => {
    const root = await login("root@exemplo.test");
    const { token } = await newToken(root);
    const session = await bearer(token, "GET", "/api/session");
    expect(session.statusCode).toBe(200);
    expect(session.json().organization).toMatchObject({ slug: "acme", role: "admin" });
    expect((await bearer(token, "POST", "/api/workspaces", { name: "Via token" })).statusCode).toBe(201);
  });

  it("token inválido é 401, mesmo com cookie válido junto", async () => {
    const root = await login("root@exemplo.test");
    const res = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: root.cookie, authorization: "Bearer nexo_pat_invalido" } });
    expect(res.statusCode).toBe(401);
  });

  it("token não vale como cookie, e o cookie não vale como token", async () => {
    const root = await login("root@exemplo.test");
    const { token } = await newToken(root);
    const asCookie = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: `painel_session=${token}` } });
    expect(asCookie.statusCode).toBe(401);
    const cookieToken = root.cookie.split("=")[1]!;
    expect((await bearer(cookieToken, "GET", "/api/session")).statusCode).toBe(401);
  });

  it("o token não troca de organização nem cria outro token", async () => {
    const root = await login("root@exemplo.test");
    const other = await call(root, "POST", "/api/organizations", { name: "Globex", slug: "globex" });
    const { token } = await newToken(root);
    expect((await bearer(token, "POST", "/api/session/organization", { organizationId: other.json().id })).statusCode).toBe(403);
    expect((await bearer(token, "POST", "/api/access-tokens", { name: "filho", days: 1 })).statusCode).toBe(403);
  });

  it("revogado, deixa de valer na hora", async () => {
    const root = await login("root@exemplo.test");
    const { token, id } = await newToken(root);
    expect((await call(root, "DELETE", `/api/access-tokens/${id}`)).statusCode).toBe(204);
    expect((await bearer(token, "GET", "/api/session")).statusCode).toBe(401);
    expect((await call(root, "DELETE", `/api/access-tokens/${id}`)).statusCode).toBe(404);
  });

  it("revogar sessão não alcança token, e vice-versa", async () => {
    const root = await login("root@exemplo.test");
    const { id } = await newToken(root);
    expect((await call(root, "DELETE", `/api/sessions/${id}`)).statusCode).toBe(404);
    const sessions = (await call(root, "GET", "/api/sessions")).json().items as Array<{ id: string }>;
    expect(sessions.some((s) => s.id === id)).toBe(false);
  });

  it("MCP: initialize, lista de ferramentas e chamada que cria um workspace", async () => {
    const root = await login("root@exemplo.test");
    const { token } = await newToken(root);
    const init = await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "nexo" } });
    const notified = await bearer(token, "POST", "/api/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.statusCode).toBe(202);
    const tools = await mcp(token, "tools/list");
    expect(tools.json().result.tools.map((x: { name: string }) => x.name)).toContain("link_pipeline");
    const created = await mcp(token, "tools/call", { name: "create_workspace", arguments: { name: "Pelo MCP" } });
    expect(created.json().result).toMatchObject({ isError: false });
    const list = await bearer(token, "GET", "/api/workspaces");
    expect(list.json().items.map((w: { name: string }) => w.name)).toContain("Pelo MCP");
  });

  it("MCP herda o papel: leitura não cria workspace", async () => {
    const reader = await login("leitura@exemplo.test");
    const { token } = await newToken(reader);
    const res = await mcp(token, "tools/call", { name: "create_workspace", arguments: { name: "Proibido" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ isError: true });
    expect(res.json().result.content[0].text).toContain("forbidden");
  });

  it("MCP exige token: sem autenticação 401, com cookie 403, GET 405", async () => {
    const root = await login("root@exemplo.test");
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await app.inject({ method: "POST", url: "/api/mcp", payload: body })).statusCode).toBe(401);
    expect((await call(root, "POST", "/api/mcp", body)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/mcp" })).statusCode).toBe(405);
  });

  it("quem perde o acesso à organização perde os tokens dela", async () => {
    const root = await login("root@exemplo.test");
    const reader = await login("leitura@exemplo.test");
    const { token } = await newToken(reader, "vai-cair");
    expect((await bearer(token, "GET", "/api/session")).statusCode).toBe(200);
    const members = (await call(root, "GET", "/api/members")).json().items as Array<{ userId: string; displayName: string }>;
    const leitora = members.find((m) => m.displayName === "Leitora")!;
    expect((await call(root, "DELETE", `/api/members/${leitora.userId}`)).statusCode).toBe(204);
    expect((await bearer(token, "GET", "/api/session")).statusCode).toBe(401);
  });

  it("trocar a senha revoga os tokens", async () => {
    const root = await login("root@exemplo.test");
    const { token } = await newToken(root, "antes-da-senha");
    const changed = await call(root, "POST", "/api/auth/password", { currentPassword: PASSWORD, newPassword: `${PASSWORD}-nova` });
    expect(changed.statusCode).toBe(204);
    expect((await bearer(token, "GET", "/api/session")).statusCode).toBe(401);
  });
});
