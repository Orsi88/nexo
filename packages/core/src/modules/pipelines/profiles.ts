import type { ParameterValue } from "@painel/contracts";
import type { Sql } from "../../db/database.ts";

// Perfis de execução (RF-042): ref e parâmetros salvos com um nome, para disparar sem redigitar.
// Os valores são validados contra o manifesto ao salvar e de novo a cada pedido de execução,
// porque o manifesto pode mudar depois (RN-010).

export interface ExecutionProfile {
  id: string;
  pipelineId: string;
  name: string;
  description: string | null;
  ref: string | null;
  parameters: Record<string, ParameterValue>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

const COLUMNS = `id, pipeline_id, name, description, ref, parameters, created_by, created_at, updated_at, archived_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toProfile = (r: any): ExecutionProfile => ({
  id: r.id,
  pipelineId: r.pipeline_id,
  name: r.name,
  description: r.description,
  ref: r.ref,
  parameters: r.parameters,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertProfile(
  sql: Sql,
  input: {
    organizationId: string;
    pipelineId: string;
    name: string;
    description?: string;
    ref?: string;
    parameters: Record<string, ParameterValue>;
    createdBy: string;
  },
): Promise<ExecutionProfile> {
  const { rows } = await sql.query(
    `INSERT INTO pipelines_execution_profiles (organization_id, pipeline_id, name, description, ref, parameters, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [
      input.organizationId,
      input.pipelineId,
      input.name,
      input.description ?? null,
      input.ref ?? null,
      JSON.stringify(input.parameters),
      input.createdBy,
    ],
  );
  return toProfile(rows[0]);
}

export async function updateProfile(
  sql: Sql,
  organizationId: string,
  id: string,
  input: { name: string; description: string | null; ref: string | null; parameters: Record<string, ParameterValue> },
): Promise<ExecutionProfile | undefined> {
  const { rows } = await sql.query(
    `UPDATE pipelines_execution_profiles SET name = $3, description = $4, ref = $5, parameters = $6, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [organizationId, id, input.name, input.description, input.ref, JSON.stringify(input.parameters)],
  );
  return rows[0] ? toProfile(rows[0]) : undefined;
}

export async function setProfileArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<ExecutionProfile | undefined> {
  const { rows } = await sql.query(
    `UPDATE pipelines_execution_profiles SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [organizationId, id, archived],
  );
  return rows[0] ? toProfile(rows[0]) : undefined;
}

export async function getProfile(sql: Sql, organizationId: string, id: string): Promise<ExecutionProfile | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM pipelines_execution_profiles WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toProfile(rows[0]) : undefined;
}

export async function listProfiles(sql: Sql, organizationId: string, pipelineId: string, includeArchived = false): Promise<ExecutionProfile[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM pipelines_execution_profiles
      WHERE organization_id = $1 AND pipeline_id = $2 AND ($3 OR archived_at IS NULL) ORDER BY lower(name)`,
    [organizationId, pipelineId, includeArchived],
  );
  return rows.map(toProfile);
}

// ---------- Leitura das execuções do provedor (RF-052) ----------

/** Pipelines ativas que leem execuções do provedor, com o ponto até onde já foram lidas. */
export async function pipelinesToSyncRuns(sql: Sql, organizationId: string): Promise<Array<{ id: string; runsSyncedAt: Date | null }>> {
  const { rows } = await sql.query<{ id: string; runs_synced_at: Date | null }>(
    `SELECT id, runs_synced_at FROM pipelines_pipelines
      WHERE organization_id = $1 AND archived_at IS NULL AND (capabilities -> 'read' ->> 'runs')::boolean IS TRUE`,
    [organizationId],
  );
  return rows.map((r) => ({ id: r.id, runsSyncedAt: r.runs_synced_at }));
}

export async function getRunsSyncedAt(sql: Sql, organizationId: string, pipelineId: string): Promise<Date | null | undefined> {
  const { rows } = await sql.query<{ runs_synced_at: Date | null }>(
    `SELECT runs_synced_at FROM pipelines_pipelines WHERE organization_id = $1 AND id = $2`,
    [organizationId, pipelineId],
  );
  return rows[0] ? rows[0].runs_synced_at : undefined;
}

export async function markRunsSynced(sql: Sql, organizationId: string, pipelineId: string, at: Date): Promise<void> {
  await sql.query(`UPDATE pipelines_pipelines SET runs_synced_at = $3 WHERE organization_id = $1 AND id = $2`, [organizationId, pipelineId, at]);
}
