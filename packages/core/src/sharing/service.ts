import type { Database, Sql } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import type { Actor, FoundationService, OrgActor, RequestMeta } from "../foundation/service.ts";
import { recordAudit } from "../modules/audit/index.ts";
import { hashToken, looksLikeToken, newToken } from "../modules/identity/index.ts";
import { tenancy } from "../modules/tenancy/index.ts";
import { executions, type Execution } from "../modules/execution/index.ts";
import { pipelines } from "../modules/pipelines/index.ts";
import { results } from "../modules/results/index.ts";
import { orgSettings, type OrgSettings } from "../modules/admin/index.ts";
import {
  ALWAYS_OMITTED,
  branchName,
  publicParameters,
  sanitizeShareOptions,
  scrubText,
  sharing,
  versionText,
  type PublicExecution,
  type PublicRun,
  type PublicView,
  type ShareAccess,
  type ShareLink,
  type ShareOptions,
  type ShareScope,
} from "../modules/sharing/index.ts";

// Links compartilhados (incremento 7, FLX-004, 22.2, ADR-014). Um link é uma publicação somente
// leitura, não uma sessão: o visitante só lê a projeção sanitizada; nenhuma rota de gestão aceita
// o link (CA-016). Todo link expira; revogar vale na hora (CA-017). A criação, a revogação e a
// mudança de política são auditadas.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PUBLIC_TESTS = 2000;
const NOT_AVAILABLE = "Este link não existe, expirou ou foi revogado.";

export interface ShareInput {
  scope?: unknown;
  pipelineId?: unknown;
  executionId?: unknown;
  access?: unknown;
  title?: unknown;
  days?: unknown;
  options?: unknown;
}

export interface CreatedShare {
  link: ShareLink;
  /** Mostrado uma vez: só o hash fica guardado. */
  token: string;
}

export interface ShareLinkView extends ShareLink {
  pipelineName: string;
  status: "active" | "expired" | "revoked";
}

interface Target {
  scope: ShareScope;
  pipelineId: string;
  executionId: string | null;
  access: ShareAccess;
  title: string;
  days: number;
  options: ShareOptions;
}

export class SharingService {
  readonly #db: Database;
  readonly #foundation: FoundationService;
  readonly #now: () => Date;

  constructor(db: Database, foundation: FoundationService, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#foundation = foundation;
    this.#now = now;
  }

  // ---------- Gestão (quem tem a permissão "share") ----------

  async createLink(actor: Actor, input: ShareInput, meta: RequestMeta): Promise<CreatedShare> {
    const a = await this.#foundation.authorize(actor, "share", meta, "share.create");
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const settings = await orgSettings.getSettings(sql, a.organization.id);
      const target = await this.#target(sql, a, input, settings);
      const token = newToken();
      const link = await sharing.insertLink(sql, a.organization.id, {
        tokenHash: hashToken(token),
        scope: target.scope,
        pipelineId: target.pipelineId,
        executionId: target.executionId,
        access: target.access,
        title: target.title,
        options: target.options,
        expiresAt: new Date(this.#now().getTime() + target.days * 86_400_000),
        createdBy: a.user.id,
      });
      await recordAudit(sql, {
        organizationId: a.organization.id,
        actorUserId: a.user.id,
        action: "share.create",
        targetType: "share-link",
        targetId: link.id,
        outcome: "success",
        correlationId: meta.correlationId,
        details: { scope: link.scope, access: link.access, pipelineId: link.pipelineId, executionId: link.executionId, days: target.days, options: link.options },
      });
      return { link, token };
    });
  }

  /** Exatamente o que o visitante vai ver, antes de criar o link (22.2). */
  async previewLink(actor: Actor, input: ShareInput): Promise<PublicView> {
    const a = await this.#foundation.authorize(actor, "share");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const settings = await orgSettings.getSettings(sql, a.organization.id);
      const target = await this.#target(sql, a, input, settings);
      return this.#project(sql, a.organization.id, a.organization.name, {
        ...target,
        expiresAt: new Date(this.#now().getTime() + target.days * 86_400_000),
      });
    });
  }

  async listLinks(actor: Actor, filter: { pipelineId?: string; executionId?: string } = {}): Promise<ShareLinkView[]> {
    const a = await this.#foundation.authorize(actor, "share");
    for (const id of [filter.pipelineId, filter.executionId]) if (id !== undefined && !UUID.test(id)) throw notFound("Pipeline");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const list = await sharing.listLinks(sql, a.organization.id, filter);
      const names = new Map((await pipelines.listPipelines(sql, a.organization.id, { includeArchived: true })).map((p) => [p.id, p.name]));
      return list.map((l) => ({ ...l, pipelineName: names.get(l.pipelineId) ?? "—", status: this.#status(l) }));
    });
  }

  async revokeLink(actor: Actor, id: string, meta: RequestMeta): Promise<ShareLinkView> {
    const a = await this.#foundation.authorize(actor, "share", meta, "share.revoke");
    if (!UUID.test(id)) throw notFound("Link");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const link = await sharing.revokeLink(sql, a.organization.id, id, a.user.id);
      if (!link) throw notFound("Link");
      await recordAudit(sql, {
        organizationId: a.organization.id,
        actorUserId: a.user.id,
        action: "share.revoke",
        targetType: "share-link",
        targetId: id,
        outcome: "success",
        correlationId: meta.correlationId,
      });
      const pipeline = await pipelines.getPipeline(sql, a.organization.id, link.pipelineId);
      return { ...link, pipelineName: pipeline?.name ?? "—", status: this.#status(link) };
    });
  }

  // ---------- Configurações da organização ----------

  async getSettings(actor: Actor): Promise<OrgSettings> {
    const a = await this.#foundation.authorize(actor, "view");
    return this.#db.tx(this.#scope(a), (sql) => orgSettings.getSettings(sql, a.organization.id));
  }

  async updateSettings(actor: Actor, input: unknown, meta: RequestMeta): Promise<OrgSettings> {
    const a = await this.#foundation.authorize(actor, "view");
    if (a.organization.role !== "admin") {
      await this.#db.tx(this.#scope(a), (sql) =>
        recordAudit(sql, {
          organizationId: a.organization.id,
          actorUserId: a.user.id,
          action: "organization.settings.update",
          targetType: "organization",
          targetId: a.organization.id,
          outcome: "denied",
          correlationId: meta.correlationId,
          details: { requiredRole: "admin" },
        }),
      );
      throw new DomainError("forbidden", "Só o admin da organização muda a política de compartilhamento e de retenção.");
    }
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const saved = await orgSettings.saveSettings(sql, a.organization.id, input as OrgSettings, a.user.id);
      await recordAudit(sql, {
        organizationId: a.organization.id,
        actorUserId: a.user.id,
        action: "organization.settings.update",
        targetType: "organization",
        targetId: a.organization.id,
        outcome: "success",
        correlationId: meta.correlationId,
        details: { sharing: saved.sharing, retention: saved.retention },
      });
      return saved;
    });
  }

  // ---------- Visitante ----------

  /**
   * Abre um link. Público: qualquer pessoa. "Só membros": precisa de sessão e de ser membro da
   * organização dona do link (RF-124). Link inexistente, expirado ou revogado dão a mesma resposta,
   * para não revelar quais tokens existiram.
   */
  async view(token: string, viewer: Actor | undefined): Promise<PublicView> {
    if (!looksLikeToken(token)) throw new DomainError("not-found", NOT_AVAILABLE);
    const hash = hashToken(token);
    const organizationId = await this.#db.tx({}, (sql) => sharing.organizationOf(sql, hash));
    if (!organizationId) throw new DomainError("not-found", NOT_AVAILABLE);
    return this.#db.tx({ organizationId, userId: null }, async (sql) => {
      const link = await sharing.getLinkByHash(sql, organizationId, hash);
      if (!link || this.#status(link) !== "active") throw new DomainError("not-found", NOT_AVAILABLE);
      const settings = await orgSettings.getSettings(sql, organizationId);
      if (link.access === "public" && !settings.sharing.allowPublic) throw new DomainError("not-found", NOT_AVAILABLE);
      if (link.access === "members") {
        if (!viewer) throw new DomainError("unauthenticated", "Este link é só para membros da organização. Entre para ver.");
        if (!(await tenancy.getMembership(sql, organizationId, viewer.user.id))) {
          throw new DomainError("forbidden", "Este link é só para membros da organização que o publicou.");
        }
      }
      const org = await tenancy.getOrganization(sql, organizationId);
      await sharing.touchView(sql, organizationId, link.id);
      return this.#project(sql, organizationId, org?.name ?? "", link);
    });
  }

  // ---------- Apoio ----------

  #status(l: ShareLink): ShareLinkView["status"] {
    if (l.revokedAt) return "revoked";
    return l.expiresAt.getTime() <= this.#now().getTime() ? "expired" : "active";
  }

  async #target(sql: Sql, a: OrgActor, input: ShareInput, settings: OrgSettings): Promise<Target> {
    const scope = input.scope === "pipeline" ? "pipeline" : input.scope === "execution" ? "execution" : undefined;
    if (!scope) throw new DomainError("invalid", "Escolha o que compartilhar: uma execução ou o painel da pipeline.");
    const access = input.access === "members" ? "members" : input.access === "public" ? "public" : undefined;
    if (!access) throw new DomainError("invalid", "Escolha quem pode abrir: qualquer pessoa com o link, ou só membros.");
    if (access === "public" && !settings.sharing.allowPublic) {
      throw new DomainError("forbidden", "Esta organização não permite links públicos. Use um link só para membros.");
    }
    const days = input.days === undefined || input.days === null ? settings.sharing.defaultDays : Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > settings.sharing.maxDays) {
      throw new DomainError("invalid", `A validade precisa ser de 1 a ${settings.sharing.maxDays} dias.`);
    }
    let pipelineId: string;
    let executionId: string | null = null;
    if (scope === "execution") {
      if (typeof input.executionId !== "string" || !UUID.test(input.executionId)) throw notFound("Execução");
      const e = await executions.getExecution(sql, a.organization.id, input.executionId);
      if (!e) throw notFound("Execução");
      executionId = e.id;
      pipelineId = e.pipelineId;
    } else {
      if (typeof input.pipelineId !== "string" || !UUID.test(input.pipelineId)) throw notFound("Pipeline");
      pipelineId = input.pipelineId;
    }
    const pipeline = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
    if (!pipeline) throw notFound("Pipeline");
    const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
    if (rawTitle.length > 200) throw new DomainError("invalid", "O título pode ter no máximo 200 caracteres.");
    const title = rawTitle || (scope === "execution" ? `Resultado de ${pipeline.name}` : `Painel de ${pipeline.name}`);
    return { scope, pipelineId, executionId, access, title, days, options: sanitizeShareOptions(input.options) };
  }

  async #project(
    sql: Sql,
    organizationId: string,
    organizationName: string,
    l: Pick<ShareLink, "scope" | "pipelineId" | "executionId" | "access" | "title" | "options" | "expiresAt">,
  ): Promise<PublicView> {
    const pipeline = await pipelines.getPipeline(sql, organizationId, l.pipelineId);
    if (!pipeline) throw new DomainError("not-found", NOT_AVAILABLE);
    const o = l.options;
    const omitted = [...ALWAYS_OMITTED];
    if (!o.parameters) omitted.push("parâmetros usados");
    if (!o.errorDetails) omitted.push("detalhe técnico dos erros (só a primeira linha aparece)");
    if (!o.branch) omitted.push("branch");
    if (!o.systemVersion) omitted.push("versão do sistema em teste");
    const view: PublicView = {
      kind: l.scope,
      title: scrubText(l.title),
      organizationName,
      pipelineName: pipeline.name,
      access: l.access,
      expiresAt: l.expiresAt.toISOString(),
      generatedAt: this.#now().toISOString(),
      omitted,
    };
    if (l.scope === "execution" && l.executionId) {
      const e = await executions.getExecution(sql, organizationId, l.executionId);
      if (!e) throw new DomainError("not-found", NOT_AVAILABLE);
      const projected = await this.#execution(sql, organizationId, e, o);
      view.execution = projected.execution;
      if (projected.hiddenParameters.length) omitted.push(`valores de parâmetros sensíveis (${projected.hiddenParameters.join(", ")})`);
    } else {
      const since = this.#now().getTime() - o.periodDays * 86_400_000;
      const list = (await executions.listExecutions(sql, organizationId, { pipelineId: l.pipelineId, limit: 200 })).filter(
        (e) => e.requestedAt.getTime() >= since,
      );
      const ids = list.map((e) => e.id);
      const tests = await results.summaries(sql, organizationId, ids);
      const perf = await results.performanceSummaries(sql, organizationId, ids);
      view.pipeline = {
        periodDays: o.periodDays,
        runs: list.map(
          (e): PublicRun => ({
            number: scrubText(e.runNumber ?? (e.externalRunId ? `#${e.externalRunId}` : "—")),
            status: e.status,
            requestedAt: e.requestedAt.toISOString(),
            finishedAt: e.finishedAt?.toISOString() ?? null,
            durationMs: e.startedAt && e.finishedAt ? e.finishedAt.getTime() - e.startedAt.getTime() : null,
            failureKind: e.failureKind,
            tests: (() => {
              const s = tests.get(e.id);
              return s ? { total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped, flaky: s.flaky } : null;
            })(),
            performance: perf.get(e.id) ?? null,
          }),
        ),
      };
    }
    return view;
  }

  async #execution(sql: Sql, organizationId: string, e: Execution, o: ShareOptions): Promise<{ execution: PublicExecution; hiddenParameters: string[] }> {
    const summary = (await results.summaries(sql, organizationId, [e.id])).get(e.id) ?? null;
    const tests = await results.listTests(sql, organizationId, e.id, { limit: MAX_PUBLIC_TESTS });
    const perf = await results.listPerformance(sql, organizationId, e.id);
    const params = o.parameters ? publicParameters(e.parameters) : { values: null, hidden: [] as string[] };
    return {
      hiddenParameters: params.hidden,
      execution: {
        number: scrubText(e.runNumber ?? (e.externalRunId ? `#${e.externalRunId}` : "—")),
        status: e.status,
        requestedAt: e.requestedAt.toISOString(),
        startedAt: e.startedAt?.toISOString() ?? null,
        finishedAt: e.finishedAt?.toISOString() ?? null,
        branch: o.branch ? branchName(e.ref) : null,
        systemVersion: o.systemVersion ? versionText(e.systemVersion) : null,
        parameters: params.values,
        reportStatus: e.reportStatus,
        failureKind: e.failureKind,
        summary,
        tests: tests.map((t) => ({
          suite: scrubText(t.suite),
          name: scrubText(t.name),
          file: scrubText(t.file),
          project: scrubText(t.project),
          status: t.status,
          durationMs: t.durationMs,
          attempts: t.attempts,
          errorMessage: scrubText(t.errorMessage),
          errorDetails: o.errorDetails ? scrubText(t.errorDetails) : null,
        })),
        testsTruncated: summary ? summary.total > tests.length : false,
        performance: perf.map((p) => ({
          durationMs: p.durationMs,
          vusMax: p.vusMax,
          httpReqs: p.httpReqs,
          httpReqRate: p.httpReqRate,
          httpReqFailedRate: p.httpReqFailedRate,
          latency: p.latency,
          thresholds: p.thresholds.map((t) => ({ metric: scrubText(t.metric), expression: scrubText(t.expression), ok: t.ok })),
        })),
      },
    };
  }

  #scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }
}
