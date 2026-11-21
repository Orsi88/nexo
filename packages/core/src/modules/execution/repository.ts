import type { ExecutionStatus, FailureKind, ParameterValue, ReportStatus, SystemVersion } from "@painel/contracts";
import type { Sql } from "../../db/database.ts";

// Persistência do módulo execution (§9: campos mínimos de execução). Toda mudança de estado passa
// por `transition`, que grava o histórico (execution_transitions) na mesma transação.

export type TriggerType = "manual" | "rerun" | "external" | "schedule";

export interface Execution {
  id: string;
  organizationId: string;
  projectId: string;
  pipelineId: string;
  profileId: string | null;
  manifestVersion: number | null;
  triggerType: TriggerType;
  requestedBy: string | null;
  rerunOf: string | null;
  status: ExecutionStatus;
  statusReason: string | null;
  externalStatus: string | null;
  externalRunId: string | null;
  ref: string | null;
  parameters: Record<string, ParameterValue>;
  resourceRefs: string[];
  resourceIds: string[];
  failureKind: FailureKind;
  reportStatus: ReportStatus;
  sourceRevision: string | null;
  agentOrPool: string | null;
  runNumber: string | null;
  runTags: string[];
  /** Versão do sistema em teste (distribuição, pacote...), se o manifesto diz como achá-la. */
  systemVersion: SystemVersion | null;
  correlationId: string;
  requestedAt: Date;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastSyncedAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelRequestedBy: string | null;
  updatedAt: Date;
}

export interface Transition {
  fromStatus: ExecutionStatus | null;
  toStatus: ExecutionStatus;
  reason: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

/** Estados em que a execução ainda pode mudar sozinha no provedor. */
export const ACTIVE_STATUSES: readonly ExecutionStatus[] = ["dispatching", "running", "cancelling", "stale"];
/** Estados finais: nada mais muda, a não ser a ingestão de resultados. */
export const FINAL_STATUSES: readonly ExecutionStatus[] = ["rejected", "cancelled", "succeeded", "failed", "unknown"];

export const isFinal = (s: ExecutionStatus) => FINAL_STATUSES.includes(s);

const COLUMNS = `id, organization_id, project_id, pipeline_id, profile_id, manifest_version, trigger_type, requested_by, rerun_of,
  status, status_reason, external_status, external_run_id, ref, parameters_snapshot, resource_refs, resource_ids, failure_kind,
  report_status, source_revision, agent_or_pool, run_number, run_tags, system_version, correlation_id, requested_at, dispatched_at, started_at, finished_at,
  last_synced_at, cancel_requested_at, cancel_requested_by, updated_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toExecution = (r: any): Execution => ({
  id: r.id,
  organizationId: r.organization_id,
  projectId: r.project_id,
  pipelineId: r.pipeline_id,
  profileId: r.profile_id,
  manifestVersion: r.manifest_version,
  triggerType: r.trigger_type,
  requestedBy: r.requested_by,
  rerunOf: r.rerun_of,
  status: r.status,
  statusReason: r.status_reason,
  externalStatus: r.external_status,
  externalRunId: r.external_run_id,
  ref: r.ref,
  parameters: r.parameters_snapshot,
  resourceRefs: r.resource_refs,
  resourceIds: r.resource_ids,
  failureKind: r.failure_kind,
  reportStatus: r.report_status,
  sourceRevision: r.source_revision,
  agentOrPool: r.agent_or_pool,
  runNumber: r.run_number,
  runTags: r.run_tags,
  systemVersion: r.system_version,
  correlationId: r.correlation_id,
  requestedAt: r.requested_at,
  dispatchedAt: r.dispatched_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  lastSyncedAt: r.last_synced_at,
  cancelRequestedAt: r.cancel_requested_at,
  cancelRequestedBy: r.cancel_requested_by,
  updatedAt: r.updated_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface NewExecution {
  id: string;
  organizationId: string;
  projectId: string;
  pipelineId: string;
  profileId?: string;
  manifestVersion?: number;
  triggerType: TriggerType;
  requestedBy?: string;
  rerunOf?: string;
  status: ExecutionStatus;
  statusReason?: string;
  externalStatus?: string;
  externalRunId?: string;
  ref?: string;
  parameters: Record<string, ParameterValue>;
  resourceRefs: string[];
  resourceIds: string[];
  sourceRevision?: string;
  agentOrPool?: string;
  runNumber?: string;
  runTags?: string[];
  systemVersion?: SystemVersion;
  idempotencyKey?: string;
  correlationId: string;
  requestedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

/** Insere a execução e a primeira transição. Unicidade violada (idempotência, run externo) sobe como erro. */
export async function insertExecution(sql: Sql, e: NewExecution): Promise<Execution> {
  const { rows } = await sql.query(
    `INSERT INTO execution_executions
       (id, organization_id, project_id, pipeline_id, profile_id, manifest_version, trigger_type, requested_by, rerun_of, status,
        status_reason, external_status, external_run_id, ref, parameters_snapshot, resource_refs, resource_ids, source_revision,
        agent_or_pool, idempotency_key, correlation_id, requested_at, started_at, finished_at, last_synced_at,
        run_number, run_tags, system_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             coalesce($22, now()), $23, $24, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END, $25, $26, $27)
     RETURNING ${COLUMNS}`,
    [
      e.id,
      e.organizationId,
      e.projectId,
      e.pipelineId,
      e.profileId ?? null,
      e.manifestVersion ?? null,
      e.triggerType,
      e.requestedBy ?? null,
      e.rerunOf ?? null,
      e.status,
      e.statusReason ?? null,
      e.externalStatus ?? null,
      e.externalRunId ?? null,
      e.ref ?? null,
      JSON.stringify(e.parameters),
      e.resourceRefs,
      e.resourceIds,
      e.sourceRevision ?? null,
      e.agentOrPool ?? null,
      e.idempotencyKey ?? null,
      e.correlationId,
      e.requestedAt ?? null,
      e.startedAt ?? null,
      e.finishedAt ?? null,
      e.runNumber ?? null,
      e.runTags ?? [],
      e.systemVersion ? JSON.stringify(e.systemVersion) : null,
    ],
  );
  await sql.query(
    `INSERT INTO execution_transitions (organization_id, execution_id, from_status, to_status, reason, actor_user_id)
     VALUES ($1, $2, NULL, $3, $4, $5)`,
    [e.organizationId, e.id, e.status, e.statusReason ?? null, e.requestedBy ?? null],
  );
  return toExecution(rows[0]);
}

export async function getExecution(sql: Sql, organizationId: string, id: string): Promise<Execution | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM execution_executions WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? toExecution(rows[0]) : undefined;
}

export async function getExecutionForUpdate(sql: Sql, organizationId: string, id: string): Promise<Execution | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM execution_executions WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toExecution(rows[0]) : undefined;
}

export async function findByIdempotencyKey(sql: Sql, organizationId: string, userId: string, key: string): Promise<Execution | undefined> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions WHERE organization_id = $1 AND requested_by = $2 AND idempotency_key = $3`,
    [organizationId, userId, key],
  );
  return rows[0] ? toExecution(rows[0]) : undefined;
}

export async function findByExternalRun(sql: Sql, organizationId: string, pipelineId: string, externalRunId: string): Promise<Execution | undefined> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions WHERE organization_id = $1 AND pipeline_id = $2 AND external_run_id = $3`,
    [organizationId, pipelineId, externalRunId],
  );
  return rows[0] ? toExecution(rows[0]) : undefined;
}

/**
 * Pedido igual e recente do mesmo usuário ainda em andamento: provável clique duplo ou envio
 * repetido (RF-057). Compara pipeline, ref e parâmetros.
 */
export async function findRecentDuplicate(
  sql: Sql,
  input: { organizationId: string; userId: string; pipelineId: string; ref: string | null; parameters: Record<string, ParameterValue>; withinSeconds: number },
): Promise<Execution | undefined> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions
      WHERE organization_id = $1 AND requested_by = $2 AND pipeline_id = $3 AND ref IS NOT DISTINCT FROM $4
        AND parameters_snapshot = $5::jsonb AND requested_at > now() - make_interval(secs => $6)
        AND status IN ('queued', 'dispatching', 'running')
      ORDER BY requested_at DESC LIMIT 1`,
    [input.organizationId, input.userId, input.pipelineId, input.ref, JSON.stringify(input.parameters), input.withinSeconds],
  );
  return rows[0] ? toExecution(rows[0]) : undefined;
}

export interface ExecutionFilter {
  pipelineId?: string;
  projectId?: string;
  status?: ExecutionStatus[];
  before?: Date;
  limit?: number;
}

export async function listExecutions(sql: Sql, organizationId: string, f: ExecutionFilter = {}): Promise<Execution[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions
      WHERE organization_id = $1
        AND ($2::uuid IS NULL OR pipeline_id = $2::uuid)
        AND ($3::uuid IS NULL OR project_id = $3::uuid)
        AND ($4::text[] IS NULL OR status = ANY($4::text[]))
        AND ($5::timestamptz IS NULL OR requested_at < $5::timestamptz)
      ORDER BY requested_at DESC
      LIMIT $6`,
    [organizationId, f.pipelineId ?? null, f.projectId ?? null, f.status?.length ? f.status : null, f.before ?? null, Math.min(f.limit ?? 50, 200)],
  );
  return rows.map(toExecution);
}

export async function listTransitions(sql: Sql, organizationId: string, executionId: string): Promise<Transition[]> {
  const { rows } = await sql.query(
    `SELECT from_status, to_status, reason, actor_user_id, occurred_at FROM execution_transitions
      WHERE organization_id = $1 AND execution_id = $2 ORDER BY id`,
    [organizationId, executionId],
  );
  return rows.map((r) => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    actorUserId: r.actor_user_id,
    occurredAt: r.occurred_at,
  }));
}

/** Campos que acompanham uma mudança de estado. Ausente = não muda. */
export interface ExecutionPatch {
  statusReason?: string | null;
  externalStatus?: string | null;
  externalRunId?: string;
  failureKind?: FailureKind;
  sourceRevision?: string;
  agentOrPool?: string;
  dispatchedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  synced?: boolean;
  cancelRequestedBy?: string;
  runNumber?: string;
  runTags?: string[];
  systemVersion?: SystemVersion;
}

/**
 * Muda o estado (e grava a transição se o estado mudou). Chame com a linha travada
 * (getExecutionForUpdate) para não perder uma mudança concorrente.
 */
export async function transition(
  sql: Sql,
  current: Execution,
  to: ExecutionStatus,
  patch: ExecutionPatch = {},
  actorUserId: string | null = null,
): Promise<Execution> {
  const has = (k: keyof ExecutionPatch) => patch[k] !== undefined;
  const { rows } = await sql.query(
    `UPDATE execution_executions SET
        status = $3,
        status_reason = CASE WHEN $4 THEN $5 ELSE status_reason END,
        external_status = CASE WHEN $6 THEN $7 ELSE external_status END,
        external_run_id = coalesce($8, external_run_id),
        failure_kind = coalesce($9, failure_kind),
        source_revision = coalesce($10, source_revision),
        agent_or_pool = coalesce($11, agent_or_pool),
        dispatched_at = coalesce(dispatched_at, $12),
        started_at = coalesce(started_at, $13),
        finished_at = coalesce(finished_at, $14),
        last_synced_at = CASE WHEN $15 THEN now() ELSE last_synced_at END,
        cancel_requested_at = CASE WHEN $16::uuid IS NOT NULL THEN coalesce(cancel_requested_at, now()) ELSE cancel_requested_at END,
        cancel_requested_by = coalesce(cancel_requested_by, $16::uuid),
        run_number = coalesce($17, run_number),
        run_tags = coalesce($18, run_tags),
        system_version = coalesce($19::jsonb, system_version),
        updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [
      current.organizationId,
      current.id,
      to,
      has("statusReason"),
      patch.statusReason ?? null,
      has("externalStatus"),
      patch.externalStatus ?? null,
      patch.externalRunId ?? null,
      patch.failureKind ?? null,
      patch.sourceRevision ?? null,
      patch.agentOrPool ?? null,
      patch.dispatchedAt ?? null,
      patch.startedAt ?? null,
      patch.finishedAt ?? null,
      patch.synced ?? false,
      patch.cancelRequestedBy ?? null,
      patch.runNumber ?? null,
      patch.runTags ?? null,
      patch.systemVersion ? JSON.stringify(patch.systemVersion) : null,
    ],
  );
  if (current.status !== to) {
    await sql.query(
      `INSERT INTO execution_transitions (organization_id, execution_id, from_status, to_status, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [current.organizationId, current.id, current.status, to, patch.statusReason ?? null, actorUserId],
    );
  }
  return toExecution(rows[0]);
}

/** Ids das reexecuções de uma execução, mais antigas primeiro (RN-009). */
export async function listReruns(sql: Sql, organizationId: string, executionId: string): Promise<string[]> {
  const { rows } = await sql.query<{ id: string }>(
    `SELECT id FROM execution_executions WHERE organization_id = $1 AND rerun_of = $2 ORDER BY requested_at`,
    [organizationId, executionId],
  );
  return rows.map((r) => r.id);
}

/** Execuções na fila, mais antigas primeiro (FIFO por organização). */
export async function queued(sql: Sql, organizationId: string): Promise<Execution[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions WHERE organization_id = $1 AND status = 'queued' ORDER BY requested_at, id`,
    [organizationId],
  );
  return rows.map(toExecution);
}

/** Execuções em andamento sem notícia do provedor há mais de `seconds` (RF-060). */
export async function silentSince(sql: Sql, organizationId: string, seconds: number): Promise<Execution[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions
      WHERE organization_id = $1 AND status IN ('dispatching', 'running', 'cancelling')
        AND coalesce(last_synced_at, dispatched_at, requested_at) < now() - make_interval(secs => $2)`,
    [organizationId, seconds],
  );
  return rows.map(toExecution);
}

/** Execuções da plataforma ainda sendo disparadas numa pipeline (sem id externo confirmado). */
export async function dispatchingWithoutRun(sql: Sql, organizationId: string, pipelineId: string): Promise<Execution[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM execution_executions
      WHERE organization_id = $1 AND pipeline_id = $2 AND status = 'dispatching' AND external_run_id IS NULL`,
    [organizationId, pipelineId],
  );
  return rows.map(toExecution);
}

/**
 * Posição na fila (1 = próxima) de cada execução enfileirada. Só disputa posição com quem pede ao
 * menos um recurso em comum; quem não pede recurso exclusivo nunca espera.
 */
export function queuePositions(queue: readonly Pick<Execution, "id" | "resourceIds">[]): Map<string, number> {
  const out = new Map<string, number>();
  queue.forEach((e, i) => {
    const ahead = queue.slice(0, i).filter((o) => o.resourceIds.some((r) => e.resourceIds.includes(r))).length;
    out.set(e.id, ahead + 1);
  });
  return out;
}

/** Grava a situação dos relatórios e o tipo de falha da execução (RN-011, RN-012). */
export async function setReportOutcome(sql: Sql, organizationId: string, executionId: string, reportStatus: ReportStatus, failureKind: FailureKind): Promise<void> {
  await sql.query(`UPDATE execution_executions SET report_status = $3, failure_kind = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    executionId,
    reportStatus,
    failureKind,
  ]);
}
