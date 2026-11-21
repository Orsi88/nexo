import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssistService } from "@painel/core";
import { actorOf, IdParams, parse, requestMeta as meta } from "./foundation.ts";

// Incremento 8: provedores de IA, servidores MCP e sessões assistidas. Chaves e credenciais entram
// por aqui e vão direto para o cofre; nenhuma resposta devolve esses valores.

const ProviderBody = z.object({
  name: z.string().max(80),
  kind: z.enum(["anthropic", "openai-compatible"]),
  endpoint: z.string().max(500).optional(),
  model: z.string().max(120),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  apiKey: z.string().max(500).optional(),
});
const McpBody = z.object({
  name: z.string().max(80),
  url: z.string().max(500),
  authHeader: z.string().max(60).optional(),
  authValue: z.string().max(2000).optional(),
});
const PolicyBody = z.object({ tools: z.array(z.object({ name: z.string().max(64), kind: z.enum(["read", "mutate"]), authorized: z.boolean() })).max(200) });
const SessionBody = z.object({
  projectId: z.uuid(),
  integrationId: z.uuid(),
  externalId: z.string().max(200),
  ref: z.string().max(200).optional(),
  providerId: z.uuid(),
  mcpTools: z.array(z.string().max(140)).max(50).optional(),
  acknowledged: z.boolean(),
});
const ApplyBody = z.object({ manifest: z.unknown().optional(), note: z.string().max(500).optional() });

export function registerAssistRoutes(app: FastifyInstance, svc: AssistService): void {
  app.get("/api/ai-providers", async (req) => ({ items: await svc.listProviders(actorOf(req)) }));
  app.post("/api/ai-providers", async (req, reply) => reply.code(201).send(await svc.createProvider(actorOf(req), parse(ProviderBody, req.body), meta(req))));
  app.post("/api/ai-providers/:id/test", async (req) => svc.testProvider(actorOf(req), parse(IdParams, req.params).id, meta(req)));
  app.post("/api/ai-providers/:id/archive", async (req) => svc.archiveProvider(actorOf(req), parse(IdParams, req.params).id, meta(req)));

  app.get("/api/mcp-servers", async (req) => ({ items: await svc.listMcpServers(actorOf(req)) }));
  app.post("/api/mcp-servers", async (req, reply) => reply.code(201).send(await svc.createMcpServer(actorOf(req), parse(McpBody, req.body), meta(req))));
  app.post("/api/mcp-servers/:id/refresh", async (req) => svc.refreshMcpServer(actorOf(req), parse(IdParams, req.params).id, meta(req)));
  app.put("/api/mcp-servers/:id/tools", async (req) => svc.setMcpToolPolicy(actorOf(req), parse(IdParams, req.params).id, parse(PolicyBody, req.body), meta(req)));
  app.post("/api/mcp-servers/:id/archive", async (req) => svc.archiveMcpServer(actorOf(req), parse(IdParams, req.params).id, meta(req)));

  app.get("/api/assist-sessions", async (req) => ({ items: await svc.listSessions(actorOf(req)) }));
  app.post("/api/assist-sessions", async (req, reply) => reply.code(202).send(await svc.startSession(actorOf(req), parse(SessionBody, req.body), meta(req))));
  app.get("/api/assist-sessions/:id", async (req) => svc.getSession(actorOf(req), parse(IdParams, req.params).id));
  app.post("/api/assist-sessions/:id/apply", async (req) => svc.applySession(actorOf(req), parse(IdParams, req.params).id, parse(ApplyBody, req.body ?? {}), meta(req)));
  app.post("/api/assist-sessions/:id/discard", async (req, reply) => {
    await svc.discardSession(actorOf(req), parse(IdParams, req.params).id, meta(req));
    return reply.code(204).send();
  });
}
