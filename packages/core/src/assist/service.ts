import {
  AgentError,
  createAiProvider,
  McpClient,
  McpError,
  reviewProposal,
  runAgent,
  validateMcpUrl,
  type AgentTool,
  type AiProvider,
  type AiProviderConfig,
  type McpServerConfig,
} from "@painel/assist";
import type { Database } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import type { Job } from "../shared/job-queue.ts";
import { enqueueJob } from "../shared/pg-job-queue.ts";
import type { SecretStore } from "../shared/secret-store.ts";
import { JOBS } from "../execution/jobs.ts";
import type { ProviderAccess } from "../execution/provider.ts";
import type { Actor, FoundationService, OrgActor, RequestMeta } from "../foundation/service.ts";
import type { OnboardingService, PipelineDetail } from "../onboarding/service.ts";
import { recordAudit } from "../modules/audit/index.ts";
import { resources } from "../modules/resources/index.ts";
import { assist, type AiProviderRow, type AssistSession, type CheckRecord, type McpServerRow, type McpToolRow } from "../modules/assist/index.ts";

// Incremento 8 — IA própria + MCP (FLX-008, §19.3–19.5; ADR-016). Tudo opcional (RN-038):
// - provedores de IA e servidores MCP são configuração da organização, com credenciais no cofre;
// - a sessão assistida roda no worker, só com ferramentas de LEITURA (as da plataforma e as MCP
//   classificadas como leitura e autorizadas); a IA entrega uma proposta, nunca grava;
// - a proposta passa pela validação determinística e só vira configuração quando uma pessoa com
//   permissão aplica (RN-040, RN-041, CA-028, CA-044). Aprovar o manifesto é outro passo, manual.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["anthropic", "openai-compatible"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const REPORT_TYPES = ["playwright-json", "playwright-html", "junit-xml", "k6-summary"];

export type ProviderFactory = (config: AiProviderConfig) => AiProvider;
export type McpFactory = (config: McpServerConfig) => Pick<McpClient, "listTools" | "callTool" | "serverInfo">;

export interface AssistDeps {
  providerFactory?: ProviderFactory;
  mcpFactory?: McpFactory;
}

function requireText(value: unknown, what: string, max: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new DomainError("invalid", `Informe ${what}.`);
  if (v.length > max) throw new DomainError("invalid", `${what[0]!.toUpperCase()}${what.slice(1)} pode ter no máximo ${max} caracteres.`);
  return v;
}

function httpUrl(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("invalid", `${what} inválido.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DomainError("invalid", `${what} precisa começar com https:// ou http://.`);
  if (url.username || url.password) throw new DomainError("invalid", `Não coloque usuário e senha no ${what.toLowerCase()}: use o campo da chave.`);
  return url.toString().replace(/\/$/, "");
}

/** Visão de uma sessão para a API: o manifesto de partida fica de fora (é grande e está no projeto). */
export type SessionView = Omit<AssistSession, "baseline"> & { providerName: string };

export class AssistService {
  readonly #db: Database;
  readonly #foundation: FoundationService;
  readonly #secrets: SecretStore;
  readonly #onboarding: OnboardingService;
  readonly #providerFactory: ProviderFactory;
  readonly #mcpFactory: McpFactory;

  constructor(db: Database, foundation: FoundationService, secrets: SecretStore, onboarding: OnboardingService, deps: AssistDeps = {}) {
    this.#db = db;
    this.#foundation = foundation;
    this.#secrets = secrets;
    this.#onboarding = onboarding;
    this.#providerFactory = deps.providerFactory ?? createAiProvider;
    this.#mcpFactory = deps.mcpFactory ?? ((c) => new McpClient(c));
  }

  // =====================================================================
  // Provedores de IA (RF-172, RF-173, RF-185)
  // =====================================================================

  async listProviders(actor: Actor): Promise<AiProviderRow[]> {
    const a = await this.#foundation.authorize(actor, "configurePipelines");
    return this.#db.tx(this.#scope(a), (sql) => assist.listProviders(sql, a.organization.id));
  }

  /** Testa antes de guardar, como as integrações: chave recusada não é salva. */
  async createProvider(actor: Actor, input: Record<string, unknown>, meta: RequestMeta): Promise<AiProviderRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.provider.create");
    this.#writable(a);
    const name = requireText(input.name, "o nome", 80);
    const kind = input.kind as (typeof KINDS)[number];
    if (!KINDS.includes(kind)) throw new DomainError("invalid", "Tipo de provedor inválido: anthropic ou openai-compatible.");
    const model = requireText(input.model, "o modelo", 120);
    const rawEndpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
    if (kind === "openai-compatible" && !rawEndpoint) throw new DomainError("invalid", "Informe o endereço da API (ex.: https://api.openai.com/v1 ou http://ollama:11434/v1).");
    const endpoint = rawEndpoint ? httpUrl(rawEndpoint, "Endereço") : "";
    const effort = input.effort === undefined || input.effort === null || input.effort === "" ? null : (input.effort as (typeof EFFORTS)[number]);
    if (effort !== null && !EFFORTS.includes(effort)) throw new DomainError("invalid", "Esforço inválido.");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (kind === "anthropic" && !apiKey) throw new DomainError("invalid", "Informe a chave da API da Anthropic.");
    if (apiKey.length > 500) throw new DomainError("invalid", "Chave grande demais.");

    const check = await this.#providerFactory({ kind, endpoint, model, apiKey, effort: effort ?? undefined }).test();
    if (!check.ok) {
      await this.#audit(a, meta, "assist.provider.create", "ai-provider", null, "failed", { kind, model });
      throw new DomainError("invalid", `Teste do provedor falhou: ${check.message}`);
    }
    const credential = apiKey ? await this.#secrets.seal(a.organization.id, apiKey) : null;
    return this.#db.tx(this.#scope(a), async (sql) => {
      try {
        const row = await assist.insertProvider(sql, a.organization.id, { name, kind, endpoint, model, effort, credential, check: { ok: true, message: check.message.slice(0, 300) }, createdBy: a.user.id });
        await this.#auditIn(sql, a, meta, "assist.provider.create", "ai-provider", row.id, "success", { kind, model, endpoint: endpoint || "padrão" });
        return row;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DomainError("conflict", "Já existe um provedor com esse nome.");
        throw error;
      }
    });
  }

  async testProvider(actor: Actor, id: string, meta: RequestMeta): Promise<AiProviderRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.provider.test");
    const provider = await this.#openProvider(a.organization.id, id, a.user.id);
    const result = await provider.ai.test();
    const check: CheckRecord = { ok: result.ok, message: result.message.slice(0, 300) };
    return this.#db.tx(this.#scope(a), async (sql) => {
      await assist.setProviderCheck(sql, a.organization.id, id, check);
      await this.#auditIn(sql, a, meta, "assist.provider.test", "ai-provider", id, check.ok ? "success" : "failed");
      return (await assist.listProviders(sql, a.organization.id)).find((p) => p.id === id)!;
    });
  }

  async archiveProvider(actor: Actor, id: string, meta: RequestMeta): Promise<AiProviderRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.provider.archive");
    if (!UUID.test(id)) throw notFound("Provedor de IA");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const row = await assist.archiveProvider(sql, a.organization.id, id);
      if (!row) throw notFound("Provedor de IA");
      await this.#auditIn(sql, a, meta, "assist.provider.archive", "ai-provider", id, "success");
      return row;
    });
  }

  // =====================================================================
  // Servidores MCP (RF-174, RF-175, RF-176)
  // =====================================================================

  async listMcpServers(actor: Actor): Promise<McpServerRow[]> {
    const a = await this.#foundation.authorize(actor, "configurePipelines");
    return this.#db.tx(this.#scope(a), (sql) => assist.listMcpServers(sql, a.organization.id));
  }

  /** Conecta, lista as ferramentas e guarda. Toda ferramenta nasce sem autorização. */
  async createMcpServer(actor: Actor, input: Record<string, unknown>, meta: RequestMeta): Promise<McpServerRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.mcp.create");
    this.#writable(a);
    const name = requireText(input.name, "o nome", 80);
    let url: string;
    try {
      url = validateMcpUrl(requireText(input.url, "o endereço do servidor", 500));
    } catch (error) {
      throw error instanceof McpError ? new DomainError("invalid", error.message) : error;
    }
    const authValue = typeof input.authValue === "string" ? input.authValue.trim() : "";
    const authHeader = authValue ? (typeof input.authHeader === "string" && input.authHeader.trim() ? input.authHeader.trim() : "Authorization") : null;
    if (authHeader && !/^[A-Za-z0-9-]{1,60}$/.test(authHeader)) throw new DomainError("invalid", "Nome de cabeçalho inválido.");
    if (authValue.length > 2000) throw new DomainError("invalid", "Credencial grande demais.");

    const client = this.#mcpFactory({ url, ...(authHeader ? { auth: { header: authHeader, value: authValue } } : {}) });
    let listed;
    try {
      listed = await client.listTools();
    } catch (error) {
      await this.#audit(a, meta, "assist.mcp.create", "mcp-server", null, "failed", { url });
      throw new DomainError("invalid", `Não foi possível usar o servidor MCP: ${error instanceof Error ? error.message : "erro"}`);
    }
    const tools: McpToolRow[] = listed.map((t) => ({ ...t, kind: t.readOnlyHint ? "read" : "mutate", authorized: false }));
    const credential = authValue ? await this.#secrets.seal(a.organization.id, authValue) : null;
    return this.#db.tx(this.#scope(a), async (sql) => {
      try {
        const row = await assist.insertMcpServer(sql, a.organization.id, {
          name,
          url,
          authHeader,
          credential,
          tools,
          serverInfo: client.serverInfo ?? null,
          check: { ok: true, message: `${tools.length} ferramenta(s) encontrada(s)` },
          createdBy: a.user.id,
        });
        await this.#auditIn(sql, a, meta, "assist.mcp.create", "mcp-server", row.id, "success", { url, tools: tools.length });
        return row;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DomainError("conflict", "Já existe um servidor MCP com esse nome.");
        throw error;
      }
    });
  }

  /** Lê de novo as ferramentas; a classificação e a autorização das que continuam existindo ficam. */
  async refreshMcpServer(actor: Actor, id: string, meta: RequestMeta): Promise<McpServerRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.mcp.refresh");
    const { server, client } = await this.#openMcp(a.organization.id, id, a.user.id);
    let listed;
    try {
      listed = await client.listTools();
    } catch (error) {
      const check = { ok: false, message: (error instanceof Error ? error.message : "erro").slice(0, 300) };
      await this.#db.tx(this.#scope(a), (sql) => assist.updateMcpTools(sql, a.organization.id, id, server.tools, { check }));
      throw new DomainError("provider", `Não foi possível usar o servidor MCP: ${check.message}`);
    }
    const previous = new Map(server.tools.map((t) => [t.name, t]));
    const tools: McpToolRow[] = listed.map((t) => {
      const before = previous.get(t.name);
      return before ? { ...t, kind: before.kind, authorized: before.authorized && before.kind === "read" } : { ...t, kind: t.readOnlyHint ? "read" : "mutate", authorized: false };
    });
    return this.#db.tx(this.#scope(a), async (sql) => {
      const row = await assist.updateMcpTools(sql, a.organization.id, id, tools, { serverInfo: client.serverInfo ?? null, check: { ok: true, message: `${tools.length} ferramenta(s) encontrada(s)` } });
      await this.#auditIn(sql, a, meta, "assist.mcp.refresh", "mcp-server", id, "success", { tools: tools.length });
      return row!;
    });
  }

  /**
   * Classificação (leitura/mutação) e autorização de cada ferramenta (RF-176, §19.5). Ferramenta
   * de mutação nunca é autorizada para a IA: alteração externa exige confirmação separada (RF-182).
   */
  async setMcpToolPolicy(actor: Actor, id: string, input: { tools?: unknown }, meta: RequestMeta): Promise<McpServerRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.mcp.policy");
    if (!UUID.test(id)) throw notFound("Servidor MCP");
    const updates = Array.isArray(input.tools) ? input.tools : [];
    return this.#db.tx(this.#scope(a), async (sql) => {
      const server = await assist.getMcpServer(sql, a.organization.id, id);
      if (!server || server.archivedAt) throw notFound("Servidor MCP");
      const byName = new Map(updates.map((u) => [(u as { name?: unknown }).name, u as { kind?: unknown; authorized?: unknown }]));
      const tools = server.tools.map((t) => {
        const u = byName.get(t.name);
        if (!u) return t;
        const kind = u.kind === "read" || u.kind === "mutate" ? u.kind : t.kind;
        const authorized = u.authorized === true;
        if (authorized && kind !== "read") throw new DomainError("invalid", `"${t.name}" é de mutação: a IA só usa ferramentas de leitura.`);
        return { ...t, kind, authorized };
      });
      const row = await assist.updateMcpTools(sql, a.organization.id, id, tools);
      await this.#auditIn(sql, a, meta, "assist.mcp.policy", "mcp-server", id, "success", {
        authorized: tools.filter((t) => t.authorized).map((t) => t.name),
        mutate: tools.filter((t) => t.kind === "mutate").map((t) => t.name),
      });
      return row!;
    });
  }

  async archiveMcpServer(actor: Actor, id: string, meta: RequestMeta): Promise<McpServerRow> {
    const a = await this.#foundation.authorize(actor, "manageIntegrations", meta, "assist.mcp.archive");
    if (!UUID.test(id)) throw notFound("Servidor MCP");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const row = await assist.archiveMcpServer(sql, a.organization.id, id);
      if (!row) throw notFound("Servidor MCP");
      await this.#auditIn(sql, a, meta, "assist.mcp.archive", "mcp-server", id, "success");
      return row;
    });
  }

  // =====================================================================
  // Sessões assistidas (RF-177–183)
  // =====================================================================

  /**
   * Pede a proposta. `acknowledged`: a pessoa viu o que vai para o modelo (a definição da pipeline,
   * os parâmetros, os nomes dos recursos e o que as ferramentas MCP liberadas devolverem — §19.5).
   */
  async startSession(actor: Actor, input: Record<string, unknown>, meta: RequestMeta): Promise<SessionView> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "assist.session.start");
    this.#writable(a);
    if (input.acknowledged !== true) throw new DomainError("invalid", "Confirme que você sabe quais dados serão enviados ao modelo.");
    if (typeof input.providerId !== "string" || !UUID.test(input.providerId)) throw notFound("Provedor de IA");
    const providerId = input.providerId;
    const requested = Array.isArray(input.mcpTools) ? [...new Set(input.mcpTools.filter((t): t is string => typeof t === "string"))].slice(0, 50) : [];
    const provider = await this.#db.tx(this.#scope(a), async (sql) => {
      const p = await assist.getProvider(sql, a.organization.id, providerId);
      if (!p || p.archivedAt) throw notFound("Provedor de IA");
      const servers = new Map((await assist.listMcpServers(sql, a.organization.id)).map((s) => [s.id, s]));
      for (const ref of requested) {
        const [serverId, tool] = ref.split("/");
        const t = servers.get(serverId ?? "")?.tools.find((x) => x.name === tool);
        if (!t || !t.authorized || t.kind !== "read") throw new DomainError("invalid", `Ferramenta MCP não autorizada para a IA: ${ref.slice(0, 120)}.`);
      }
      return p;
    });
    const base = await this.#onboarding.assistBaseline(actor, { projectId: input.projectId, integrationId: input.integrationId, externalId: input.externalId, ref: input.ref }, meta);
    return this.#db.tx(this.#scope(a), async (sql) => {
      const session = await assist.insertSession(sql, a.organization.id, {
        projectId: base.manifest.projectRef,
        integrationId: input.integrationId as string,
        externalId: base.manifest.pipeline.externalId,
        ref: base.ref,
        pipelineName: base.pipelineName,
        providerId,
        mcpTools: requested,
        baseline: base.manifest,
        providerParameters: base.providerParameters,
        createdBy: a.user.id,
      });
      // Uma tentativa só: chamada de IA custa dinheiro e não deve repetir sozinha.
      await enqueueJob(sql, JOBS.assist, { sessionId: session.id }, { organizationId: a.organization.id, idempotencyKey: `assist:${session.id}`, retryLimit: 1 });
      await this.#auditIn(sql, a, meta, "assist.session.start", "assist-session", session.id, "success", {
        providerId,
        kind: provider.kind,
        model: provider.model,
        externalId: session.externalId,
        mcpTools: requested,
      });
      return this.#view(session, provider.name);
    });
  }

  async getSession(actor: Actor, id: string): Promise<SessionView> {
    const a = await this.#foundation.authorize(actor, "configurePipelines");
    if (!UUID.test(id)) throw notFound("Sessão");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const s = await assist.getSession(sql, a.organization.id, id);
      if (!s) throw notFound("Sessão");
      const p = await assist.getProvider(sql, a.organization.id, s.providerId);
      return this.#view(s, p?.name ?? "—");
    });
  }

  async listSessions(actor: Actor): Promise<SessionView[]> {
    const a = await this.#foundation.authorize(actor, "configurePipelines");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const names = new Map((await assist.listProviders(sql, a.organization.id)).map((p) => [p.id, p.name]));
      return (await assist.listSessions(sql, a.organization.id)).map((s) => this.#view(s, names.get(s.providerId) ?? "—"));
    });
  }

  /**
   * Aplica a proposta revisada (RF-181, RF-182). A pessoa pode ter editado o manifesto; ele passa
   * de novo pela validação do caminho manual. Quem não pode configurar pipelines não aplica, mesmo
   * que a IA tenha sugerido (CA-044).
   */
  async applySession(actor: Actor, id: string, input: { manifest?: unknown; note?: unknown }, meta: RequestMeta): Promise<PipelineDetail> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "assist.session.apply");
    if (!UUID.test(id)) throw notFound("Sessão");
    const session = await this.#db.tx(this.#scope(a), (sql) => assist.getSession(sql, a.organization.id, id));
    if (!session) throw notFound("Sessão");
    if (session.status !== "proposed") throw new DomainError("conflict", "Esta sessão não tem proposta pronta para aplicar.");
    const manifest = input.manifest ?? session.review?.manifest;
    if (!manifest) throw new DomainError("invalid", "A proposta não passou na validação. Corrija o manifesto antes de aplicar.");
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : undefined;
    const detail = await this.#onboarding.applyAssistedManifest(
      actor,
      { projectId: session.projectId, integrationId: session.integrationId, externalId: session.externalId, ref: session.ref, manifest, ...(note ? { note } : {}) },
      meta,
    );
    await this.#db.tx(this.#scope(a), async (sql) => {
      await assist.markApplied(sql, a.organization.id, id, a.user.id, detail.pipeline.id);
      await this.#auditIn(sql, a, meta, "assist.session.apply", "assist-session", id, "success", { pipelineId: detail.pipeline.id, version: detail.manifest.version, edited: input.manifest !== undefined });
    });
    return detail;
  }

  async discardSession(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "assist.session.discard");
    if (!UUID.test(id)) throw notFound("Sessão");
    await this.#db.tx(this.#scope(a), async (sql) => {
      if (!(await assist.markDiscarded(sql, a.organization.id, id))) throw new DomainError("conflict", "Esta sessão não pode ser descartada.");
      await this.#auditIn(sql, a, meta, "assist.session.discard", "assist-session", id, "success");
    });
  }

  // ---------- Apoio ----------

  async #openProvider(organizationId: string, id: string, userId: string | null): Promise<{ row: AiProviderRow; ai: AiProvider }> {
    if (!UUID.test(id)) throw notFound("Provedor de IA");
    const row = await this.#db.tx({ organizationId, userId }, (sql) => assist.getProvider(sql, organizationId, id));
    if (!row || row.archivedAt) throw notFound("Provedor de IA");
    const apiKey = row.credential ? await this.#secrets.open(organizationId, row.credential) : "";
    return { row, ai: this.#providerFactory({ kind: row.kind, endpoint: row.endpoint, model: row.model, apiKey, effort: row.effort ?? undefined }) };
  }

  async #openMcp(organizationId: string, id: string, userId: string | null) {
    if (!UUID.test(id)) throw notFound("Servidor MCP");
    const server = await this.#db.tx({ organizationId, userId }, (sql) => assist.getMcpServer(sql, organizationId, id));
    if (!server || server.archivedAt) throw notFound("Servidor MCP");
    const value = server.credential ? await this.#secrets.open(organizationId, server.credential) : "";
    return { server, client: this.#mcpFactory({ url: server.url, ...(server.authHeader && value ? { auth: { header: server.authHeader, value } } : {}) }) };
  }

  #view(s: AssistSession, providerName: string): SessionView {
    const view: Partial<AssistSession> & { providerName: string } = { ...s, providerName };
    delete view.baseline;
    return view as SessionView;
  }

  #writable(a: OrgActor): void {
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
  }

  #scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }

  #auditIn(sql: Parameters<typeof recordAudit>[0], a: OrgActor, meta: RequestMeta, action: string, targetType: string, targetId: string | null, outcome: "success" | "failed" | "denied", details?: Record<string, unknown>) {
    return recordAudit(sql, { organizationId: a.organization.id, actorUserId: a.user.id, action, targetType, targetId, outcome, correlationId: meta.correlationId, ...(details ? { details } : {}) });
  }

  #audit(a: OrgActor, meta: RequestMeta, action: string, targetType: string, targetId: string | null, outcome: "success" | "failed" | "denied", details?: Record<string, unknown>) {
    return this.#db.tx(this.#scope(a), (sql) => this.#auditIn(sql, a, meta, action, targetType, targetId, outcome, details));
  }

  // =====================================================================
  // Execução da sessão (worker)
  // =====================================================================

  /** Roda a sessão: ferramentas de leitura, IA, validação da proposta. Nunca lança: o erro fica na sessão. */
  async run(organizationId: string, sessionId: string, provider: ProviderAccess): Promise<void> {
    const scope = { organizationId, userId: null };
    const session = await this.#db.tx(scope, async (sql) => ((await assist.startSession(sql, organizationId, sessionId)) ? assist.getSession(sql, organizationId, sessionId) : undefined));
    if (!session) return;
    const correlationId = `assist:${sessionId}`;
    let steps: AssistSession["steps"] = [];
    try {
      const { ai, row } = await this.#openProvider(organizationId, session.providerId, null);
      const { connector, conn } = await provider.open(organizationId, session.integrationId, correlationId);
      const catalog = await this.#db.tx(scope, (sql) => resources.listResources(sql, organizationId));
      const refArg = (input: unknown) => {
        const r = (input as { ref?: unknown })?.ref;
        return typeof r === "string" && r.trim() ? r.trim().slice(0, 200) : (session.ref ?? undefined);
      };
      const tools: AgentTool[] = [
        {
          spec: {
            name: "nexo_read_parameters",
            description: "Lê os parâmetros que a pipeline declara no provedor (nome, tipo, padrão, opções). ref opcional: branch.",
            inputSchema: { type: "object", additionalProperties: false, properties: { ref: { type: "string" } } },
          },
          source: "parâmetros da pipeline no provedor",
          run: async (input) => JSON.stringify(await connector.getParameters(conn, session.externalId, refArg(input)), null, 1),
        },
        {
          spec: {
            name: "nexo_list_resources",
            description: "Lista o catálogo de recursos exclusivos (máquinas, ambientes) cadastrados no Nexo: ref e nome.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          source: "catálogo de recursos do Nexo",
          run: async () => JSON.stringify(catalog.map((r) => ({ ref: r.ref, name: r.name, description: r.description }))),
        },
      ];
      if (connector.getDefinition) {
        const getDefinition = connector.getDefinition.bind(connector);
        tools.unshift({
          spec: {
            name: "nexo_read_definition",
            description: "Lê o arquivo de definição da pipeline (YAML) no provedor. ref opcional: branch.",
            inputSchema: { type: "object", additionalProperties: false, properties: { ref: { type: "string" } } },
          },
          source: "arquivo da pipeline no provedor",
          run: async (input) => {
            const d = await getDefinition(conn, session.externalId, refArg(input));
            return `${d.path ? `arquivo: ${d.path}\n` : ""}${d.content}`;
          },
        });
      }
      if (connector.listRefs) {
        const listRefs = connector.listRefs.bind(connector);
        tools.push({
          spec: {
            name: "nexo_list_branches",
            description: "Lista branches e tags do repositório da pipeline. search opcional filtra pelo nome.",
            inputSchema: { type: "object", additionalProperties: false, properties: { search: { type: "string" } } },
          },
          source: "branches e tags do repositório",
          run: async (input) => {
            const search = (input as { search?: unknown })?.search;
            return JSON.stringify(await listRefs(conn, session.externalId, { ...(typeof search === "string" ? { search: search.slice(0, 100) } : {}), limit: 50 }));
          },
        });
      }
      // Ferramentas MCP liberadas: confere de novo a autorização agora (pode ter mudado desde o pedido).
      const byServer = new Map<string, string[]>();
      for (const ref of session.mcpTools) {
        const [serverId, tool] = ref.split("/");
        if (serverId && tool) byServer.set(serverId, [...(byServer.get(serverId) ?? []), tool]);
      }
      for (const [serverId, names] of byServer) {
        const { server, client } = await this.#openMcp(organizationId, serverId, null);
        for (const name of names) {
          const t = server.tools.find((x) => x.name === name);
          if (!t || !t.authorized || t.kind !== "read") continue;
          const alias = `mcp_${server.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20)}_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
          tools.push({
            spec: { name: alias, description: `[servidor MCP ${server.name}] ${t.description}`.slice(0, 1000), inputSchema: t.inputSchema },
            source: `MCP ${server.name} / ${name}`,
            run: async (input) => {
              const out = await client.callTool(name, input);
              if (out.isError) throw new Error(out.text.slice(0, 500) || "a ferramenta MCP devolveu erro");
              return out.text;
            },
          });
        }
      }

      const params = session.baseline.parameters.map((p) => `${p.name} (${p.type})`).join(", ") || "nenhum";
      const task = [
        `Pipeline: ${session.pipelineName} (provedor ${conn.endpoint ? new URL(conn.endpoint).hostname : "—"}, id externo ${session.externalId}).`,
        `Branch dos parâmetros: ${session.ref ?? "padrão"}.`,
        `A descoberta automática já leu estes parâmetros: ${params}.`,
        "Leia a definição e proponha a configuração: rótulos claros em português, tipos e opções corretos, regras entre parâmetros que a definição deixa evidentes, recursos exclusivos que a pipeline usa (só do catálogo) e relatórios que ela publica.",
      ].join("\n");
      const result = await runAgent({ provider: ai, tools, task, signal: AbortSignal.timeout(10 * 60_000) });
      steps = result.steps;
      const review = reviewProposal(session.baseline, result.proposal, {
        providerParameters: session.providerParameters,
        resourceRefs: catalog.map((r) => r.ref),
        reportTypes: REPORT_TYPES,
      });
      await this.#db.tx(scope, async (sql) => {
        await assist.finishSession(sql, organizationId, sessionId, { status: "proposed", review, steps, usage: result.usage });
        await recordAudit(sql, {
          organizationId,
          actorUserId: null,
          actorKind: "assist",
          action: "assist.session.run",
          targetType: "assist-session",
          targetId: sessionId,
          outcome: "success",
          correlationId,
          details: { model: row.model, tools: steps.map((s) => s.tool), usage: result.usage, problems: review.problems.length },
        });
      });
    } catch (error) {
      if (error instanceof AgentError) steps = error.steps;
      const message = error instanceof DomainError || error instanceof AgentError || error instanceof McpError ? error.message : "Falha inesperada na sessão assistida.";
      await this.#db.tx(scope, async (sql) => {
        await assist.finishSession(sql, organizationId, sessionId, { status: "failed", steps, error: message });
        await recordAudit(sql, {
          organizationId,
          actorUserId: null,
          actorKind: "assist",
          action: "assist.session.run",
          targetType: "assist-session",
          targetId: sessionId,
          outcome: "failed",
          correlationId,
          details: { error: message.slice(0, 300), tools: steps.map((s) => s.tool) },
        });
      });
    }
  }

  /** Handler do job do worker. */
  handler(provider: ProviderAccess) {
    return async (job: Job<{ sessionId: string }>) => {
      if (job.organizationId) await this.run(job.organizationId, job.payload.sessionId, provider);
    };
  }
}
