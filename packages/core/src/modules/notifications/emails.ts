import type { Sql } from "../../db/database.ts";

// Fila de saída de e-mails com histórico de envio e falhas (RF-126, RF-130). Uma linha por
// destinatário. Linha sem organização (redefinição de senha da instância) só é visível numa
// transação também sem organização (política de RLS da migração 0008).

export type EmailKind = "rule" | "invite" | "password-reset" | "test";
export type EmailStatus = "pending" | "sent" | "failed";

export interface OutgoingEmail {
  id: string;
  organizationId: string | null;
  kind: EmailKind;
  recipient: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  ruleId: string | null;
  executionId: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export type EmailHistoryItem = Omit<OutgoingEmail, "bodyText" | "bodyHtml">;

const COLUMNS = `id, organization_id, kind, recipient, subject, body_text, body_html, status, attempts, last_error, rule_id, execution_id, created_at, sent_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toEmail = (r: any): OutgoingEmail => ({
  id: r.id,
  organizationId: r.organization_id,
  kind: r.kind,
  recipient: r.recipient,
  subject: r.subject,
  bodyText: r.body_text,
  bodyHtml: r.body_html,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  ruleId: r.rule_id,
  executionId: r.execution_id,
  createdAt: r.created_at,
  sentAt: r.sent_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface NewEmail {
  organizationId: string | null;
  kind: EmailKind;
  recipient: string;
  subject: string;
  text: string;
  html?: string;
  ruleId?: string;
  executionId?: string;
}

/** Grava o e-mail; devolve undefined se a mesma regra já mandou para esse destinatário nessa execução. */
export async function insertEmail(sql: Sql, e: NewEmail): Promise<OutgoingEmail | undefined> {
  const { rows } = await sql.query(
    `INSERT INTO notifications_emails (organization_id, kind, recipient, subject, body_text, body_html, rule_id, execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (rule_id, execution_id, recipient) WHERE rule_id IS NOT NULL DO NOTHING
     RETURNING ${COLUMNS}`,
    [e.organizationId, e.kind, e.recipient.slice(0, 254), e.subject.slice(0, 300), e.text, e.html ?? null, e.ruleId ?? null, e.executionId ?? null],
  );
  return rows[0] ? toEmail(rows[0]) : undefined;
}

export async function getEmail(sql: Sql, id: string): Promise<OutgoingEmail | undefined> {
  const { rows } = await sql.query(`SELECT ${COLUMNS} FROM notifications_emails WHERE id = $1`, [id]);
  return rows[0] ? toEmail(rows[0]) : undefined;
}

/** Enviado. Convite e redefinição levam link de uso único: o corpo é apagado. */
export async function markSent(sql: Sql, id: string, clearBody: boolean): Promise<void> {
  await sql.query(
    `UPDATE notifications_emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL,
            body_text = CASE WHEN $2 THEN NULL ELSE body_text END, body_html = CASE WHEN $2 THEN NULL ELSE body_html END
      WHERE id = $1`,
    [id, clearBody],
  );
}

export async function markAttempt(sql: Sql, id: string, error: string, final: boolean): Promise<void> {
  await sql.query(
    `UPDATE notifications_emails SET attempts = attempts + 1, last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END,
            body_text = CASE WHEN $3 AND kind IN ('invite', 'password-reset') THEN NULL ELSE body_text END,
            body_html = CASE WHEN $3 AND kind IN ('invite', 'password-reset') THEN NULL ELSE body_html END
      WHERE id = $1`,
    [id, error.slice(0, 500), final],
  );
}

/** Histórico de envios, sem o corpo (RF-130). */
export async function listEmails(sql: Sql, organizationId: string, limit = 100): Promise<EmailHistoryItem[]> {
  const { rows } = await sql.query(
    `SELECT ${COLUMNS} FROM notifications_emails WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [organizationId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => {
    const item: Partial<OutgoingEmail> = toEmail(r);
    delete item.bodyText;
    delete item.bodyHtml;
    return item as EmailHistoryItem;
  });
}

/** Retenção: apaga o histórico antigo de uma organização. */
export async function purgeEmails(sql: Sql, organizationId: string, olderThan: Date): Promise<number> {
  const res = await sql.query(`DELETE FROM notifications_emails WHERE organization_id = $1 AND created_at < $2 AND status <> 'pending'`, [organizationId, olderThan]);
  return res.rowCount ?? 0;
}
