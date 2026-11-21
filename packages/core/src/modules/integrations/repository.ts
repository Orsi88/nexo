import type { Sql } from "../../db/database.ts";
import type { SealedSecret } from "../../shared/secret-store.ts";

// Persistência do módulo integrations. Filtra por organization_id (primeira barreira) e roda com
// app.organization_id definido (RLS, segunda barreira). A credencial cifrada só sai por
// getSealedCredential, que é para uso interno do servidor ao chamar o conector.

export type IntegrationStatus = "ok" | "failing" | "unchecked";

export interface ConnectionCheckRecord {
  ok: boolean;
  identity?: string;
  missingPermissions: string[];
  message?: string;
}

/** Visão pública: nunca contém a credencial, nem cifrada. */
export interface Integration {
  id: string;
  organizationId: string;
  kind: string;
  name: string;
  endpoint: string;
  credentialKind: string;
  credentialUpdatedAt: Date;
  status: IntegrationStatus;
  lastCheck: ConnectionCheckRecord | null;
  lastCheckedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

const COLUMNS = `id, organization_id, kind, name, endpoint, credential_kind, credential_updated_at, status, last_check,
  last_checked_at, created_by, created_at, updated_at, archived_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toIntegration = (r: any): Integration => ({
  id: r.id,
  organizationId: r.organization_id,
  kind: r.kind,
  name: r.name,
  endpoint: r.endpoint,
  credentialKind: r.credential_kind,
  credentialUpdatedAt: r.credential_updated_at,
  status: r.status,
  lastCheck: r.last_check,
  lastCheckedAt: r.last_checked_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertIntegration(
  sql: Sql,
  input: {
    id: string;
    organizationId: string;
    kind: string;
    name: string;
    endpoint: string;
    credentialKind: string;
    credential: SealedSecret;
    check: ConnectionCheckRecord;
    createdBy: string;
  },
): Promise<Integration> {
  const { rows } = await sql.query(
    `INSERT INTO integrations_integrations
       (id, organization_id, kind, name, endpoint, credential_kind, credential, status, last_check, last_checked_at, created_by)
     VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
     RETURNING ${COLUMNS}`,
    [
      input.organizationId,
      input.kind,
      input.name,
      input.endpoint,
      input.credentialKind,
      JSON.stringify(input.credential),
      input.check.ok ? "ok" : "failing",
      JSON.stringify(input.check),
      input.createdBy,
      input.id,
    ],
  );
  return toIntegration(rows[0]);
}

export async function listIntegrations(sql: Sql, organizationId: string, includeArchived = false): Promise<Integration[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM integrations_integrations
      WHERE organization_id = $1 AND ($2 OR archived_at IS NULL)
      ORDER BY lower(name)`,
    [organizationId, includeArchived],
  );
  return rows.map(toIntegration);
}

export async function getIntegration(sql: Sql, organizationId: string, id: string): Promise<Integration | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM integrations_integrations WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toIntegration(rows[0]) : undefined;
}

export async function getIntegrationByName(sql: Sql, organizationId: string, name: string): Promise<Integration | undefined> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM integrations_integrations
      WHERE organization_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
    [organizationId, name],
  );
  return rows[0] ? toIntegration(rows[0]) : undefined;
}

/** Só para o servidor montar o ConnectionContext; nunca devolver em resposta. */
export async function getSealedCredential(sql: Sql, organizationId: string, id: string): Promise<SealedSecret | undefined> {
  const { rows } = await sql.query<{ credential: SealedSecret }>(
    `SELECT credential FROM integrations_integrations WHERE organization_id = $1 AND id = $2`,
    [organizationId, id],
  );
  return rows[0]?.credential;
}

export async function updateIntegration(
  sql: Sql,
  organizationId: string,
  id: string,
  patch: { name?: string; credential?: SealedSecret; check?: ConnectionCheckRecord; archived?: boolean },
): Promise<Integration | undefined> {
  const { rows } = await sql.query(
    `UPDATE integrations_integrations SET
        name = COALESCE($3, name),
        credential = COALESCE($4::jsonb, credential),
        credential_updated_at = CASE WHEN $4::jsonb IS NULL THEN credential_updated_at ELSE now() END,
        status = CASE WHEN $5::jsonb IS NULL THEN status WHEN ($5::jsonb ->> 'ok')::boolean THEN 'ok' ELSE 'failing' END,
        last_check = COALESCE($5::jsonb, last_check),
        last_checked_at = CASE WHEN $5::jsonb IS NULL THEN last_checked_at ELSE now() END,
        archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN COALESCE(archived_at, now()) ELSE NULL END,
        updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [
      organizationId,
      id,
      patch.name ?? null,
      patch.credential ? JSON.stringify(patch.credential) : null,
      patch.check ? JSON.stringify(patch.check) : null,
      patch.archived ?? null,
    ],
  );
  return rows[0] ? toIntegration(rows[0]) : undefined;
}
