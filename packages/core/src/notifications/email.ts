import type { Database, Sql } from "../db/database.ts";
import { DomainError } from "../shared/errors.ts";
import type { Job } from "../shared/job-queue.ts";
import { enqueueJob } from "../shared/pg-job-queue.ts";
import { JOBS } from "../execution/jobs.ts";
import { emails, type EmailHistoryItem, type NewEmail } from "../modules/notifications/index.ts";
import type { Actor, FoundationService, RequestMeta } from "../foundation/service.ts";
import { recordAudit } from "../modules/audit/index.ts";

// E-mail (incremento 7, RF-126–130, CA-018; ADR-015). Quem envia é o SMTP da própria instalação
// (self-hosted): a plataforma não tem servidor de e-mail próprio. O caso de uso só grava na fila de
// saída, na mesma transação do fato que gerou o e-mail; o worker envia, com novas tentativas, e o
// histórico fica consultável. Sem SMTP configurado, nada entra na fila e as telas dizem isso.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Quem entrega de fato. O worker usa SMTP (nodemailer); os testes usam uma lista em memória. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const EMAIL_ATTEMPTS = 5;

/** Grava na fila de saída e agenda o envio, na transação do chamador (outbox). */
export async function queueEmail(sql: Sql, e: NewEmail): Promise<string | undefined> {
  const row = await emails.insertEmail(sql, e);
  if (!row) return undefined;
  await enqueueJob(sql, JOBS.email, { emailId: row.id }, { ...(e.organizationId ? { organizationId: e.organizationId } : {}), retryLimit: EMAIL_ATTEMPTS });
  return row.id;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Corpo HTML simples e legível em qualquer cliente: parágrafos e um botão de link. */
export function simpleHtml(paragraphs: string[], link?: { url: string; label: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  const button = link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(link.url)}" style="background:#5b8cff;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>`
    : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1d2433;max-width:560px">${body}${button}<p style="color:#7a8396;font-size:12px">Enviado pelo Nexo.</p></div>`;
}

/** Roda no worker: envia um e-mail da fila. Erro passageiro tenta de novo; na última, marca falha. */
export class EmailSender {
  readonly #db: Database;
  readonly #mailer: Mailer;
  readonly #log: ((level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void) | undefined;

  constructor(db: Database, mailer: Mailer, log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void) {
    this.#db = db;
    this.#mailer = mailer;
    this.#log = log;
  }

  async handle(job: Job<{ emailId: string }>): Promise<void> {
    const scope = { organizationId: job.organizationId, userId: null };
    const email = await this.#db.tx(scope, (sql) => emails.getEmail(sql, job.payload.emailId));
    if (!email || email.status !== "pending" || !email.bodyText) return;
    try {
      await this.#mailer.send({ to: email.recipient, subject: email.subject, text: email.bodyText, ...(email.bodyHtml ? { html: email.bodyHtml } : {}) });
    } catch (error) {
      const final = job.attempt >= EMAIL_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      await this.#db.tx(scope, (sql) => emails.markAttempt(sql, email.id, message, final));
      this.#log?.(final ? "error" : "warn", "e-mail não enviado", { emailId: email.id, kind: email.kind, attempt: job.attempt, error: message.slice(0, 200) });
      if (!final) throw error;
      return;
    }
    await this.#db.tx(scope, (sql) => emails.markSent(sql, email.id, email.kind === "invite" || email.kind === "password-reset"));
  }
}

/** Casos de uso de e-mail para a API: status, histórico, teste e e-mails de acesso. */
export class EmailService {
  readonly #db: Database;
  readonly #foundation: FoundationService;
  /** SMTP configurado nesta instalação (SMTP_URL). */
  readonly enabled: boolean;

  constructor(db: Database, foundation: FoundationService, enabled: boolean) {
    this.#db = db;
    this.#foundation = foundation;
    this.enabled = enabled;
  }

  async history(actor: Actor, limit?: number): Promise<EmailHistoryItem[]> {
    const a = await this.#foundation.authorize(actor, "configurePipelines");
    return this.#db.tx({ organizationId: a.organization.id, userId: a.user.id }, (sql) => emails.listEmails(sql, a.organization.id, limit));
  }

  /** Manda um e-mail de teste para a própria pessoa, para conferir o SMTP. */
  async sendTest(actor: Actor, meta: RequestMeta): Promise<void> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "email.test");
    this.#requireEnabled();
    await this.#db.tx({ organizationId: a.organization.id, userId: a.user.id }, async (sql) => {
      const text = `Este é um e-mail de teste do Nexo (${a.organization.name}). Se ele chegou, o envio de e-mails está funcionando.`;
      await queueEmail(sql, { organizationId: a.organization.id, kind: "test", recipient: a.user.email, subject: "Nexo: e-mail de teste", text, html: simpleHtml([text]) });
      await recordAudit(sql, {
        organizationId: a.organization.id,
        actorUserId: a.user.id,
        action: "email.test",
        targetType: "email",
        outcome: "success",
        correlationId: meta.correlationId,
      });
    });
  }

  /**
   * Convite ou redefinição de senha por e-mail (ADR-011 previa: o mesmo token passa a ir por e-mail).
   * O link continua sendo mostrado a quem gerou, para o caso de o e-mail não chegar.
   */
  async sendAccessLink(input: { kind: "invite" | "password-reset"; organizationId: string | null; organizationName?: string; to: string; url: string; expiresAt: Date }): Promise<boolean> {
    if (!this.enabled) return false;
    const until = input.expiresAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
    const invite = input.kind === "invite";
    const lines = invite
      ? [`Você foi convidado(a) para ${input.organizationName ? `a organização ${input.organizationName} no` : "o"} Nexo.`, `Pelo link, você define a sua senha e entra. Ele vale uma vez, até ${until} (UTC).`]
      : ["Foi pedida a redefinição da sua senha no Nexo.", `Pelo link, você define uma senha nova. Ele vale uma vez, até ${until} (UTC). Se não foi você, ignore este e-mail.`];
    await this.#db.tx({ organizationId: input.organizationId, userId: null }, (sql) =>
      queueEmail(sql, {
        organizationId: input.organizationId,
        kind: input.kind,
        recipient: input.to,
        subject: invite ? "Convite para o Nexo" : "Redefinir senha do Nexo",
        text: `${lines.join("\n\n")}\n\n${input.url}`,
        html: simpleHtml(lines, { url: input.url, label: invite ? "Aceitar convite" : "Definir senha nova" }),
      }),
    );
    return true;
  }

  #requireEnabled(): void {
    if (!this.enabled) throw new DomainError("conflict", "O envio de e-mails não está configurado nesta instalação (SMTP_URL).");
  }
}
