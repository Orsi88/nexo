import type { Sql } from "../../db/database.ts";
import type { Role } from "../access/index.ts";

// Persistência do módulo tenancy. Toda consulta filtra por organization_id explicitamente
// (primeira barreira) e roda numa transação com app.organization_id definido (RLS, segunda barreira).

export interface Organization {
  id: string;
  slug: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Membership {
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFilter {
  /** Busca por parte do nome, sem diferenciar maiúsculas (RF-007). */
  q?: string;
  includeArchived?: boolean;
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const like = (q: string | undefined) => (q && q.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c)}%` : null);

/* eslint-disable @typescript-eslint/no-explicit-any */
const toOrg = (r: any): Organization => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toWorkspace = (r: any): Workspace => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toProject = (r: any): Project => ({
  id: r.id,
  organizationId: r.organization_id,
  workspaceId: r.workspace_id,
  name: r.name,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toMembership = (r: any): Membership => ({
  organizationId: r.organization_id,
  userId: r.user_id,
  role: r.role,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Organizações ----------

/** O chamador define app.organization_id = id antes (a política de RLS exige). */
export async function insertOrganization(sql: Sql, input: { id: string; slug: string; name: string }): Promise<Organization> {
  const { rows } = await sql.query(`INSERT INTO tenancy_organizations (id, slug, name) VALUES ($1, $2, $3) RETURNING *`, [
    input.id,
    input.slug,
    input.name.trim(),
  ]);
  return toOrg(rows[0]);
}

export async function getOrganization(sql: Sql, id: string): Promise<Organization | undefined> {
  const { rows } = await sql.query(`SELECT * FROM tenancy_organizations WHERE id = $1`, [id]);
  return rows[0] && toOrg(rows[0]);
}

export async function updateOrganization(sql: Sql, id: string, input: { name: string }): Promise<Organization | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_organizations SET name = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, input.name.trim()],
  );
  return rows[0] && toOrg(rows[0]);
}

export async function setOrganizationArchived(sql: Sql, id: string, archived: boolean): Promise<Organization | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_organizations SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, archived],
  );
  return rows[0] && toOrg(rows[0]);
}

/**
 * Organizações de que o usuário participa, com o papel dele em cada uma (RF-005, CA-024).
 * Exige app.user_id = userId na transação: as políticas own_memberships/member_organizations liberam.
 */
export async function listOrganizationsOfUser(
  sql: Sql,
  userId: string,
  filter: ListFilter = {},
): Promise<Array<Organization & { role: Role }>> {
  const { rows } = await sql.query(
    `SELECT o.*, m.role FROM tenancy_memberships m JOIN tenancy_organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND ($2::boolean OR o.archived_at IS NULL)
        AND ($3::text IS NULL OR lower(o.name) LIKE $3 OR o.slug LIKE $3)
      ORDER BY lower(o.name)`,
    [userId, filter.includeArchived ?? false, like(filter.q)],
  );
  return rows.map((r) => ({ ...toOrg(r), role: r.role }));
}

// ---------- Workspaces ----------

export async function listWorkspaces(sql: Sql, organizationId: string, filter: ListFilter = {}): Promise<Workspace[]> {
  const { rows } = await sql.query(
    `SELECT * FROM tenancy_workspaces
      WHERE organization_id = $1 AND ($2::boolean OR archived_at IS NULL) AND ($3::text IS NULL OR lower(name) LIKE $3)
      ORDER BY lower(name)`,
    [organizationId, filter.includeArchived ?? false, like(filter.q)],
  );
  return rows.map(toWorkspace);
}

export async function getWorkspace(sql: Sql, organizationId: string, id: string): Promise<Workspace | undefined> {
  const { rows } = await sql.query(`SELECT * FROM tenancy_workspaces WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] && toWorkspace(rows[0]);
}

export async function insertWorkspace(sql: Sql, organizationId: string, name: string): Promise<Workspace> {
  const { rows } = await sql.query(`INSERT INTO tenancy_workspaces (organization_id, name) VALUES ($1, $2) RETURNING *`, [
    organizationId,
    name.trim(),
  ]);
  return toWorkspace(rows[0]);
}

export async function updateWorkspace(sql: Sql, organizationId: string, id: string, name: string): Promise<Workspace | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_workspaces SET name = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, name.trim()],
  );
  return rows[0] && toWorkspace(rows[0]);
}

export async function setWorkspaceArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<Workspace | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_workspaces SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, archived],
  );
  return rows[0] && toWorkspace(rows[0]);
}

export async function countActiveProjects(sql: Sql, organizationId: string, workspaceId: string): Promise<number> {
  const { rows } = await sql.query<{ n: string }>(
    `SELECT count(*) AS n FROM tenancy_projects WHERE organization_id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
    [organizationId, workspaceId],
  );
  return Number(rows[0]!.n);
}

// ---------- Projetos ----------

export async function listProjects(
  sql: Sql,
  organizationId: string,
  filter: ListFilter & { workspaceId?: string } = {},
): Promise<Project[]> {
  const { rows } = await sql.query(
    `SELECT * FROM tenancy_projects
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
        AND ($3::boolean OR archived_at IS NULL) AND ($4::text IS NULL OR lower(name) LIKE $4)
      ORDER BY lower(name)`,
    [organizationId, filter.workspaceId ?? null, filter.includeArchived ?? false, like(filter.q)],
  );
  return rows.map(toProject);
}

export async function getProject(sql: Sql, organizationId: string, id: string): Promise<Project | undefined> {
  const { rows } = await sql.query(`SELECT * FROM tenancy_projects WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] && toProject(rows[0]);
}

export async function insertProject(sql: Sql, organizationId: string, workspaceId: string, name: string): Promise<Project> {
  const { rows } = await sql.query(
    `INSERT INTO tenancy_projects (organization_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING *`,
    [organizationId, workspaceId, name.trim()],
  );
  return toProject(rows[0]);
}

export async function updateProject(
  sql: Sql,
  organizationId: string,
  id: string,
  input: { name?: string; workspaceId?: string },
): Promise<Project | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_projects SET name = coalesce($3, name), workspace_id = coalesce($4::uuid, workspace_id), updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, input.name?.trim() ?? null, input.workspaceId ?? null],
  );
  return rows[0] && toProject(rows[0]);
}

export async function setProjectArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<Project | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_projects SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, archived],
  );
  return rows[0] && toProject(rows[0]);
}

// ---------- Membros ----------

export async function getMembership(sql: Sql, organizationId: string, userId: string): Promise<Membership | undefined> {
  const { rows } = await sql.query(`SELECT * FROM tenancy_memberships WHERE organization_id = $1 AND user_id = $2`, [
    organizationId,
    userId,
  ]);
  return rows[0] && toMembership(rows[0]);
}

export async function listMemberships(sql: Sql, organizationId: string): Promise<Membership[]> {
  const { rows } = await sql.query(`SELECT * FROM tenancy_memberships WHERE organization_id = $1 ORDER BY created_at`, [organizationId]);
  return rows.map(toMembership);
}

export async function insertMembership(sql: Sql, organizationId: string, userId: string, role: Role): Promise<Membership> {
  const { rows } = await sql.query(
    `INSERT INTO tenancy_memberships (organization_id, user_id, role) VALUES ($1, $2, $3) RETURNING *`,
    [organizationId, userId, role],
  );
  return toMembership(rows[0]);
}

export async function updateMembershipRole(sql: Sql, organizationId: string, userId: string, role: Role): Promise<Membership | undefined> {
  const { rows } = await sql.query(
    `UPDATE tenancy_memberships SET role = $3, updated_at = now() WHERE organization_id = $1 AND user_id = $2 RETURNING *`,
    [organizationId, userId, role],
  );
  return rows[0] && toMembership(rows[0]);
}

export async function deleteMembership(sql: Sql, organizationId: string, userId: string): Promise<boolean> {
  const { rowCount } = await sql.query(`DELETE FROM tenancy_memberships WHERE organization_id = $1 AND user_id = $2`, [
    organizationId,
    userId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Trava as associações de admin da organização e devolve quantas são (evita ficar sem admin). */
export async function lockAndCountAdmins(sql: Sql, organizationId: string): Promise<number> {
  const { rows } = await sql.query(
    `SELECT user_id FROM tenancy_memberships WHERE organization_id = $1 AND role = 'admin' FOR UPDATE`,
    [organizationId],
  );
  return rows.length;
}
