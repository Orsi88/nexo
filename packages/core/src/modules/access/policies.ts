import type { Sql } from "../../db/database.ts";
import { OPERATIONS, ROLE_MATRIX, ROLES, type OrganizationPolicy, type Operation, type Role } from "./index.ts";

// Concessões "conforme política" do §6, guardadas por organização em access_policies.

export async function getPolicy(sql: Sql, organizationId: string): Promise<OrganizationPolicy> {
  const { rows } = await sql.query<{ grants: OrganizationPolicy }>(
    `SELECT grants FROM access_policies WHERE organization_id = $1`,
    [organizationId],
  );
  return sanitizePolicy(rows[0]?.grants ?? {});
}

export async function savePolicy(sql: Sql, organizationId: string, policy: OrganizationPolicy, updatedBy: string): Promise<OrganizationPolicy> {
  const clean = sanitizePolicy(policy);
  await sql.query(
    `INSERT INTO access_policies (organization_id, grants, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id) DO UPDATE SET grants = EXCLUDED.grants, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [organizationId, JSON.stringify(clean), updatedBy],
  );
  return clean;
}

/** Mantém só operações marcadas como "policy" na matriz para aquele papel; o resto é ignorado. */
export function sanitizePolicy(input: unknown): OrganizationPolicy {
  const out: OrganizationPolicy = {};
  if (typeof input !== "object" || input === null) return out;
  for (const role of ROLES) {
    const ops = (input as Record<string, unknown>)[role];
    if (!Array.isArray(ops)) continue;
    const allowed = [...new Set(ops)].filter(
      (op): op is Operation => (OPERATIONS as readonly unknown[]).includes(op) && ROLE_MATRIX[role as Role][op as Operation] === "policy",
    );
    if (allowed.length) out[role] = allowed.sort();
  }
  return out;
}
