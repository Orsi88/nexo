import type { Role } from "../modules/access/index.ts";

/**
 * Contexto de tenant obrigatório em toda consulta e mutação (Q-002, RN-002, RNF-007).
 * O banco recebe organizationId em "app.organization_id" para as políticas de RLS (ADR-003).
 */
export interface TenantContext {
  organizationId: string;
  userId: string;
  role: Role;
  correlationId: string;
}
