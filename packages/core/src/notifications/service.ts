import type { Database, Sql } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import { publishEvent } from "../shared/events.ts";
import { recordAudit, type AuditEventInput } from "../modules/audit/index.ts";
import { executions, isFinal, type Execution } from "../modules/execution/index.ts";
import { results } from "../modules/results/index.ts";
import { queueEmail, simpleHtml } from "./email.ts";
import {
  notifications,
  renderMessage,
  RULE_STATUSES,
  ruleMatches,
  type Alert,
  type Channel,
  type Condition,
  type NotificationRule,
  type RuleFields,
  type Severity,
} from "../modules/notifications/index.ts";
import { pipelines } from "../modules/pipelines/index.ts";
import type { Actor, FoundationService, OrgActor, RequestMeta } from "../foundation/service.ts";

// Regras de evento e avisos (RF-126–130). Uma regra diz: quando uma execução (de uma pipeline ou de
// qualquer uma) terminar com certo resultado e com certos valores de parâmetros, criar um aviso com
// esta mensagem. O aviso fica aberto até alguém marcar como resolvido. O e-mail entra no
// incremento 7; a avaliação nunca bloqueia a conclusão da execução (RN-019), porque roda num job.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];

export interface AlertView extends Alert {
  pipelineName: string;
}

function text(value: unknown, what: string, max: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new DomainError("invalid", `Informe ${what}.`);
  if (v.length > max) throw new DomainError("invalid", `${what[0]!.toUpperCase()}${what.slice(1)} pode ter no máximo ${max} caracteres.`);
  return v;
}

/** Valida e normaliza os campos de uma regra vindos da API. */
export function parseRuleFields(input: Record<string, unknown>): RuleFields {
  const name = text(input.name, "o nome da regra", 120);
  const title = text(input.title, "o título do aviso", 120);
  const message = text(input.message, "a mensagem do aviso", 1000);
  const enabled = input.enabled === undefined ? true : input.enabled === true;
  let pipelineId: string | null = null;
  if (input.pipelineId !== undefined && input.pipelineId !== null && input.pipelineId !== "") {
    if (typeof input.pipelineId !== "string" || !UUID.test(input.pipelineId)) throw notFound("Pipeline");
    pipelineId = input.pipelineId;
  }
  const onStatus = Array.isArray(input.onStatus) ? [...new Set(input.onStatus)] : [];
  if (!onStatus.length || !onStatus.every((s) => (RULE_STATUSES as readonly unknown[]).includes(s))) {
    throw new DomainError("invalid", `Escolha ao menos um resultado: ${RULE_STATUSES.join(", ")}.`);
  }
  const rawConditions = input.conditions === undefined ? [] : input.conditions;
  if (!Array.isArray(rawConditions) || rawConditions.length > 10) throw new DomainError("invalid", "Até 10 condições por regra.");
  const conditions: Condition[] = rawConditions.map((c, i) => {
    const parameter = (c as { parameter?: unknown })?.parameter;
    const values = (c as { in?: unknown })?.in;
    if (typeof parameter !== "string" || !PARAM.test(parameter)) throw new DomainError("invalid", `Condição ${i + 1}: parâmetro inválido.`);
    if (!Array.isArray(values) || !values.length || values.length > 20) {
      throw new DomainError("invalid", `Condição ${i + 1}: informe de 1 a 20 valores.`);
    }
    if (!values.every((v) => ["string", "number", "boolean"].includes(typeof v) && String(v).length <= 200)) {
      throw new DomainError("invalid", `Condição ${i + 1}: valores precisam ser texto, número ou verdadeiro/falso.`);
    }
    return { parameter, in: values as Condition["in"] };
  });
  const severity = (input.severity ?? "warning") as Severity;
  if (!SEVERITIES.includes(severity)) throw new DomainError("invalid", "Gravidade inválida: info, warning ou critical.");
  const channels = (Array.isArray(input.channels) && input.channels.length ? [...new Set(input.channels)] : ["panel"]) as Channel[];
  if (channels.some((c) => c !== "panel" && c !== "email")) throw new DomainError("invalid", "Canal inválido: painel ou e-mail.");
  // O aviso no painel sempre existe: o e-mail é uma cópia para quem não está olhando o painel.
  if (!channels.includes("panel")) channels.unshift("panel");
  const rawRecipients = Array.isArray(input.recipients) ? input.recipients : [];
  const recipients = [...new Set(rawRecipients.map((r) => (typeof r === "string" ? r.trim().toLowerCase() : "")))].filter(Boolean);
  if (recipients.length > 20) throw new DomainError("invalid", "Até 20 destinatários por regra.");
  for (const r of recipients) if (!EMAIL.test(r) || r.length > 254) throw new DomainError("invalid", `E-mail inválido: ${r.slice(0, 80)}`);
  if (channels.includes("email") && !recipients.length) throw new DomainError("invalid", "Informe ao menos um e-mail para receber o aviso.");
  return {
    name,
    enabled,
    pipelineId,
    onStatus: onStatus as RuleFields["onStatus"],
    conditions,
    severity,
    title,
    message,
    channels,
    recipients: channels.includes("email") ? recipients : [],
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class NotificationService {
  readonly #db: Database;
  readonly #foundation: FoundationService;

  constructor(db: Database, foundation: FoundationService) {
    this.#db = db;
    this.#foundation = foundation;
  }

  // ---------- Regras ----------

  async listRules(actor: Actor, filter: { pipelineId?: string; includeArchived?: boolean } = {}): Promise<NotificationRule[]> {
    const a = await this.#foundation.authorize(actor, "view");
    if (filter.pipelineId !== undefined && !UUID.test(filter.pipelineId)) throw notFound("Pipeline");
    return this.#db.tx(this.#scope(a), (sql) => notifications.listRules(sql, a.organization.id, filter));
  }

  async createRule(actor: Actor, input: Record<string, unknown>, meta: RequestMeta): Promise<NotificationRule> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "notification.rule.create");
    this.#requireWritable(a);
    const fields = parseRuleFields(input);
    return this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requirePipeline(sql, a, fields.pipelineId);
      const rule = await notifications.insertRule(sql, a.organization.id, fields, a.user.id);
      await this.#audit(sql, a, meta, "notification.rule.create", rule.id, "success", { name: rule.name, pipelineId: rule.pipelineId });
      return rule;
    });
  }

  async updateRule(actor: Actor, id: string, input: Record<string, unknown>, meta: RequestMeta): Promise<NotificationRule> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "notification.rule.update");
    this.#requireWritable(a);
    if (!UUID.test(id)) throw notFound("Regra");
    const fields = parseRuleFields(input);
    return this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requirePipeline(sql, a, fields.pipelineId);
      const rule = await notifications.updateRule(sql, a.organization.id, id, fields);
      if (!rule) throw notFound("Regra");
      await this.#audit(sql, a, meta, "notification.rule.update", id, "success", { name: rule.name, enabled: rule.enabled });
      return rule;
    });
  }

  async setRuleArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<NotificationRule> {
    const action = archived ? "notification.rule.archive" : "notification.rule.unarchive";
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, action);
    if (!UUID.test(id)) throw notFound("Regra");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const rule = await notifications.setRuleArchived(sql, a.organization.id, id, archived);
      if (!rule) throw notFound("Regra");
      await this.#audit(sql, a, meta, action, id, "success");
      return rule;
    });
  }

  // ---------- Avisos ----------

  async listAlerts(actor: Actor, filter: { open?: boolean; pipelineId?: string; limit?: number } = {}): Promise<AlertView[]> {
    const a = await this.#foundation.authorize(actor, "view");
    if (filter.pipelineId !== undefined && !UUID.test(filter.pipelineId)) throw notFound("Pipeline");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const list = await notifications.listAlerts(sql, a.organization.id, filter);
      const names = new Map((await pipelines.listPipelines(sql, a.organization.id, { includeArchived: true })).map((p) => [p.id, p.name]));
      return list.map((al) => ({ ...al, pipelineName: names.get(al.pipelineId) ?? "—" }));
    });
  }

  /** Marca o aviso como resolvido (ex.: a versão foi liberada). Fica no histórico. */
  async resolveAlert(actor: Actor, id: string, input: { note?: unknown }, meta: RequestMeta): Promise<Alert> {
    const a = await this.#foundation.authorize(actor, "execute", meta, "notification.alert.resolve");
    if (!UUID.test(id)) throw notFound("Aviso");
    const note = input.note === undefined || input.note === null || input.note === "" ? null : text(input.note, "a observação", 500);
    return this.#db.tx(this.#scope(a), async (sql) => {
      const alert = await notifications.resolveAlert(sql, a.organization.id, id, a.user.id, note);
      if (!alert) throw notFound("Aviso");
      await recordAudit(sql, {
        organizationId: a.organization.id,
        actorUserId: a.user.id,
        action: "notification.alert.resolve",
        targetType: "alert",
        targetId: id,
        outcome: "success",
        correlationId: meta.correlationId,
        ...(note ? { details: { note } } : {}),
      });
      return alert;
    });
  }

  // ---------- Avaliação (worker) ----------

  /** Avalia as regras para uma execução que terminou (ver evaluateRules). */
  evaluate(organizationId: string, executionId: string): Promise<Alert[]> {
    return evaluateRules(this.#db, organizationId, executionId);
  }

  // ---------- Apoio ----------


  async #requirePipeline(sql: Sql, a: OrgActor, pipelineId: string | null): Promise<void> {
    if (!pipelineId) return;
    const p = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
    if (!p) throw notFound("Pipeline");
  }

  #requireWritable(a: OrgActor): void {
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
  }

  #scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }

  #audit(sql: Sql, a: OrgActor, meta: RequestMeta, action: string, targetId: string, outcome: AuditEventInput["outcome"], details?: Record<string, unknown>) {
    return recordAudit(sql, {
      organizationId: a.organization.id,
      actorUserId: a.user.id,
      action,
      targetType: "notification-rule",
      targetId,
      outcome,
      correlationId: meta.correlationId,
      ...(details ? { details } : {}),
    });
  }
}

const RESULT_TEXT: Record<string, string> = { succeeded: "sucesso", failed: "falha", cancelled: "cancelada", unknown: "indefinida" };

/** Resumo da execução para o e-mail (CA-018): resultado, testes, desempenho e link para o painel. */
async function ruleEmail(sql: Sql, organizationId: string, e: Execution, pipelineName: string, alert: Alert, baseUrl: string | undefined) {
  const tests = (await results.summaries(sql, organizationId, [e.id])).get(e.id);
  const perf = (await results.performanceSummaries(sql, organizationId, [e.id])).get(e.id);
  const lines = [alert.message, `Pipeline: ${pipelineName}`, `Execução: ${e.runNumber ?? "—"} · resultado: ${RESULT_TEXT[e.status] ?? e.status}`];
  if (e.ref) lines.push(`Branch: ${e.ref.replace(/^refs\/(heads|tags)\//, "")}`);
  if (e.systemVersion?.full) lines.push(`Versão testada: ${e.systemVersion.full}`);
  if (tests) lines.push(`Testes: ${tests.passed + tests.flaky} de ${tests.total - tests.skipped} passaram · ${tests.failed} falharam · ${tests.skipped} pulados`);
  else if (e.reportStatus === "missing") lines.push("Testes: a execução não publicou relatório.");
  if (perf) lines.push(`Desempenho: p95 ${perf.latencyP95 === null ? "—" : `${Math.round(perf.latencyP95)} ms`} · ${perf.thresholdsFailed} de ${perf.thresholdsTotal} limites não atendidos`);
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/#/pipeline/${e.pipelineId}` : undefined;
  return {
    subject: `[Nexo] ${alert.title}`,
    text: `${lines.join("\n")}${url ? `\n\nAbrir no painel: ${url}` : ""}`,
    html: simpleHtml(lines, url ? { url, label: "Abrir no painel" } : undefined),
  };
}

/**
 * Avalia as regras de evento para uma execução que terminou (roda no worker, sem usuário).
 * Idempotente: cada regra avisa uma vez por execução, então reprocessar é seguro.
 */
export interface EvaluateOptions {
  /** Endereço do painel, para o link no e-mail (PUBLIC_BASE_URL). */
  baseUrl?: string;
  /** SMTP configurado: sem ele, o canal e-mail fica só no painel. */
  emailEnabled?: boolean;
}

export async function evaluateRules(db: Database, organizationId: string, executionId: string, options: EvaluateOptions = {}): Promise<Alert[]> {
  return db.tx({ organizationId, userId: null }, async (sql) => {
      const e = await executions.getExecution(sql, organizationId, executionId);
      if (!e || !isFinal(e.status)) return [];
      const pipeline = await pipelines.getPipeline(sql, organizationId, e.pipelineId);
      if (!pipeline) return [];
      const facts = {
        pipelineId: e.pipelineId,
        pipelineName: pipeline.name,
        status: e.status,
        ref: e.ref,
        parameters: e.parameters,
        systemVersion: e.systemVersion,
        runNumber: e.runNumber,
      };
      const created: Alert[] = [];
      for (const rule of await notifications.activeRulesFor(sql, organizationId, e.pipelineId)) {
        if (!ruleMatches(rule, facts)) continue;
        const alert = await notifications.insertAlert(sql, organizationId, {
          ruleId: rule.id,
          executionId: e.id,
          pipelineId: e.pipelineId,
          severity: rule.severity,
          title: renderMessage(rule.title, facts).slice(0, 200),
          message: renderMessage(rule.message, facts),
        });
        if (!alert) continue;
        created.push(alert);
        await recordAudit(sql, {
          organizationId,
          actorUserId: null,
          actorKind: "system",
          action: "notification.alert.create",
          targetType: "alert",
          targetId: alert.id,
          outcome: "success",
          correlationId: `notify:${executionId}`,
          details: { ruleId: rule.id, executionId },
        });
        await publishEvent(sql, { type: "alert.created", organizationId, executionId, pipelineId: e.pipelineId, status: alert.severity });
        if (options.emailEnabled && rule.channels.includes("email") && rule.recipients.length) {
          const mail = await ruleEmail(sql, organizationId, e, pipeline.name, alert, options.baseUrl);
          for (const recipient of rule.recipients) {
            await queueEmail(sql, { organizationId, kind: "rule", recipient, subject: mail.subject, text: mail.text, html: mail.html, ruleId: rule.id, executionId: e.id });
          }
        }
      }
      return created;
    });
}
