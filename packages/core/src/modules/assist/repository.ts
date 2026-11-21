import type { PipelineManifest } from "@painel/contracts";
import type { Sql } from "../../db/database.ts";
import type { SealedSecret } from "../../shared/secret-store.ts";

// Persistência do módulo assist: provedores de IA, servidores MCP e sessões assistidas.
// Credenciais só como SealedSecret; as leituras para a API nunca devolvem o campo credential.

export type AiProviderKind = "anthropic" | "openai-compatible";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export interface CheckRecord {
  ok: boolean;
  message: string;
}

export interface AiProviderRow {
  id: string;
  name: string;
  kind: AiProviderKind;
  endpoint: string;
  model: string;
  effort: Effort | null;
  hasCredential: boolean;
  lastCheck: CheckRecord | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface McpToolRow {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  kind: "read" | "mutate";
  authorized: boolean;
}

export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  authHeader: string | null;
  hasCredential: boolean;
  tools: McpToolRow[];
  serverInfo: { name?: string; version?: string } | null;
  lastCheck: CheckRecord | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export type SessionStatus = "queued" | "running" | "proposed" | "failed" | "applied" | "discarded";

export interface SessionReview {
  manifest: PipelineManifest | null;
  problems: string[];
  warnings: string[];
  changes: string[];
  notes: { summary: string; sources: string[]; uncertainties: string[] };
}

export interface AssistSession {
  id: string;
  projectId: string;
  integrationId: string;
  externalId: string;
  ref: string | null;
  pipelineName: string;
  providerId: string;
  mcpTools: string[];
  status: SessionStatus;
  baseline: PipelineManifest;
  providerParameters: string[];
  review: SessionReview | null;
  steps: Array<{ tool: string; source: string; input: string; ok: boolean; chars: number; ms: number }>;
  usage: { inputTokens: number; outputTokens: number; turns: number } | null;
  error: string | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  appliedAt: Date | null;
  appliedPipelineId: string | null;
}

const PROVIDER_COLUMNS = `id, name, kind, endpoint, model, effort, credential IS NOT NULL AS has_credential, last_check, last_checked_at, created_at, archived_at`;
const MCP_COLUMNS = `id, name, url, auth_header, credential IS NOT NULL AS has_credential, tools, server_info, last_check, last_checked_at, created_at, archived_at`;
const SESSION_COLUMNS = `id, project_id, integration_id, external_id, ref, pipeline_name, provider_id, mcp_tools, status, baseline, provider_parameters, review,
  steps, usage, error, created_by, created_at, started_at, finished_at, applied_at, applied_pipeline_id`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toProvider = (r: any): AiProviderRow => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  endpoint: r.endpoint,
  model: r.model,
  effort: r.effort,
  hasCredential: r.has_credential,
  lastCheck: r.last_check,
  lastCheckedAt: r.last_checked_at,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});
const toMcp = (r: any): McpServerRow => ({
  id: r.id,
  name: r.name,
  url: r.url,
  authHeader: r.auth_header,
  hasCredential: r.has_credential,
  tools: r.tools ?? [],
  serverInfo: r.server_info,
  lastCheck: r.last_check,
  lastCheckedAt: r.last_checked_at,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});
const toSession = (r: any): AssistSession => ({
  id: r.id,
  projectId: r.project_id,
  integrationId: r.integration_id,
  externalId: r.external_id,
  ref: r.ref,
  pipelineName: r.pipeline_name,
  providerId: r.provider_id,
  mcpTools: r.mcp_tools ?? [],
  status: r.status,
  baseline: r.baseline,
  providerParameters: r.provider_parameters ?? [],
  review: r.review,
  steps: r.steps ?? [],
  usage: r.usage,
  error: r.error,
  createdBy: r.created_by,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  appliedAt: r.applied_at,
  appliedPipelineId: r.applied_pipeline_id,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Provedores de IA ----------

export async function insertProvider(
  sql: Sql,
  organizationId: string,
  p: { name: string; kind: AiProviderKind; endpoint: string; model: string; effort: Effort | null; credential: SealedSecret | null; check: CheckRecord; createdBy: string },
): Promise<AiProviderRow> {
  const { rows } = await sql.query(
    `INSERT INTO assist_ai_providers (organization_id, name, kind, endpoint, model, effort, credential, last_check, last_checked_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) RETURNING ${PROVIDER_COLUMNS}`,
    [organizationId, p.name, p.kind, p.endpoint, p.model, p.effort, p.credential ? JSON.stringify(p.credential) : null, JSON.stringify(p.check), p.createdBy],
  );
  return toProvider(rows[0]);
}

export async function listProviders(sql: Sql, organizationId: string): Promise<AiProviderRow[]> {
  const { rows } = await sql.query(`SELECT ${PROVIDER_COLUMNS} FROM assist_ai_providers WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name)`, [organizationId]);
  return rows.map(toProvider);
}

export async function getProvider(sql: Sql, organizationId: string, id: string): Promise<(AiProviderRow & { credential: SealedSecret | null }) | undefined> {
  const { rows } = await sql.query(`SELECT ${PROVIDER_COLUMNS}, credential FROM assist_ai_providers WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? { ...toProvider(rows[0]), credential: rows[0].credential } : undefined;
}

export async function setProviderCheck(sql: Sql, organizationId: string, id: string, check: CheckRecord): Promise<void> {
  await sql.query(`UPDATE assist_ai_providers SET last_check = $3, last_checked_at = now() WHERE organization_id = $1 AND id = $2`, [organizationId, id, JSON.stringify(check)]);
}

export async function archiveProvider(sql: Sql, organizationId: string, id: string): Promise<AiProviderRow | undefined> {
  const { rows } = await sql.query(
    `UPDATE assist_ai_providers SET archived_at = coalesce(archived_at, now()) WHERE organization_id = $1 AND id = $2 RETURNING ${PROVIDER_COLUMNS}`,
    [organizationId, id],
  );
  return rows[0] ? toProvider(rows[0]) : undefined;
}

// ---------- Servidores MCP ----------

export async function insertMcpServer(
  sql: Sql,
  organizationId: string,
  s: { name: string; url: string; authHeader: string | null; credential: SealedSecret | null; tools: McpToolRow[]; serverInfo: McpServerRow["serverInfo"]; check: CheckRecord; createdBy: string },
): Promise<McpServerRow> {
  const { rows } = await sql.query(
    `INSERT INTO assist_mcp_servers (organization_id, name, url, auth_header, credential, tools, server_info, last_check, last_checked_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) RETURNING ${MCP_COLUMNS}`,
    [
      organizationId,
      s.name,
      s.url,
      s.authHeader,
      s.credential ? JSON.stringify(s.credential) : null,
      JSON.stringify(s.tools),
      s.serverInfo ? JSON.stringify(s.serverInfo) : null,
      JSON.stringify(s.check),
      s.createdBy,
    ],
  );
  return toMcp(rows[0]);
}

export async function listMcpServers(sql: Sql, organizationId: string): Promise<McpServerRow[]> {
  const { rows } = await sql.query(`SELECT ${MCP_COLUMNS} FROM assist_mcp_servers WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name)`, [organizationId]);
  return rows.map(toMcp);
}

export async function getMcpServer(sql: Sql, organizationId: string, id: string): Promise<(McpServerRow & { credential: SealedSecret | null }) | undefined> {
  const { rows } = await sql.query(`SELECT ${MCP_COLUMNS}, credential FROM assist_mcp_servers WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? { ...toMcp(rows[0]), credential: rows[0].credential } : undefined;
}

export async function updateMcpTools(
  sql: Sql,
  organizationId: string,
  id: string,
  tools: McpToolRow[],
  extra: { serverInfo?: McpServerRow["serverInfo"]; check?: CheckRecord } = {},
): Promise<McpServerRow | undefined> {
  const { rows } = await sql.query(
    `UPDATE assist_mcp_servers SET tools = $3,
            server_info = CASE WHEN $4::jsonb IS NULL THEN server_info ELSE $4::jsonb END,
            last_check = CASE WHEN $5::jsonb IS NULL THEN last_check ELSE $5::jsonb END,
            last_checked_at = CASE WHEN $5::jsonb IS NULL THEN last_checked_at ELSE now() END
      WHERE organization_id = $1 AND id = $2 RETURNING ${MCP_COLUMNS}`,
    [organizationId, id, JSON.stringify(tools), extra.serverInfo ? JSON.stringify(extra.serverInfo) : null, extra.check ? JSON.stringify(extra.check) : null],
  );
  return rows[0] ? toMcp(rows[0]) : undefined;
}

export async function archiveMcpServer(sql: Sql, organizationId: string, id: string): Promise<McpServerRow | undefined> {
  const { rows } = await sql.query(`UPDATE assist_mcp_servers SET archived_at = coalesce(archived_at, now()) WHERE organization_id = $1 AND id = $2 RETURNING ${MCP_COLUMNS}`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toMcp(rows[0]) : undefined;
}

// ---------- Sessões ----------

export async function insertSession(
  sql: Sql,
  organizationId: string,
  s: Pick<AssistSession, "projectId" | "integrationId" | "externalId" | "ref" | "pipelineName" | "providerId" | "mcpTools" | "baseline" | "providerParameters" | "createdBy">,
): Promise<AssistSession> {
  const { rows } = await sql.query(
    `INSERT INTO assist_sessions (organization_id, project_id, integration_id, external_id, ref, pipeline_name, provider_id, mcp_tools, baseline, provider_parameters, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${SESSION_COLUMNS}`,
    [
      organizationId,
      s.projectId,
      s.integrationId,
      s.externalId.slice(0, 200),
      s.ref,
      s.pipelineName.slice(0, 200),
      s.providerId,
      JSON.stringify(s.mcpTools),
      JSON.stringify(s.baseline),
      JSON.stringify(s.providerParameters),
      s.createdBy,
    ],
  );
  return toSession(rows[0]);
}

export async function getSession(sql: Sql, organizationId: string, id: string): Promise<AssistSession | undefined> {
  const { rows } = await sql.query(`SELECT ${SESSION_COLUMNS} FROM assist_sessions WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? toSession(rows[0]) : undefined;
}

export async function listSessions(sql: Sql, organizationId: string, limit = 50): Promise<AssistSession[]> {
  const { rows } = await sql.query(`SELECT ${SESSION_COLUMNS} FROM assist_sessions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`, [
    organizationId,
    Math.min(Math.max(limit, 1), 200),
  ]);
  return rows.map(toSession);
}

/** Marca o início; devolve false se outra execução do job já pegou a sessão. */
export async function startSession(sql: Sql, organizationId: string, id: string): Promise<boolean> {
  const res = await sql.query(`UPDATE assist_sessions SET status = 'running', started_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'queued'`, [organizationId, id]);
  return (res.rowCount ?? 0) > 0;
}

export async function finishSession(
  sql: Sql,
  organizationId: string,
  id: string,
  r: { status: "proposed" | "failed"; review?: SessionReview; steps: AssistSession["steps"]; usage?: AssistSession["usage"]; error?: string },
): Promise<void> {
  await sql.query(
    `UPDATE assist_sessions SET status = $3, review = $4, steps = $5, usage = $6, error = $7, finished_at = now()
      WHERE organization_id = $1 AND id = $2 AND status = 'running'`,
    [organizationId, id, r.status, r.review ? JSON.stringify(r.review) : null, JSON.stringify(r.steps), r.usage ? JSON.stringify(r.usage) : null, r.error?.slice(0, 1000) ?? null],
  );
}

export async function markApplied(sql: Sql, organizationId: string, id: string, userId: string, pipelineId: string): Promise<void> {
  await sql.query(
    `UPDATE assist_sessions SET status = 'applied', applied_by = $3, applied_at = now(), applied_pipeline_id = $4 WHERE organization_id = $1 AND id = $2`,
    [organizationId, id, userId, pipelineId],
  );
}

export async function markDiscarded(sql: Sql, organizationId: string, id: string): Promise<boolean> {
  const res = await sql.query(`UPDATE assist_sessions SET status = 'discarded' WHERE organization_id = $1 AND id = $2 AND status IN ('proposed', 'failed', 'queued')`, [
    organizationId,
    id,
  ]);
  return (res.rowCount ?? 0) > 0;
}
