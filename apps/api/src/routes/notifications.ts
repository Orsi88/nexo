import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotificationService } from "@painel/core";
import { actorOf, IdParams, parse, requestMeta as meta } from "./foundation.ts";

// Regras de evento e avisos. A validação de conteúdo é do serviço (parseRuleFields); aqui só o
// formato e os limites de tamanho.

const Scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
const RuleBody = z.object({
  name: z.string().max(120),
  enabled: z.boolean().optional(),
  pipelineId: z.uuid().nullable().optional(),
  onStatus: z.array(z.string().max(20)).max(10),
  conditions: z.array(z.object({ parameter: z.string().max(64), in: z.array(Scalar).max(20) })).max(10).optional(),
  severity: z.string().max(20).optional(),
  title: z.string().max(120),
  message: z.string().max(1000),
  channels: z.array(z.string().max(20)).max(5).optional(),
  recipients: z.array(z.string().max(254)).max(20).optional(),
});
const RuleList = z.object({ pipelineId: z.uuid().optional(), includeArchived: z.enum(["true", "false"]).optional() });
const AlertList = z.object({
  open: z.enum(["true", "false"]).optional(),
  pipelineId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const ResolveBody = z.object({ note: z.string().max(500).optional() });

export function registerNotificationRoutes(app: FastifyInstance, svc: NotificationService): void {
  app.get("/api/notification-rules", async (req) => {
    const q = parse(RuleList, req.query);
    return { items: await svc.listRules(actorOf(req), { ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}), includeArchived: q.includeArchived === "true" }) };
  });
  app.post("/api/notification-rules", async (req, reply) =>
    reply.code(201).send(await svc.createRule(actorOf(req), parse(RuleBody, req.body), meta(req))),
  );
  app.put("/api/notification-rules/:id", async (req) =>
    svc.updateRule(actorOf(req), parse(IdParams, req.params).id, parse(RuleBody, req.body), meta(req)),
  );
  app.post("/api/notification-rules/:id/archive", async (req) => svc.setRuleArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)));
  app.post("/api/notification-rules/:id/unarchive", async (req) =>
    svc.setRuleArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  app.get("/api/alerts", async (req) => {
    const q = parse(AlertList, req.query);
    return {
      items: await svc.listAlerts(actorOf(req), {
        open: q.open === "true",
        ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      }),
    };
  });
  app.post("/api/alerts/:id/resolve", async (req) =>
    svc.resolveAlert(actorOf(req), parse(IdParams, req.params).id, parse(ResolveBody, req.body ?? {}), meta(req)),
  );
}
