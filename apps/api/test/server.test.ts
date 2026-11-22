import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { buildApiServer, buildReportOriginServer } from "../src/server.ts";

const config = loadConfig({ LOG_LEVEL: "fatal" });

describe("api", () => {
  it("responde /health/live e devolve o id de correlação", async () => {
    const app = buildApiServer(config);
    const res = await app.inject({ method: "GET", url: "/health/live", headers: { "x-correlation-id": "corr-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-correlation-id"]).toBe("corr-1");
  });

  it("/health/ready fica indisponível sem banco", async () => {
    const res = await buildApiServer(config).inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
  });

  it("/health/ready fica pronto quando o banco responde", async () => {
    const app = buildApiServer(config, { checkDatabase: async () => undefined });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });

  describe("corpo JSON", () => {
    const app = buildApiServer(config);
    app.delete("/t", async (_req, reply) => reply.code(204).send());
    app.post("/t", async (req) => ({ body: req.body ?? null }));
    const json = { "content-type": "application/json" };

    it("content-type JSON sem corpo vale como sem corpo (DELETE do painel)", async () => {
      expect((await app.inject({ method: "DELETE", url: "/t", headers: json })).statusCode).toBe(204);
      expect((await app.inject({ method: "POST", url: "/t", headers: json, payload: "" })).json()).toEqual({ body: null });
    });

    it("JSON malformado continua 400", async () => {
      expect((await app.inject({ method: "POST", url: "/t", headers: json, payload: "{nao" })).statusCode).toBe(400);
    });

    it("mantém a proteção contra __proto__ do parser padrão", async () => {
      const res = await app.inject({ method: "POST", url: "/t", headers: json, payload: '{"__proto__":{"admin":true}}' });
      expect(res.statusCode).toBe(400);
    });

    it("JSON válido chega inteiro", async () => {
      expect((await app.inject({ method: "POST", url: "/t", headers: json, payload: '{"a":1}' })).json()).toEqual({ body: { a: 1 } });
    });
  });
});

describe("report-origin (ADR-007, CA-012)", () => {
  it("envia CSP sandbox e restringe quem pode embutir", async () => {
    const res = await buildReportOriginServer(config).inject({ method: "GET", url: "/r/qualquer" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors http://localhost:8080");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("recusa configuração com a mesma origem do painel", () => {
    expect(() =>
      loadConfig({ PUBLIC_BASE_URL: "http://localhost:8080", REPORT_ORIGIN_URL: "http://localhost:8080" }),
    ).toThrow(/origem diferente/);
  });
});
