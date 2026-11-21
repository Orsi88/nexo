import type { Sql } from "../../db/database.ts";
import type { ShareOptions } from "./projection.ts";

// Persistência dos links compartilhados. Só o hash SHA-256 do token fica no banco.

export type ShareScope = "execution" | "pipeline";
export type ShareAccess = "public" | "members";

export interface ShareLink {
  id: string;
  scope: ShareScope;
  pipelineId: string;
  executionId: string | null;
  access: ShareAccess;
  title: string;
  options: ShareOptions;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  viewCount: number;
  lastViewedAt: Date | null;
}

const COLUMNS = `id, scope, pipeline_id, execution_id, access, title, options, expires_at, created_by, created_at, revoked_at, revoked_by, view_count, last_viewed_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toLink = (r: any): ShareLink => ({
  id: r.id,
  scope: r.scope,
  pipelineId: r.pipeline_id,
  executionId: r.execution_id,
  access: r.access,
  title: r.title,
  options: r.options,
  expiresAt: r.expires_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
  viewCount: r.view_count,
  lastViewedAt: r.last_viewed_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertLink(
  sql: Sql,
  organizationId: string,
  l: { tokenHash: Buffer; scope: ShareScope; pipelineId: string; executionId: string | null; access: ShareAccess; title: string; options: ShareOptions; expiresAt: Date; createdBy: string },
): Promise<ShareLink> {
  const { rows } = await sql.query(
    `INSERT INTO sharing_links (organization_id, token_hash, scope, pipeline_id, execution_id, access, title, options, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
    [organizationId, l.tokenHash, l.scope, l.pipelineId, l.executionId, l.access, l.title.slice(0, 200), JSON.stringify(l.options), l.expiresAt, l.createdBy],
  );
  return toLink(rows[0]);
}

export async function listLinks(sql: Sql, organizationId: string, filter: { pipelineId?: string; executionId?: string } = {}): Promise<ShareLink[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM sharing_links
     WHERE organization_id = $1 AND ($2::uuid IS NULL OR pipeline_id = $2) AND ($3::uuid IS NULL OR execution_id = $3)
     ORDER BY created_at DESC LIMIT 200`,
    [organizationId, filter.pipelineId ?? null, filter.executionId ?? null],
  );
  return rows.map(toLink);
}

export async function getLink(sql: Sql, organizationId: string, id: string): Promise<ShareLink | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM sharing_links WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? toLink(rows[0]) : undefined;
}

export async function getLinkByHash(sql: Sql, organizationId: string, tokenHash: Buffer): Promise<ShareLink | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM sharing_links WHERE organization_id = $1 AND token_hash = $2`, [organizationId, tokenHash]);
  return rows[0] ? toLink(rows[0]) : undefined;
}

/** Organização dona do link (função SECURITY DEFINER: o visitante não tem organização). */
export async function organizationOf(sql: Sql, tokenHash: Buffer): Promise<string | undefined> {
  const { rows } = await sql.query<{ org: string | null }>(`SELECT sharing_link_organization($1) AS org`, [tokenHash]);
  return rows[0]?.org ?? undefined;
}

export async function revokeLink(sql: Sql, organizationId: string, id: string, userId: string): Promise<ShareLink | undefined> {
  const { rows } = await sql.query(
    `UPDATE sharing_links SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $3)
     WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [organizationId, id, userId],
  );
  return rows[0] ? toLink(rows[0]) : undefined;
}

export async function touchView(sql: Sql, organizationId: string, id: string): Promise<void> {
  await sql.query(`UPDATE sharing_links SET view_count = view_count + 1, last_viewed_at = now() WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
}
