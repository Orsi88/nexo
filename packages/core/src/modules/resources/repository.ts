import type { Sql } from "../../db/database.ts";

// Persistência do módulo resources: catálogo de recursos executores e leases (ADR-009, FLX-005).
// O índice único resources_one_open_lease garante um lease aberto por recurso, mesmo com várias
// instâncias disputando ao mesmo tempo.

export type BusyPolicy = "queue" | "reject";
export type HolderKind = "internal" | "external";

export interface Resource {
  id: string;
  organizationId: string;
  ref: string;
  name: string;
  description: string | null;
  busyPolicy: BusyPolicy;
  leaseTtlSeconds: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Lease {
  id: string;
  resourceId: string;
  holderKind: HolderKind;
  executionId: string;
  acquiredAt: Date;
  renewedAt: Date;
  expiresAt: Date;
}

const RESOURCE_COLUMNS = `id, organization_id, ref, name, description, busy_policy, lease_ttl_seconds, created_at, updated_at, archived_at`;
const LEASE_COLUMNS = `id, resource_id, holder_kind, execution_id, acquired_at, renewed_at, expires_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toResource = (r: any): Resource => ({
  id: r.id,
  organizationId: r.organization_id,
  ref: r.ref,
  name: r.name,
  description: r.description,
  busyPolicy: r.busy_policy,
  leaseTtlSeconds: r.lease_ttl_seconds,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
const toLease = (r: any): Lease => ({
  id: r.id,
  resourceId: r.resource_id,
  holderKind: r.holder_kind,
  executionId: r.execution_id,
  acquiredAt: r.acquired_at,
  renewedAt: r.renewed_at,
  expiresAt: r.expires_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Catálogo ----------

export async function insertResource(
  sql: Sql,
  input: { organizationId: string; ref: string; name: string; description?: string; busyPolicy: BusyPolicy; leaseTtlSeconds: number; createdBy: string },
): Promise<Resource> {
  const { rows } = await sql.query(
    `INSERT INTO resources_resources (organization_id, ref, name, description, busy_policy, lease_ttl_seconds, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${RESOURCE_COLUMNS}`,
    [input.organizationId, input.ref, input.name, input.description ?? null, input.busyPolicy, input.leaseTtlSeconds, input.createdBy],
  );
  return toResource(rows[0]);
}

export async function updateResource(
  sql: Sql,
  organizationId: string,
  id: string,
  input: { name?: string; description?: string | null; busyPolicy?: BusyPolicy; leaseTtlSeconds?: number },
): Promise<Resource | undefined> {
  const { rows } = await sql.query(
    `UPDATE resources_resources
        SET name = coalesce($3, name),
            description = CASE WHEN $4::boolean THEN $5 ELSE description END,
            busy_policy = coalesce($6, busy_policy),
            lease_ttl_seconds = coalesce($7, lease_ttl_seconds),
            updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING ${RESOURCE_COLUMNS}`,
    [
      organizationId,
      id,
      input.name ?? null,
      input.description !== undefined,
      input.description ?? null,
      input.busyPolicy ?? null,
      input.leaseTtlSeconds ?? null,
    ],
  );
  return rows[0] ? toResource(rows[0]) : undefined;
}

export async function setResourceArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<Resource | undefined> {
  const { rows } = await sql.query(
    `UPDATE resources_resources SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${RESOURCE_COLUMNS}`,
    [organizationId, id, archived],
  );
  return rows[0] ? toResource(rows[0]) : undefined;
}

export async function getResource(sql: Sql, organizationId: string, id: string): Promise<Resource | undefined> {
  const { rows } = await sql.query(`SELECT ${RESOURCE_COLUMNS} FROM resources_resources WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    id,
  ]);
  return rows[0] ? toResource(rows[0]) : undefined;
}

export async function listResources(sql: Sql, organizationId: string, includeArchived = false): Promise<Resource[]> {
  const { rows } = await sql.query(
    `SELECT ${RESOURCE_COLUMNS} FROM resources_resources WHERE organization_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY lower(name)`,
    [organizationId, includeArchived],
  );
  return rows.map(toResource);
}

/** Recursos ativos pelos refs do manifesto (sem diferenciar maiúsculas). */
export async function findByRefs(sql: Sql, organizationId: string, refs: readonly string[]): Promise<Resource[]> {
  if (!refs.length) return [];
  const { rows } = await sql.query(
    `SELECT ${RESOURCE_COLUMNS} FROM resources_resources
      WHERE organization_id = $1 AND archived_at IS NULL AND lower(ref) = ANY($2::text[])`,
    [organizationId, refs.map((r) => r.toLowerCase())],
  );
  return rows.map(toResource);
}

/**
 * Trava as linhas dos recursos, em ordem de id, para serializar quem disputa os mesmos recursos
 * dentro da transação (evita deadlock entre dois pedidos que pegam os recursos em ordens diferentes).
 */
export async function lockResources(sql: Sql, organizationId: string, ids: readonly string[]): Promise<Resource[]> {
  if (!ids.length) return [];
  const { rows } = await sql.query(
    `SELECT ${RESOURCE_COLUMNS} FROM resources_resources WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [organizationId, ids],
  );
  return rows.map(toResource);
}

// ---------- Leases ----------

/** Leases abertos (vencidos ou não) dos recursos. Vencido continua bloqueando até o reconciliador decidir. */
export async function openLeases(sql: Sql, organizationId: string, resourceIds?: readonly string[]): Promise<Lease[]> {
  const { rows } = await sql.query(
    `SELECT ${LEASE_COLUMNS} FROM resources_leases
      WHERE organization_id = $1 AND released_at IS NULL AND ($2::uuid[] IS NULL OR resource_id = ANY($2::uuid[]))`,
    [organizationId, resourceIds ?? null],
  );
  return rows.map(toLease);
}

/**
 * Abre um lease por recurso, tudo ou nada. Chame com os recursos já travados (lockResources) e
 * livres; se outro processo ganhou a corrida, o índice único recusa e devolve undefined.
 */
export async function acquireLeases(
  sql: Sql,
  input: { organizationId: string; resources: readonly Pick<Resource, "id" | "leaseTtlSeconds">[]; executionId: string; holderKind: HolderKind },
): Promise<Lease[] | undefined> {
  const out: Lease[] = [];
  await sql.query("SAVEPOINT acquire_leases");
  for (const r of input.resources) {
    const { rows } = await sql.query(
      `INSERT INTO resources_leases (organization_id, resource_id, holder_kind, execution_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       ON CONFLICT (resource_id) WHERE released_at IS NULL DO NOTHING
       RETURNING ${LEASE_COLUMNS}`,
      [input.organizationId, r.id, input.holderKind, input.executionId, r.leaseTtlSeconds],
    );
    if (!rows[0]) {
      await sql.query("ROLLBACK TO SAVEPOINT acquire_leases");
      return undefined;
    }
    out.push(toLease(rows[0]));
  }
  await sql.query("RELEASE SAVEPOINT acquire_leases");
  return out;
}

/** Renova os leases abertos de uma execução, cada um pela validade do seu recurso. */
export async function renewLeases(sql: Sql, organizationId: string, executionId: string): Promise<number> {
  const { rowCount } = await sql.query(
    `UPDATE resources_leases l SET renewed_at = now(), expires_at = now() + make_interval(secs => r.lease_ttl_seconds)
       FROM resources_resources r
      WHERE l.organization_id = $1 AND l.execution_id = $2 AND l.released_at IS NULL AND r.id = l.resource_id`,
    [organizationId, executionId],
  );
  return rowCount ?? 0;
}

/** Libera os leases de uma execução. Devolve os recursos liberados, para acordar a fila deles. */
export async function releaseLeases(sql: Sql, organizationId: string, executionId: string, reason: string): Promise<string[]> {
  const { rows } = await sql.query<{ resource_id: string }>(
    `UPDATE resources_leases SET released_at = now(), release_reason = $3
      WHERE organization_id = $1 AND execution_id = $2 AND released_at IS NULL
      RETURNING resource_id`,
    [organizationId, executionId, reason],
  );
  return rows.map((r) => r.resource_id);
}

/** Leases vencidos sem renovação (RF-060): o reconciliador consulta o provedor antes de liberar. */
export async function expiredLeases(sql: Sql, organizationId: string): Promise<Lease[]> {
  const { rows } = await sql.query(
    `SELECT ${LEASE_COLUMNS} FROM resources_leases WHERE organization_id = $1 AND released_at IS NULL AND expires_at < now()`,
    [organizationId],
  );
  return rows.map(toLease);
}
