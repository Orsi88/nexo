import type { FastifyInstance, FastifyReply } from "fastify";
import { DomainError } from "@painel/core";
import { handleMcpMessage } from "../mcp/protocol.ts";
import { actorOf } from "./foundation.ts";

// Servidor MCP do Nexo (ADR-017) em POST /api/mcp, atrás do mesmo proxy do painel. Autenticação só por
// token pessoal de acesso (Authorization: Bearer nexo_pat_...), resolvido no hook da fundação. Cada
// ferramenta chama a rota REST correspondente por injeção interna, com o mesmo token: permissão,
// validação e auditoria são exatamente as do painel.

const SERVER_VERSION = "0.1.0";

export function registerMcpRoutes(app: FastifyInstance): void {
  // O YAML de apply_pipeline_file pode passar dos 64 KB padrão do corpo, como na rota de arquivo.
  app.post("/api/mcp", { bodyLimit: 600 * 1024 }, async (req, reply) => {
    const actor = actorOf(req);
    if (actor.session.kind !== "access-token") {
      throw new DomainError("forbidden", "O MCP aceita só token pessoal de acesso. Crie um em Minha conta.");
    }
    const authorization = req.headers.authorization!;
    const response = await handleMcpMessage(req.body, {
      serverVersion: SERVER_VERSION,
      callApi: async (request) => {
        const res = await app.inject({
          method: request.method,
          url: request.url,
          headers: {
            authorization,
            "x-correlation-id": String(req.id),
            ...(typeof req.headers["user-agent"] === "string" ? { "user-agent": req.headers["user-agent"] } : {}),
            ...(request.payload !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(request.payload !== undefined ? { payload: JSON.stringify(request.payload) } : {}),
        });
        return { status: res.statusCode, contentType: String(res.headers["content-type"] ?? ""), body: res.body };
      },
    });
    if (response === null) return reply.code(202).send();
    return reply.header("content-type", "application/json").send(response);
  });

  // Sem stream do servidor (não há notificações a empurrar) e sem sessão MCP a encerrar.
  const notAllowed = async (_req: unknown, reply: FastifyReply) => reply.code(405).header("allow", "POST").send();
  app.get("/api/mcp", notAllowed);
  app.delete("/api/mcp", notAllowed);
}
