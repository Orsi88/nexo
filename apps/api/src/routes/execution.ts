import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EXECUTION_STATUSES } from "@painel/contracts";
import { DomainError, type ExecutionService } from "@painel/core";
import type { EventHub } from "../events.ts";
import { actorOf, IdParams, parse, requestMeta as meta } from "./foundation.ts";

// Rotas do incremento 3: recursos, perfis, pedido de execução (com prévia), fila, cancelamento,
// reexecução, histórico, logs e eventos em tempo real (SSE). Sessão, CSRF e tradução de erros vêm
// do registro da fundação.

const Archived = z.object({ includeArchived: z.enum(["true", "false"]).optional() });
const ResourceCreate = z.object({
  ref: z.string().max(100),
  name: z.string().max(120),
  description: z.string().max(500).optional(),
  busyPolicy: z.enum(["queue", "reject"]).optional(),
  leaseTtlSeconds: z.number().int().optional(),
});
const ResourceUpdate = ResourceCreate.omit({ ref: true }).partial().extend({ description: z.string().max(500).nullable().optional() });
const Scalar = z.union([z.string().max(2000), z.number(), z.boolean()]);
const ProfileBody = z.object({
  name: z.string().max(120),
  description: z.string().max(500).optional(),
  ref: z.string().max(200).optional(),
  parameters: z.record(z.string().max(64), Scalar).optional(),
});
const ExecutionBody = z.object({
  pipelineId: z.uuid(),
  profileId: z.uuid().optional(),
  ref: z.string().max(200).optional(),
  parameters: z.record(z.string().max(64), Scalar).optional(),
  idempotencyKey: z.string().max(100).optional(),
  allowDuplicate: z.boolean().optional(),
});
const RerunBody = z.object({ idempotencyKey: z.string().max(100).optional() });
const ExecutionList = z.object({
  pipelineId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .refine((v) => !v || v.every((s) => (EXECUTION_STATUSES as readonly string[]).includes(s)), "estado desconhecido"),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function registerExecutionRoutes(app: FastifyInstance, svc: ExecutionService, events?: EventHub): void {
  // ===== Recursos executores =====
  app.get("/api/resources", async (req) => {
    const q = parse(Archived, req.query);
    return { items: await svc.listResources(actorOf(req), q.includeArchived === "true") };
  });
  app.post("/api/resources", async (req, reply) =>
    reply.code(201).send(await svc.createResource(actorOf(req), parse(ResourceCreate, req.body), meta(req))),
  );
  app.patch("/api/resources/:id", async (req) =>
    svc.updateResource(actorOf(req), parse(IdParams, req.params).id, parse(ResourceUpdate, req.body), meta(req)),
  );
  app.post("/api/resources/:id/archive", async (req) => svc.setResourceArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)));
  app.post("/api/resources/:id/unarchive", async (req) =>
    svc.setResourceArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  // ===== Perfis de execução =====
  app.get("/api/pipelines/:id/profiles", async (req) => {
    const q = parse(Archived, req.query);
    return { items: await svc.listProfiles(actorOf(req), parse(IdParams, req.params).id, q.includeArchived === "true") };
  });
  app.post("/api/pipelines/:id/profiles", async (req, reply) =>
    reply.code(201).send(await svc.createProfile(actorOf(req), parse(IdParams, req.params).id, parse(ProfileBody, req.body), meta(req))),
  );
  app.put("/api/profiles/:id", async (req) =>
    svc.updateProfile(actorOf(req), parse(IdParams, req.params).id, parse(ProfileBody, req.body), meta(req)),
  );
  app.post("/api/profiles/:id/archive", async (req) => svc.setProfileArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)));
  app.post("/api/profiles/:id/unarchive", async (req) =>
    svc.setProfileArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  // ===== Execuções =====
  // Prévia para a confirmação (RF-044): o que aconteceria agora, sem gravar.
  app.post("/api/executions/preview", async (req) => svc.previewExecution(actorOf(req), parse(ExecutionBody, req.body), meta(req)));
  // Branches e tags do repositório da pipeline, para escolher a versão a executar.
  app.get("/api/pipelines/:id/refs", async (req) => {
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    return { items: await svc.listRefs(actorOf(req), parse(IdParams, req.params).id, q.q ? { search: q.q } : {}, meta(req)) };
  });
  app.post("/api/executions", async (req, reply) => {
    const result = await svc.requestExecution(actorOf(req), parse(ExecutionBody, req.body), meta(req));
    return reply.code(result.replayed ? 200 : 202).send(result);
  });
  app.get("/api/executions", async (req) => {
    const q = parse(ExecutionList, req.query);
    return {
      items: await svc.listExecutions(actorOf(req), {
        ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { before: q.before } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      }),
    };
  });
  app.get("/api/executions/:id", async (req) => svc.getExecution(actorOf(req), parse(IdParams, req.params).id));
  app.post("/api/executions/:id/cancel", async (req) => svc.cancelExecution(actorOf(req), parse(IdParams, req.params).id, meta(req)));
  app.post("/api/executions/:id/rerun", async (req, reply) => {
    const result = await svc.rerunExecution(actorOf(req), parse(IdParams, req.params).id, parse(RerunBody, req.body ?? {}), meta(req));
    return reply.code(result.replayed ? 200 : 202).send(result);
  });

  // Logs lidos do provedor na hora, em texto (RF-058). Cada trecho começa com o estágio, se houver.
  app.get("/api/executions/:id/logs", async (req, reply) => {
    const chunks = await svc.executionLogs(actorOf(req), parse(IdParams, req.params).id, meta(req));
    const iterator = chunks[Symbol.asyncIterator]();
    // A primeira leitura acontece antes de responder: erro do provedor vira resposta de erro normal.
    const first = await iterator.next();
    reply.header("content-type", "text/plain; charset=utf-8");
    async function* body() {
      for (let r = first; !r.done; r = await iterator.next()) {
        yield `${r.value.stage ? `===== ${r.value.stage} =====\n` : ""}${r.value.text}${r.value.text.endsWith("\n") ? "" : "\n"}`;
      }
    }
    return reply.send(Readable.from(body()));
  });

  // ===== Tempo real (ADR-010, RF-075) =====
  app.get("/api/events", async (req, reply) => {
    const actor = actorOf(req);
    const org = actor.organization;
    if (!org) throw new DomainError("conflict", "Escolha uma organização para continuar.");
    if (!events) throw new DomainError("conflict", "Atualização em tempo real indisponível nesta instalação.");
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-correlation-id": req.id,
    });
    res.write("retry: 5000\n\n");
    const unsubscribe = events.subscribe(org.id, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify({ executionId: event.executionId, pipelineId: event.pipelineId, status: event.status })}\n\n`);
    });
    // Comentário periódico: mantém a conexão viva através de proxies.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    // A sessão tem validade: a conexão não sobrevive a ela (a reconexão passa pela autenticação de novo).
    const expires = setTimeout(() => res.end(), Math.max(0, new Date(actor.session.expiresAt).getTime() - Date.now()));
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(expires);
      unsubscribe();
    });
  });
}
