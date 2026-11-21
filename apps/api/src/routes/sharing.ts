import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, type EmailService, type SharingService } from "@painel/core";
import type { Config } from "../config.ts";
import { FixedWindowLimiter } from "../http/rate-limit.ts";
import { actorOf, IdParams, parse, requestMeta as meta } from "./foundation.ts";

// Incremento 7: links compartilhados, configurações da organização e e-mail.
// O link leva o token no fragmento (#): a página pública lê o token e chama /api/public/share,
// que não cria sessão e recebe o token no cabeçalho x-share-token (fica fora de logs de URL).

const ShareBody = z.object({
  scope: z.enum(["execution", "pipeline"]),
  pipelineId: z.uuid().optional(),
  executionId: z.uuid().optional(),
  access: z.enum(["public", "members"]),
  title: z.string().max(200).optional(),
  days: z.number().int().min(1).max(365).optional(),
  options: z
    .object({
      parameters: z.boolean().optional(),
      errorDetails: z.boolean().optional(),
      branch: z.boolean().optional(),
      systemVersion: z.boolean().optional(),
      periodDays: z.number().int().min(1).max(90).optional(),
    })
    .optional(),
});
const ShareList = z.object({ pipelineId: z.uuid().optional(), executionId: z.uuid().optional() });
const Settings = z.object({
  sharing: z.object({ allowPublic: z.boolean(), defaultDays: z.number().int(), maxDays: z.number().int() }),
  retention: z.object({ artifactsDays: z.number().int(), resultsDays: z.number().int(), emailsDays: z.number().int() }),
});

export function registerSharingRoutes(app: FastifyInstance, config: Config, svc: SharingService, email: EmailService): void {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const limiter = new FixedWindowLimiter(config.SHARE_RATE_LIMIT_PER_MINUTE);
  const limited = async (req: FastifyRequest) => {
    if (!limiter.take(`share:${req.ip}`)) throw new DomainError("rate-limited", "Muitos acessos seguidos. Aguarde um minuto.");
  };

  app.post("/api/share-links", async (req, reply) => {
    const created = await svc.createLink(actorOf(req), parse(ShareBody, req.body), meta(req));
    // A URL só aparece agora: o servidor guarda apenas o hash do token.
    return reply.code(201).send({ link: created.link, url: `${base}/compartilhado#${created.token}` });
  });
  app.post("/api/share-links/preview", async (req) => svc.previewLink(actorOf(req), parse(ShareBody, req.body)));
  app.get("/api/share-links", async (req) => {
    const q = parse(ShareList, req.query);
    return { items: await svc.listLinks(actorOf(req), { ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}), ...(q.executionId ? { executionId: q.executionId } : {}) }) };
  });
  app.post("/api/share-links/:id/revoke", async (req) => svc.revokeLink(actorOf(req), parse(IdParams, req.params).id, meta(req)));

  // Visitante: sem sessão para links públicos; com sessão de membro para links "só membros".
  // GET (só leitura, sem CSRF) com o token num cabeçalho, nunca no endereço: logs de proxy guardam URLs.
  app.get("/api/public/share", { preHandler: limited }, async (req) => {
    const token = req.headers["x-share-token"];
    return svc.view(typeof token === "string" ? token : "", req.actor);
  });

  app.get("/api/organization/settings", async (req) => svc.getSettings(actorOf(req)));
  app.put("/api/organization/settings", async (req) => svc.updateSettings(actorOf(req), parse(Settings, req.body), meta(req)));

  app.get("/api/email/status", async (req) => {
    actorOf(req);
    return { enabled: email.enabled };
  });
  app.get("/api/email/history", async (req) => ({
    items: await email.history(actorOf(req), parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }), req.query).limit),
  }));
  app.post("/api/email/test", async (req, reply) => {
    await email.sendTest(actorOf(req), meta(req));
    return reply.code(202).send({ queued: true });
  });
}
