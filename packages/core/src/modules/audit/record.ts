import type { Sql } from "../../db/database.ts";

// Auditoria append-only (RN-020, RNF-021): autor, ação, alvo, resultado e correlação.
// Nunca recebe segredos, senhas ou tokens em `details` (RNF-033).

export type AuditActorKind = "user" | "system" | "share-link" | "assist";
export type AuditOutcome = "success" | "denied" | "failed";

export interface AuditEventInput {
  /** null = evento da instância (login, administração da instância). */
  organizationId: string | null;
  actorUserId: string | null;
  actorKind?: AuditActorKind;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome: AuditOutcome;
  correlationId: string;
  details?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: AuditOutcome;
  correlationId: string;
  details: Record<string, unknown>;
  occurredAt: Date;
}

const FORBIDDEN_KEYS = /pass(word)?|secret|token|credential|authorization|cookie|hash/i;

/** Remove chaves com cara de segredo, como segunda proteção contra descuidos. */
export function scrubDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    out[key] = value !== null && typeof value === "object" && !Array.isArray(value) ? scrubDetails(value as Record<string, unknown>) : value;
  }
  return out;
}

/**
 * Grava o evento. Para gravar na organização X, a transação precisa estar no contexto de X (RLS).
 * Eventos de instância (organizationId null) podem ser gravados em qualquer contexto.
 */
export async function recordAudit(sql: Sql, e: AuditEventInput): Promise<void> {
  await sql.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, actor_kind, action, target_type, target_id, outcome, correlation_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.organizationId,
      e.actorUserId,
      e.actorKind ?? (e.actorUserId ? "user" : "system"),
      e.action,
      e.targetType,
      e.targetId ?? null,
      e.outcome,
      e.correlationId,
      JSON.stringify(scrubDetails(e.details)),
    ],
  );
}

export interface AuditQuery {
  action?: string;
  actorUserId?: string;
  outcome?: AuditOutcome;
  since?: Date;
  until?: Date;
  /** Paginação por id decrescente: devolve eventos com id menor que `before`. */
  before?: string;
  limit?: number;
}

export async function listAudit(sql: Sql, organizationId: string, q: AuditQuery = {}): Promise<AuditEvent[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const { rows } = await sql.query(
    `SELECT * FROM audit_events
      WHERE organization_id = $1
        AND ($2::text IS NULL OR action = $2) AND ($3::uuid IS NULL OR actor_user_id = $3::uuid)
        AND ($4::text IS NULL OR outcome = $4) AND ($5::timestamptz IS NULL OR occurred_at >= $5)
        AND ($6::timestamptz IS NULL OR occurred_at < $6) AND ($7::bigint IS NULL OR id < $7::bigint)
      ORDER BY id DESC LIMIT $8`,
    [organizationId, q.action ?? null, q.actorUserId ?? null, q.outcome ?? null, q.since ?? null, q.until ?? null, q.before ?? null, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    organizationId: r.organization_id,
    actorUserId: r.actor_user_id,
    actorKind: r.actor_kind,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    outcome: r.outcome,
    correlationId: r.correlation_id,
    details: r.details,
    occurredAt: r.occurred_at,
  }));
}
