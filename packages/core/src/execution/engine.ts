import { randomUUID } from "node:crypto";
import { coerceParameterValues, extractSystemVersion, type ExecutionStatus, type PipelineManifest } from "@painel/contracts";
import { NotSupportedError, ProviderError, type ExternalRunState } from "@painel/connector-sdk";
import { isUniqueViolation, type Database, type Sql } from "../db/database.ts";
import { DomainError } from "../shared/errors.ts";
import { publishEvent } from "../shared/events.ts";
import type { Job, JobHandler } from "../shared/job-queue.ts";
import { enqueueJob } from "../shared/pg-job-queue.ts";
import { recordAudit, type AuditEventInput } from "../modules/audit/index.ts";
import { executions, isFinal, type Execution, type ExecutionPatch } from "../modules/execution/index.ts";
import { pipelines, profiles, type LinkedPipeline } from "../modules/pipelines/index.ts";
import { resources } from "../modules/resources/index.ts";
import { ProviderAccess } from "./provider.ts";
import { exclusiveRefs, fromProvider, minutes } from "./rules.ts";
import { JOBS } from "./jobs.ts";

// Lado do worker do incremento 3 (FLX-002, FLX-005; ADR-004, ADR-009). Cada handler roda num job
// da fila, com o contexto da organização do job: o RLS continua valendo. Nada aqui tem usuário:
// as ações ficam na auditoria como "system".

export interface ExecutionEngineOptions {
  /** Intervalo do acompanhamento sem webhook (RNF-003 depende dele). */
  pollSeconds?: number;
  /** Execução sem notícia do provedor por mais que isto vira "stale" (RF-060). */
  staleAfterSeconds?: number;
  /** Na primeira leitura de uma pipeline, até quanto tempo atrás procurar execuções externas. */
  externalLookbackHours?: number;
  /** Intervalo mínimo entre duas leituras de execuções do provedor na mesma pipeline. */
  syncRunsEverySeconds?: number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

interface ExecutionPayload {
  executionId: string;
}
interface PipelinePayload {
  pipelineId: string;
}

/** Margem ao reler execuções do provedor: pega o que mudou perto do corte anterior. */
const SYNC_OVERLAP_MS = 5 * 60_000;

export class ExecutionEngine {
  readonly #db: Database;
  readonly #provider: ProviderAccess;
  readonly #poll: number;
  readonly #staleAfter: number;
  readonly #lookbackMs: number;
  readonly #syncEvery: number;
  readonly #log: NonNullable<ExecutionEngineOptions["log"]>;

  constructor(db: Database, provider: ProviderAccess, options: ExecutionEngineOptions = {}) {
    this.#db = db;
    this.#provider = provider;
    this.#poll = options.pollSeconds ?? 15;
    this.#staleAfter = options.staleAfterSeconds ?? 600;
    this.#lookbackMs = (options.externalLookbackHours ?? 24) * 3600_000;
    this.#syncEvery = options.syncRunsEverySeconds ?? 120;
    this.#log = options.log ?? (() => undefined);
  }

  /** Handlers por nome de job, para registrar na fila. */
  handlers(): Record<string, JobHandler<never>> {
    return {
      [JOBS.dispatch]: (job: Job<ExecutionPayload>) => this.dispatch(this.#org(job), job.payload.executionId),
      [JOBS.track]: (job: Job<ExecutionPayload>) => this.track(this.#org(job), job.payload.executionId),
      [JOBS.cancel]: (job: Job<ExecutionPayload>) => this.cancel(this.#org(job), job.payload.executionId),
      [JOBS.syncRuns]: (job: Job<PipelinePayload>) => this.syncRuns(this.#org(job), job.payload.pipelineId),
      [JOBS.tick]: () => this.tick(),
    } as Record<string, JobHandler<never>>;
  }

  // =====================================================================
  // Disparo (FLX-005: reservar → acionar provedor)
  // =====================================================================

  async dispatch(organizationId: string, executionId: string): Promise<void> {
    const correlationId = `dispatch:${executionId}`;
    const reserved = await this.#tx(organizationId, async (sql) => {
      const e = await executions.getExecutionForUpdate(sql, organizationId, executionId);
      if (!e || e.status !== "queued") return undefined;

      // FIFO entre quem disputa os mesmos recursos: alguém anterior esperando passa na frente.
      const queue = await executions.queued(sql, organizationId);
      const ahead = queue.slice(0, queue.findIndex((q) => q.id === e.id));
      if (ahead.some((q) => q.resourceIds.some((r) => e.resourceIds.includes(r)))) return undefined;

      const locked = await resources.lockResources(sql, organizationId, e.resourceIds);
      const gone = e.resourceIds.filter((id) => !locked.some((r) => r.id === id && !r.archivedAt));
      if (gone.length) {
        const next = await executions.transition(sql, e, "rejected", {
          statusReason: "Um recurso exigido foi arquivado enquanto a execução esperava na fila.",
          finishedAt: new Date(),
        });
        await this.#changed(sql, next);
        await this.#wakeQueue(sql, organizationId);
        return undefined;
      }
      if ((await resources.openLeases(sql, organizationId, e.resourceIds)).length) return undefined;
      if (locked.length && !(await resources.acquireLeases(sql, { organizationId, resources: locked, executionId, holderKind: "internal" }))) {
        return undefined;
      }
      const next = await executions.transition(sql, e, "dispatching", { statusReason: null, dispatchedAt: new Date() });
      await this.#changed(sql, next);
      return { e: next, pipeline: (await pipelines.getPipeline(sql, organizationId, e.pipelineId))! };
    });
    if (!reserved) return;
    const { e, pipeline } = reserved;

    let runId: string;
    try {
      const { connector, conn } = await this.#provider.open(organizationId, pipeline.integrationId, correlationId);
      const run = await connector.triggerRun(
        conn,
        { externalPipelineId: pipeline.externalId, ...(e.ref ? { ref: e.ref } : {}), parameters: e.parameters },
        e.id,
      );
      runId = run.externalRunId;
    } catch (error) {
      await this.#dispatchFailed(organizationId, e, error, correlationId);
      return;
    }

    await this.#tx(organizationId, async (sql) => {
      const current = await executions.getExecutionForUpdate(sql, organizationId, e.id);
      if (!current) return;
      await sql.query("SAVEPOINT set_run");
      try {
        const cancelPending = current.status === "cancelling";
        const next = await executions.transition(sql, current, cancelPending ? "cancelling" : "running", {
          externalRunId: runId,
          statusReason: cancelPending ? "Cancelamento pedido ao provedor." : null,
          synced: true,
        });
        await sql.query("RELEASE SAVEPOINT set_run");
        await this.#changed(sql, next);
        await this.#auditSystem(sql, organizationId, correlationId, "execution.dispatch", e.id, "success", { externalRunId: runId });
        if (cancelPending) await enqueueJob(sql, JOBS.cancel, { executionId: e.id }, { organizationId, idempotencyKey: `cancel:${e.id}` });
        await this.#scheduleTrack(sql, organizationId, e.id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A leitura de execuções externas registrou o mesmo run antes de nós: fica a dela.
        await sql.query("ROLLBACK TO SAVEPOINT set_run");
        const next = await executions.transition(sql, current, "unknown", {
          statusReason: `O provedor criou a execução ${runId}, que já tinha sido registrada como externa. Acompanhe por ela.`,
          finishedAt: new Date(),
        });
        await resources.releaseLeases(sql, organizationId, e.id, "duplicada");
        await this.#changed(sql, next);
        await this.#wakeQueue(sql, organizationId);
      }
    });
  }

  /**
   * Falha ao acionar o provedor. Recusa clara (credencial, permissão, pipeline sumiu, parâmetro):
   * falha de infraestrutura, nunca de teste (RN-011). Limite de requisições: volta para a fila.
   * Qualquer outra coisa: não dá para saber se o provedor aceitou — fica "unknown" e a leitura de
   * execuções externas acha o run, se ele existir.
   */
  async #dispatchFailed(organizationId: string, e: Execution, error: unknown, correlationId: string): Promise<void> {
    const kind = error instanceof ProviderError ? error.kind : undefined;
    const message = describe(error);
    await this.#tx(organizationId, async (sql) => {
      const current = await executions.getExecutionForUpdate(sql, organizationId, e.id);
      if (!current || isFinal(current.status)) return;
      let next: Execution;
      if (kind === "rate-limited") {
        next = await executions.transition(sql, current, "queued", { statusReason: "O provedor limitou as requisições; nova tentativa em instantes." });
        await resources.releaseLeases(sql, organizationId, e.id, "provedor limitou requisições");
        const retry = new Date(Date.now() + ((error as ProviderError).retryAfterSeconds ?? 30) * 1000);
        await enqueueJob(sql, JOBS.dispatch, { executionId: e.id }, { organizationId, idempotencyKey: `dispatch:${e.id}`, startAfter: retry });
      } else if (kind && kind !== "unavailable") {
        next = await executions.transition(sql, current, "failed", {
          statusReason: `O provedor recusou o disparo: ${message}`,
          failureKind: "infrastructure",
          finishedAt: new Date(),
        });
        await resources.releaseLeases(sql, organizationId, e.id, "disparo recusado");
      } else {
        next = await executions.transition(sql, current, "unknown", {
          statusReason: `Não foi possível confirmar o disparo no provedor (${message}). Confira no provedor.`,
          finishedAt: new Date(),
        });
        await resources.releaseLeases(sql, organizationId, e.id, "disparo sem confirmação");
      }
      await this.#auditSystem(sql, organizationId, correlationId, "execution.dispatch", e.id, "failed", { reason: message, kind: kind ?? "error" });
      await this.#changed(sql, next);
      await this.#wakeQueue(sql, organizationId);
    });
  }

  // =====================================================================
  // Acompanhamento e reconciliação (RF-045, RF-060, RN-025)
  // =====================================================================

  async track(organizationId: string, executionId: string): Promise<void | { again: Date }> {
    const again = { again: new Date(Date.now() + this.#poll * 1000) };
    const loaded = await this.#tx(organizationId, async (sql) => {
      const e = await executions.getExecution(sql, organizationId, executionId);
      return e && { e, pipeline: (await pipelines.getPipeline(sql, organizationId, e.pipelineId))! };
    });
    if (!loaded || isFinal(loaded.e.status) || loaded.e.status === "queued") return;
    const { e, pipeline } = loaded;

    if (!e.externalRunId) {
      // Disparo sem confirmação há tempo demais: o worker caiu entre reservar e acionar.
      const since = (e.dispatchedAt ?? e.requestedAt).getTime();
      if (Date.now() - since < this.#staleAfter * 1000) return again;
      await this.#finishWithout(organizationId, executionId, "O disparo não foi confirmado pelo provedor. Confira no provedor.");
      return;
    }

    let state: ExternalRunState;
    try {
      const { connector, conn } = await this.#provider.open(organizationId, pipeline.integrationId, `track:${executionId}`);
      state = await connector.getRun(conn, { externalPipelineId: pipeline.externalId, externalRunId: e.externalRunId });
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "not-found") {
        await this.#finishWithout(organizationId, executionId, "O provedor não encontra mais esta execução.");
        return;
      }
      // Provedor fora: sem notícia por tempo demais vira "stale", e o recurso continua preso até
      // o provedor responder (RF-060: consultar antes de liberar).
      await this.#tx(organizationId, async (sql) => {
        const current = await executions.getExecutionForUpdate(sql, organizationId, executionId);
        if (!current || isFinal(current.status) || current.status === "stale") return;
        const last = (current.lastSyncedAt ?? current.dispatchedAt ?? current.requestedAt).getTime();
        if (Date.now() - last > this.#staleAfter * 1000) {
          const next = await executions.transition(sql, current, "stale", {
            statusReason: `Sem notícia do provedor há mais de ${minutes(this.#staleAfter)} (${describe(error)}).`,
          });
          await this.#changed(sql, next);
        }
      });
      this.#log("warn", "falha ao consultar execução no provedor", { executionId, error: describe(error) });
      return { again: new Date(Date.now() + this.#poll * 2000) };
    }

    const final = await this.#tx(organizationId, (sql) => this.#apply(sql, organizationId, executionId, state));
    return final ? undefined : again;
  }

  /** Aplica o estado lido do provedor. Devolve true quando a execução terminou. */
  async #apply(sql: Sql, organizationId: string, executionId: string, state: ExternalRunState): Promise<boolean> {
    const current = await executions.getExecutionForUpdate(sql, organizationId, executionId);
    if (!current || isFinal(current.status)) return true;
    const mapped = fromProvider(state.status, current.status === "stale" ? "running" : current.status);
    const patch: ExecutionPatch = { externalStatus: state.externalStatus.slice(0, 100), synced: true };
    if (state.startedAt) patch.startedAt = new Date(state.startedAt);
    if (state.finishedAt) patch.finishedAt = new Date(state.finishedAt);
    if (state.sourceRevision) patch.sourceRevision = state.sourceRevision.slice(0, 200);
    if (state.agentOrPool) patch.agentOrPool = state.agentOrPool.slice(0, 200);
    if (state.runNumber) patch.runNumber = state.runNumber;
    if (state.tags) patch.runTags = state.tags;
    // A versão é lida com o manifesto da época da execução (RN-010), a cada consulta: a pipeline
    // costuma marcar o pacote depois de começar.
    const manifest = await this.#manifestOf(sql, current);
    const version = extractSystemVersion(manifest?.systemUnderTest, {
      runNumber: state.runNumber ?? current.runNumber,
      tags: state.tags ?? current.runTags,
      parameters: current.parameters,
    });
    if (version) patch.systemVersion = version;
    if (mapped?.failureKind) patch.failureKind = mapped.failureKind;
    const target: ExecutionStatus = mapped?.status ?? current.status;
    if (current.status === "stale" && target !== "stale") patch.statusReason = "O provedor voltou a responder.";
    if (isFinal(target)) patch.finishedAt ??= new Date();

    const next = await executions.transition(sql, current, target, patch);
    if (isFinal(target)) {
      await resources.releaseLeases(sql, organizationId, executionId, `execução terminou: ${target}`);
      await this.#auditSystem(sql, organizationId, `track:${executionId}`, "execution.finish", executionId, "success", {
        status: target,
        externalStatus: state.externalStatus.slice(0, 100),
      });
      await this.#wakeQueue(sql, organizationId);
    } else {
      await resources.renewLeases(sql, organizationId, executionId);
    }
    if (next.status !== current.status || isFinal(target)) await this.#changed(sql, next);
    return isFinal(target);
  }

  async #finishWithout(organizationId: string, executionId: string, reason: string): Promise<void> {
    await this.#tx(organizationId, async (sql) => {
      const current = await executions.getExecutionForUpdate(sql, organizationId, executionId);
      if (!current || isFinal(current.status)) return;
      const next = await executions.transition(sql, current, "unknown", { statusReason: reason, finishedAt: new Date() });
      await resources.releaseLeases(sql, organizationId, executionId, "estado desconhecido no provedor");
      await this.#auditSystem(sql, organizationId, `track:${executionId}`, "execution.finish", executionId, "failed", { reason });
      await this.#changed(sql, next);
      await this.#wakeQueue(sql, organizationId);
    });
  }

  // =====================================================================
  // Cancelamento no provedor (CA-008, CA-042)
  // =====================================================================

  async cancel(organizationId: string, executionId: string): Promise<void> {
    const correlationId = `cancel:${executionId}`;
    const loaded = await this.#tx(organizationId, async (sql) => {
      const e = await executions.getExecution(sql, organizationId, executionId);
      return e && { e, pipeline: (await pipelines.getPipeline(sql, organizationId, e.pipelineId))! };
    });
    if (!loaded || loaded.e.status !== "cancelling") return;
    const { e, pipeline } = loaded;
    // Ainda sem run no provedor: o disparo vê o pedido e cancela assim que o run existir.
    if (!e.externalRunId) return;

    try {
      const { connector, conn } = await this.#provider.open(organizationId, pipeline.integrationId, correlationId);
      if (!connector.cancelRun) throw new NotSupportedError("cancelRun", "o conector não cancela");
      await connector.cancelRun(conn, { externalPipelineId: pipeline.externalId, externalRunId: e.externalRunId });
    } catch (error) {
      const transient = error instanceof ProviderError && (error.kind === "unavailable" || error.kind === "rate-limited");
      if (transient) throw error; // a fila tenta de novo com espera crescente
      await this.#tx(organizationId, async (sql) => {
        const current = await executions.getExecutionForUpdate(sql, organizationId, executionId);
        if (!current || current.status !== "cancelling") return;
        const next = await executions.transition(sql, current, "running", { statusReason: `O provedor recusou o cancelamento: ${describe(error)}` });
        await this.#auditSystem(sql, organizationId, correlationId, "execution.cancel.provider", executionId, "failed", { reason: describe(error) });
        await this.#changed(sql, next);
      });
      return;
    }
    await this.#tx(organizationId, async (sql) => {
      await this.#auditSystem(sql, organizationId, correlationId, "execution.cancel.provider", executionId, "success");
      // O estado final vem do provedor (reconciliação), não do pedido.
      await enqueueJob(sql, JOBS.track, { executionId }, { organizationId, idempotencyKey: `track:${executionId}` });
    });
  }

  // =====================================================================
  // Execuções iniciadas fora da plataforma (RF-052, RN-007, CA-009, CA-022)
  // =====================================================================

  async syncRuns(organizationId: string, pipelineId: string): Promise<void> {
    const loaded = await this.#tx(organizationId, async (sql) => {
      const pipeline = await pipelines.getPipeline(sql, organizationId, pipelineId);
      if (!pipeline || pipeline.archivedAt || !pipeline.capabilities.read.runs) return undefined;
      const syncedAt = await profiles.getRunsSyncedAt(sql, organizationId, pipelineId);
      const pending = await executions.dispatchingWithoutRun(sql, organizationId, pipelineId);
      const version = await pipelines.getVersion(sql, organizationId, pipelineId, pipeline.currentVersion);
      return { pipeline, syncedAt, pending, manifest: version!.manifest };
    });
    if (!loaded) return;
    const { pipeline, syncedAt, pending, manifest } = loaded;

    const startedAt = new Date();
    const since = new Date((syncedAt?.getTime() ?? startedAt.getTime() - this.#lookbackMs) - SYNC_OVERLAP_MS);
    const { connector, conn } = await this.#provider.open(organizationId, pipeline.integrationId, `sync-runs:${pipelineId}`);
    const page = await connector.listRuns(conn, pipeline.externalId, since.toISOString());

    // Um disparo nosso ainda sem id externo pode ser um destes runs: espera a próxima rodada.
    const holdFrom = pending.length ? Math.min(...pending.map((p) => (p.dispatchedAt ?? p.requestedAt).getTime())) - 60_000 : Infinity;

    await this.#tx(organizationId, async (sql) => {
      for (const run of page.items) {
        if (run.queuedAt && Date.parse(run.queuedAt) >= holdFrom) continue;
        if (await executions.findByExternalRun(sql, organizationId, pipelineId, run.externalRunId)) continue;
        await this.#recordExternal(sql, organizationId, pipeline, manifest, run);
      }
      await profiles.markRunsSynced(sql, organizationId, pipelineId, startedAt);
    });
  }

  async #recordExternal(
    sql: Sql,
    organizationId: string,
    pipeline: LinkedPipeline,
    manifest: Parameters<typeof exclusiveRefs>[0],
    run: ExternalRunState,
  ): Promise<void> {
    const mapped = fromProvider(run.status, "running");
    const status: ExecutionStatus = mapped?.status ?? "unknown";
    const refs = exclusiveRefs(manifest);
    const found = await resources.findByRefs(sql, organizationId, refs);
    const id = randomUUID();
    const parameters = run.rawParameters ? coerceParameterValues(manifest.parameters, run.rawParameters) : {};
    const version = extractSystemVersion(manifest.systemUnderTest, { runNumber: run.runNumber ?? null, tags: run.tags ?? [], parameters });
    const e = await executions.insertExecution(sql, {
      id,
      organizationId,
      projectId: pipeline.projectId,
      pipelineId: pipeline.id,
      manifestVersion: pipeline.currentVersion,
      triggerType: "external",
      status,
      statusReason: "Iniciada fora da plataforma (detectada na leitura do provedor).",
      externalStatus: run.externalStatus.slice(0, 100),
      externalRunId: run.externalRunId,
      ...(run.ref ? { ref: run.ref } : {}),
      parameters,
      ...(run.runNumber ? { runNumber: run.runNumber } : {}),
      ...(run.tags ? { runTags: run.tags } : {}),
      ...(version ? { systemVersion: version } : {}),
      resourceRefs: found.map((r) => r.ref),
      resourceIds: found.map((r) => r.id),
      ...(run.sourceRevision ? { sourceRevision: run.sourceRevision.slice(0, 200) } : {}),
      ...(run.agentOrPool ? { agentOrPool: run.agentOrPool.slice(0, 200) } : {}),
      correlationId: `sync-runs:${pipeline.id}`,
      ...(run.queuedAt ? { requestedAt: new Date(run.queuedAt) } : {}),
      ...(run.startedAt ? { startedAt: new Date(run.startedAt) } : {}),
      ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt) } : {}),
    });
    if (mapped?.failureKind && mapped.failureKind !== "none") {
      await executions.transition(sql, e, e.status, { failureKind: mapped.failureKind });
    }
    if (!isFinal(status)) {
      // Execução externa ativa também ocupa o recurso (RN-007), se ele estiver livre.
      if (found.length) {
        const locked = await resources.lockResources(sql, organizationId, found.map((r) => r.id));
        const busy = await resources.openLeases(sql, organizationId, locked.map((r) => r.id));
        if (!busy.length) await resources.acquireLeases(sql, { organizationId, resources: locked, executionId: id, holderKind: "external" });
      }
      await this.#scheduleTrack(sql, organizationId, id);
    }
    await this.#changed(sql, e);
  }

  // =====================================================================
  // Rotina periódica
  // =====================================================================

  /** Por organização: execuções sem notícia, leases vencidos, fila e leitura de execuções externas. */
  async tick(): Promise<void> {
    const { rows } = await this.#db.pool.query<{ id: string }>("SELECT app_active_organization_ids() AS id");
    for (const { id: organizationId } of rows) {
      try {
        await this.#tx(organizationId, async (sql) => {
          for (const e of await executions.silentSince(sql, organizationId, this.#staleAfter)) {
            const next = await executions.transition(sql, e, "stale", {
              statusReason: `Sem notícia do provedor há mais de ${minutes(this.#staleAfter)}.`,
            });
            await this.#changed(sql, next);
            await this.#scheduleTrack(sql, organizationId, e.id, 0);
          }
          for (const lease of await resources.expiredLeases(sql, organizationId)) {
            await this.#scheduleTrack(sql, organizationId, lease.executionId, 0);
          }
          await this.#wakeQueue(sql, organizationId);
          const cutoff = Date.now() - this.#syncEvery * 1000;
          for (const p of await profiles.pipelinesToSyncRuns(sql, organizationId)) {
            if (p.runsSyncedAt && p.runsSyncedAt.getTime() > cutoff) continue;
            await enqueueJob(sql, JOBS.syncRuns, { pipelineId: p.id }, { organizationId, idempotencyKey: `sync-runs:${p.id}`, retryLimit: 1 });
          }
        });
      } catch (error) {
        this.#log("error", "falha na rotina periódica", { organizationId, error: describe(error) });
      }
    }
  }

  // =====================================================================
  // Apoio
  // =====================================================================

  async #manifestOf(sql: Sql, e: Execution): Promise<PipelineManifest | undefined> {
    if (!e.manifestVersion) return undefined;
    return (await pipelines.getVersion(sql, e.organizationId, e.pipelineId, e.manifestVersion))?.manifest;
  }

  #org(job: Job<unknown>): string {
    if (!job.organizationId) throw new Error(`job ${job.name} sem organização`);
    return job.organizationId;
  }

  #tx<T>(organizationId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.#db.tx({ organizationId, userId: null }, fn);
  }

  async #scheduleTrack(sql: Sql, organizationId: string, executionId: string, delaySeconds = this.#poll): Promise<void> {
    await enqueueJob(
      sql,
      JOBS.track,
      { executionId },
      { organizationId, idempotencyKey: `track:${executionId}`, startAfter: new Date(Date.now() + delaySeconds * 1000) },
    );
  }

  async #wakeQueue(sql: Sql, organizationId: string): Promise<void> {
    for (const q of await executions.queued(sql, organizationId)) {
      await enqueueJob(sql, JOBS.dispatch, { executionId: q.id }, { organizationId, idempotencyKey: `dispatch:${q.id}` });
    }
  }

  async #changed(sql: Sql, e: Execution): Promise<void> {
    // Terminou: as regras de evento são avaliadas num job à parte (o aviso nunca atrasa a execução).
    if (isFinal(e.status)) {
      await enqueueJob(sql, JOBS.notify, { executionId: e.id }, { organizationId: e.organizationId, idempotencyKey: `notify:${e.id}` });
      // Relatórios: espera uns segundos, porque o provedor pode publicar o artefato logo depois de terminar.
      await enqueueJob(sql, JOBS.ingest, { executionId: e.id }, {
        organizationId: e.organizationId,
        idempotencyKey: `ingest:${e.id}`,
        startAfter: new Date(Date.now() + 10_000),
        retryLimit: 4,
      });
    }
    return publishEvent(sql, {
      type: "execution.changed",
      organizationId: e.organizationId,
      executionId: e.id,
      pipelineId: e.pipelineId,
      status: e.status,
    });
  }

  #auditSystem(
    sql: Sql,
    organizationId: string,
    correlationId: string,
    action: string,
    executionId: string,
    outcome: AuditEventInput["outcome"],
    details?: Record<string, unknown>,
  ) {
    return recordAudit(sql, {
      organizationId,
      actorUserId: null,
      actorKind: "system",
      action,
      targetType: "execution",
      targetId: executionId,
      outcome,
      correlationId,
      ...(details ? { details } : {}),
    });
  }
}

/** Mensagem segura para guardar e mostrar: só o que o conector montou, nunca credencial. */
function describe(error: unknown): string {
  if (error instanceof ProviderError || error instanceof NotSupportedError || error instanceof DomainError) return error.message.slice(0, 300);
  return "erro inesperado";
}
