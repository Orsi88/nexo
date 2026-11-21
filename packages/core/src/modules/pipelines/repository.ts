import type { ConnectorCapabilities, ParameterSpec, PipelineManifest, SyncState } from "@painel/contracts";
import type { Sql } from "../../db/database.ts";

// Persistência do módulo pipelines: pipeline vinculada (com o que foi sincronizado do provedor) e
// histórico do manifesto. Versões só são incluídas, nunca alteradas (RN-042).

export type ManifestSource = "discovery" | "manual" | "import" | "assist";

export interface LinkedPipeline {
  id: string;
  organizationId: string;
  projectId: string;
  integrationId: string;
  externalId: string;
  name: string;
  externalUrl: string | null;
  externalPath: string | null;
  repositoryName: string | null;
  repositoryUrl: string | null;
  defaultRef: string | null;
  parametersRef: string | null;
  externalRevision: string | null;
  definitionRevision: string | null;
  capabilities: ConnectorCapabilities;
  externalParameters: ParameterSpec[];
  syncState: SyncState;
  syncProblem: string | null;
  syncedAt: Date | null;
  currentVersion: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ManifestVersion {
  pipelineId: string;
  version: number;
  manifest: PipelineManifest;
  source: ManifestSource;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** O que veio do provedor numa sincronização. */
export interface ExternalSnapshot {
  name: string;
  externalUrl?: string;
  externalPath?: string;
  repositoryName?: string;
  repositoryUrl?: string;
  defaultRef?: string;
  parametersRef?: string;
  externalRevision?: string;
  definitionRevision?: string;
  capabilities: ConnectorCapabilities;
  externalParameters: ParameterSpec[];
}

const COLUMNS = `id, organization_id, project_id, integration_id, external_id, name, external_url, external_path,
  repository_name, repository_url, default_ref,
  parameters_ref, external_revision, definition_revision, capabilities, external_parameters, sync_state, sync_problem,
  synced_at, current_version, created_by, created_at, updated_at, archived_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toPipeline = (r: any): LinkedPipeline => ({
  id: r.id,
  organizationId: r.organization_id,
  projectId: r.project_id,
  integrationId: r.integration_id,
  externalId: r.external_id,
  name: r.name,
  externalUrl: r.external_url,
  externalPath: r.external_path,
  repositoryName: r.repository_name,
  repositoryUrl: r.repository_url,
  defaultRef: r.default_ref,
  parametersRef: r.parameters_ref,
  externalRevision: r.external_revision,
  definitionRevision: r.definition_revision,
  capabilities: r.capabilities,
  externalParameters: r.external_parameters,
  syncState: r.sync_state,
  syncProblem: r.sync_problem,
  syncedAt: r.synced_at,
  currentVersion: r.current_version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

const toVersion = (r: any): ManifestVersion => ({
  pipelineId: r.pipeline_id,
  version: r.version,
  manifest: r.manifest,
  source: r.source,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertPipeline(
  sql: Sql,
  input: { id: string; organizationId: string; projectId: string; integrationId: string; externalId: string; createdBy: string },
  snapshot: ExternalSnapshot,
): Promise<LinkedPipeline> {
  const { rows } = await sql.query(
    `INSERT INTO pipelines_pipelines
       (id, organization_id, project_id, integration_id, external_id, name, external_url, external_path, default_ref,
        parameters_ref, external_revision, definition_revision, capabilities, external_parameters, sync_state, synced_at,
        current_version, created_by, repository_name, repository_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'synchronized', now(), 1, $15, $16, $17)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.integrationId,
      input.externalId,
      snapshot.name,
      snapshot.externalUrl ?? null,
      snapshot.externalPath ?? null,
      snapshot.defaultRef ?? null,
      snapshot.parametersRef ?? null,
      snapshot.externalRevision ?? null,
      snapshot.definitionRevision ?? null,
      JSON.stringify(snapshot.capabilities),
      JSON.stringify(snapshot.externalParameters),
      input.createdBy,
      snapshot.repositoryName ?? null,
      snapshot.repositoryUrl ?? null,
    ],
  );
  return toPipeline(rows[0]);
}

export async function getPipeline(sql: Sql, organizationId: string, id: string): Promise<LinkedPipeline | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM pipelines_pipelines WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toPipeline(rows[0]) : undefined;
}

/** Trava a linha para atualizar o manifesto sem corrida entre duas edições. */
export async function getPipelineForUpdate(sql: Sql, organizationId: string, id: string): Promise<LinkedPipeline | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM pipelines_pipelines WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toPipeline(rows[0]) : undefined;
}

export async function listPipelines(
  sql: Sql,
  organizationId: string,
  filter: { projectId?: string; q?: string; includeArchived?: boolean } = {},
): Promise<LinkedPipeline[]> {
  const like = filter.q?.trim() ? `%${filter.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM pipelines_pipelines
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        AND ($3::text IS NULL OR lower(name) LIKE $3) AND ($4 OR archived_at IS NULL)
      ORDER BY lower(name)`,
    [organizationId, filter.projectId ?? null, like, filter.includeArchived ?? false],
  );
  return rows.map(toPipeline);
}

/** Pipelines externas já vinculadas por uma integração, para marcar na descoberta. */
export async function linkedExternalIds(sql: Sql, organizationId: string, integrationId: string): Promise<Map<string, string[]>> {
  const { rows } = await sql.query<{ external_id: string; project_id: string }>(
    `SELECT external_id, project_id FROM pipelines_pipelines
      WHERE organization_id = $1 AND integration_id = $2 AND archived_at IS NULL`,
    [organizationId, integrationId],
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.external_id, [...(out.get(r.external_id) ?? []), r.project_id]);
  return out;
}

export async function updateSnapshot(sql: Sql, organizationId: string, id: string, s: ExternalSnapshot): Promise<LinkedPipeline> {
  const { rows } = await sql.query(
    `UPDATE pipelines_pipelines SET
        name = $3, external_url = $4, external_path = $5, default_ref = $6, parameters_ref = $7, external_revision = $8,
        definition_revision = $9, capabilities = $10, external_parameters = $11,
        repository_name = $12, repository_url = $13,
        sync_state = 'synchronized', sync_problem = NULL, synced_at = now(), updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [
      organizationId,
      id,
      s.name,
      s.externalUrl ?? null,
      s.externalPath ?? null,
      s.defaultRef ?? null,
      s.parametersRef ?? null,
      s.externalRevision ?? null,
      s.definitionRevision ?? null,
      JSON.stringify(s.capabilities),
      JSON.stringify(s.externalParameters),
      s.repositoryName ?? null,
      s.repositoryUrl ?? null,
    ],
  );
  return toPipeline(rows[0]);
}

/** Sincronização falhou: o dado guardado continua, marcado como desconhecido (RNF-025). */
export async function markSyncProblem(sql: Sql, organizationId: string, id: string, problem: string): Promise<void> {
  await sql.query(
    `UPDATE pipelines_pipelines SET sync_state = 'unknown', sync_problem = $3, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, id, problem.slice(0, 500)],
  );
}

export async function setArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<LinkedPipeline | undefined> {
  const { rows } = await sql.query(
    `UPDATE pipelines_pipelines SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [organizationId, id, archived],
  );
  return rows[0] ? toPipeline(rows[0]) : undefined;
}

export async function insertVersion(
  sql: Sql,
  input: {
    organizationId: string;
    pipelineId: string;
    version: number;
    manifest: PipelineManifest;
    source: ManifestSource;
    note?: string;
    createdBy: string;
  },
): Promise<ManifestVersion> {
  const { rows } = await sql.query(
    `INSERT INTO pipelines_config_versions (organization_id, pipeline_id, version, manifest, source, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.organizationId, input.pipelineId, input.version, JSON.stringify(input.manifest), input.source, input.note ?? null, input.createdBy],
  );
  if (input.version > 1) {
    await sql.query(`UPDATE pipelines_pipelines SET current_version = $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
      input.organizationId,
      input.pipelineId,
      input.version,
    ]);
  }
  return toVersion(rows[0]);
}

export async function getVersion(sql: Sql, organizationId: string, pipelineId: string, version: number): Promise<ManifestVersion | undefined> {
  const { rows } = await sql.query(
    `SELECT * FROM pipelines_config_versions WHERE organization_id = $1 AND pipeline_id = $2 AND version = $3`,
    [organizationId, pipelineId, version],
  );
  return rows[0] ? toVersion(rows[0]) : undefined;
}

/** Histórico sem o corpo do manifesto, do mais novo para o mais antigo. */
export async function listVersions(sql: Sql, organizationId: string, pipelineId: string): Promise<Array<Omit<ManifestVersion, "manifest">>> {
  const { rows } = await sql.query(
    `SELECT pipeline_id, version, source, note, created_by, created_at FROM pipelines_config_versions
      WHERE organization_id = $1 AND pipeline_id = $2 ORDER BY version DESC`,
    [organizationId, pipelineId],
  );
  return rows.map((r) => ({
    pipelineId: r.pipeline_id,
    version: r.version,
    source: r.source,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
