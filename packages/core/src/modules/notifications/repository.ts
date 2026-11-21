import type { ExecutionStatus } from "@painel/contracts";
import type { Sql } from "../../db/database.ts";
import type { Channel, Condition, Severity } from "./rules.ts";

// Persistência do módulo notifications: regras de evento e avisos gerados por elas.

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  pipelineId: string | null;
  onStatus: ExecutionStatus[];
  conditions: Condition[];
  severity: Severity;
  title: string;
  message: string;
  channels: Channel[];
  /** E-mails que recebem o aviso quando o canal "email" está ligado (RF-127). */
  recipients: string[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Alert {
  id: string;
  ruleId: string;
  executionId: string;
  pipelineId: string;
  severity: Severity;
  title: string;
  message: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

const RULE_COLUMNS = `id, name, enabled, pipeline_id, on_status, conditions, severity, title, message, channels, recipients, created_at, updated_at, archived_at`;
const ALERT_COLUMNS = `id, rule_id, execution_id, pipeline_id, severity, title, message, created_at, resolved_at, resolved_by, resolution_note`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toRule = (r: any): NotificationRule => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  pipelineId: r.pipeline_id,
  onStatus: r.on_status,
  conditions: r.conditions,
  severity: r.severity,
  title: r.title,
  message: r.message,
  channels: r.channels,
  recipients: r.recipients ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
const toAlert = (r: any): Alert => ({
  id: r.id,
  ruleId: r.rule_id,
  executionId: r.execution_id,
  pipelineId: r.pipeline_id,
  severity: r.severity,
  title: r.title,
  message: r.message,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  resolutionNote: r.resolution_note,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export type RuleFields = Pick<NotificationRule, "name" | "enabled" | "pipelineId" | "onStatus" | "conditions" | "severity" | "title" | "message" | "channels" | "recipients">;

export async function insertRule(sql: Sql, organizationId: string, f: RuleFields, createdBy: string): Promise<NotificationRule> {
  const { rows } = await sql.query(
    `INSERT INTO notifications_rules (organization_id, name, enabled, pipeline_id, on_status, conditions, severity, title, message, channels, recipients, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${RULE_COLUMNS}`,
    [organizationId, f.name, f.enabled, f.pipelineId, f.onStatus, JSON.stringify(f.conditions), f.severity, f.title, f.message, f.channels, f.recipients, createdBy],
  );
  return toRule(rows[0]);
}

export async function updateRule(sql: Sql, organizationId: string, id: string, f: RuleFields): Promise<NotificationRule | undefined> {
  const { rows } = await sql.query(
    `UPDATE notifications_rules SET name = $3, enabled = $4, pipeline_id = $5, on_status = $6, conditions = $7, severity = $8,
            title = $9, message = $10, channels = $11, recipients = $12, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${RULE_COLUMNS}`,
    [organizationId, id, f.name, f.enabled, f.pipelineId, f.onStatus, JSON.stringify(f.conditions), f.severity, f.title, f.message, f.channels, f.recipients],
  );
  return rows[0] ? toRule(rows[0]) : undefined;
}

export async function setRuleArchived(sql: Sql, organizationId: string, id: string, archived: boolean): Promise<NotificationRule | undefined> {
  const { rows } = await sql.query(
    `UPDATE notifications_rules SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${RULE_COLUMNS}`,
    [organizationId, id, archived],
  );
  return rows[0] ? toRule(rows[0]) : undefined;
}

export async function getRule(sql: Sql, organizationId: string, id: string): Promise<NotificationRule | undefined> {
  const { rows } = await sql.query(`SELECT ${RULE_COLUMNS} FROM notifications_rules WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] ? toRule(rows[0]) : undefined;
}

export async function listRules(sql: Sql, organizationId: string, f: { pipelineId?: string; includeArchived?: boolean } = {}): Promise<NotificationRule[]> {
  const { rows } = await sql.query(
    `SELECT ${RULE_COLUMNS} FROM notifications_rules
      WHERE organization_id = $1 AND ($2 OR archived_at IS NULL)
        AND ($3::uuid IS NULL OR pipeline_id = $3::uuid OR pipeline_id IS NULL)
      ORDER BY lower(name)`,
    [organizationId, f.includeArchived ?? false, f.pipelineId ?? null],
  );
  return rows.map(toRule);
}

/** Regras ativas que podem valer para a pipeline (as dela e as de "qualquer pipeline"). */
export async function activeRulesFor(sql: Sql, organizationId: string, pipelineId: string): Promise<NotificationRule[]> {
  const { rows } = await sql.query(
    `SELECT ${RULE_COLUMNS} FROM notifications_rules
      WHERE organization_id = $1 AND archived_at IS NULL AND enabled AND (pipeline_id IS NULL OR pipeline_id = $2)`,
    [organizationId, pipelineId],
  );
  return rows.map(toRule);
}

/** Cria o aviso, uma vez por regra e execução. Devolve undefined se já existia. */
export async function insertAlert(
  sql: Sql,
  organizationId: string,
  a: Pick<Alert, "ruleId" | "executionId" | "pipelineId" | "severity" | "title" | "message">,
): Promise<Alert | undefined> {
  const { rows } = await sql.query(
    `INSERT INTO notifications_alerts (organization_id, rule_id, execution_id, pipeline_id, severity, title, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (rule_id, execution_id) DO NOTHING
     RETURNING ${ALERT_COLUMNS}`,
    [organizationId, a.ruleId, a.executionId, a.pipelineId, a.severity, a.title, a.message],
  );
  return rows[0] ? toAlert(rows[0]) : undefined;
}

export async function listAlerts(sql: Sql, organizationId: string, f: { open?: boolean; pipelineId?: string; limit?: number } = {}): Promise<Alert[]> {
  const { rows } = await sql.query(
    `SELECT ${ALERT_COLUMNS} FROM notifications_alerts
      WHERE organization_id = $1 AND (NOT $2 OR resolved_at IS NULL) AND ($3::uuid IS NULL OR pipeline_id = $3::uuid)
      ORDER BY created_at DESC LIMIT $4`,
    [organizationId, f.open ?? false, f.pipelineId ?? null, Math.min(f.limit ?? 100, 500)],
  );
  return rows.map(toAlert);
}

export async function resolveAlert(sql: Sql, organizationId: string, id: string, userId: string, note: string | null): Promise<Alert | undefined> {
  const { rows } = await sql.query(
    `UPDATE notifications_alerts SET resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, $3),
            resolution_note = coalesce(resolution_note, $4)
      WHERE organization_id = $1 AND id = $2 RETURNING ${ALERT_COLUMNS}`,
    [organizationId, id, userId, note],
  );
  return rows[0] ? toAlert(rows[0]) : undefined;
}
