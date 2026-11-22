import * as demo from "./demo.ts";
import type {
  AccessToken,
  AuditEvent,
  ConnectionCheck,
  DiscoveredPipeline,
  Integration,
  LinkedPipeline,
  ManifestVersion,
  Member,
  OrganizationChoice,
  ExecutionInput,
  ExecutionPreview,
  ExecutionProfile,
  ExecutionStatus,
  ExternalRef,
  Alert,
  NotificationRule,
  RuleInput,
  ExecResource,
  PipelineManifest,
  ExecutionDetail,
  ProfileInput,
  ResourceInput,
  AccessMatrix,
  AccessPolicy,
  IssuedLink,
  Organization,
  Role,
  SystemVersion,
  PipelineDetail,
  Project,
  Run,
  SessionView,
  Workspace,
  AppliedChange,
  ChangeMode,
  DefinitionPreview,
  DefinitionView,
  ExternalRepository,
  NewPipelineInput,
  PipelineTemplate,
  ExecutionResults,
  FailureKind,
  ReportStatus,
  TestStatus,
  TestSummary,
  PerformancePoint,
  EmailHistoryItem,
  OrgSettings,
  PublicView,
  ShareInput,
  ShareLink,
  AiProvider,
  AiProviderInput,
  AssistSession,
  AssistSessionInput,
  McpServer,
  McpTool,
} from "./types.ts";
import { compareWithProvider } from "./drift.ts";

// Fonte de dados das telas. Com a API no ar, usa a API (cookie de sessão + CSRF). Sem ela,
// o modo demonstração usa dados fictícios no mesmo formato, e a interface avisa isso o tempo todo.

export type Mode = "api" | "demo";

export { ApiError } from "./errors.ts";
import { ApiError } from "./errors.ts";

export interface DataSource {
  mode: Mode;
  session(): Promise<SessionView>;
  /** Organizações em que o usuário é membro (a escolha da entrada). */
  organizations(): Promise<OrganizationChoice[]>;
  /** Troca a organização em uso nesta sessão. */
  switchOrganization(organizationId: string): Promise<SessionView>;
  workspaces(): Promise<Workspace[]>;
  projects(): Promise<Project[]>;
  pipelines(projectId?: string): Promise<LinkedPipeline[]>;
  pipeline(id: string): Promise<PipelineDetail>;
  versions(id: string): Promise<Array<Omit<ManifestVersion, "manifest">>>;
  version(id: string, version: number): Promise<ManifestVersion>;
  integrations(): Promise<Integration[]>;
  members(): Promise<Member[]>;
  audit(): Promise<AuditEvent[]>;
  /** null = esta fonte não tem execuções. */
  runs(pipelineId?: string): Promise<Run[] | null>;

  // ----- Execução (incremento 3) -----
  profiles(pipelineId: string): Promise<ExecutionProfile[]>;
  saveProfile(pipelineId: string, input: ProfileInput, id?: string): Promise<ExecutionProfile>;
  archiveProfile(id: string): Promise<ExecutionProfile>;
  resources(): Promise<ExecResource[]>;
  saveResource(input: ResourceInput, id?: string): Promise<unknown>;
  setResourceArchived(id: string, archived: boolean): Promise<unknown>;
  /** Salva uma versão nova do manifesto; expectedVersion barra sobrescrever a edição de outra pessoa. */
  saveManifest(pipelineId: string, manifest: PipelineManifest, expectedVersion: number, note?: string): Promise<PipelineDetail>;
  execution(id: string): Promise<ExecutionDetail>;
  /** Logs lidos do provedor na hora, em texto. */
  executionLogs(id: string): Promise<string>;
  /** Testes lidos dos relatórios da execução (incremento 5). */
  executionResults(id: string, filter?: { status?: TestStatus[]; search?: string }): Promise<ExecutionResults>;
  /** Série histórica de desempenho (k6) da pipeline, da mais antiga para a mais recente (incremento 6). */
  pipelinePerformance(pipelineId: string): Promise<PerformancePoint[]>;
  /** Branches e tags do repositório da pipeline, filtradas por um trecho do nome. */
  listRefs(pipelineId: string, search?: string): Promise<ExternalRef[]>;
  previewExecution(input: ExecutionInput): Promise<ExecutionPreview>;
  requestExecution(input: ExecutionInput): Promise<Run>;
  cancelExecution(id: string): Promise<Run>;
  rerunExecution(id: string): Promise<Run>;
  // ----- Regras de evento e avisos -----
  rules(pipelineId?: string): Promise<NotificationRule[]>;
  saveRule(input: RuleInput, id?: string): Promise<NotificationRule>;
  archiveRule(id: string): Promise<NotificationRule>;
  alerts(open?: boolean): Promise<Alert[]>;
  resolveAlert(id: string, note?: string): Promise<Alert>;

  // ----- Administração -----
  organization(): Promise<Organization>;
  renameOrganization(name: string): Promise<Organization>;
  setOrganizationArchived(archived: boolean): Promise<Organization>;
  createOrganization(input: { name: string; slug: string }): Promise<Organization>;
  accessMatrix(): Promise<AccessMatrix>;
  accessPolicy(): Promise<AccessPolicy>;
  saveAccessPolicy(policy: AccessPolicy): Promise<AccessPolicy>;
  /** Pipelines da organização inteira (sem o recorte do workspace escolhido na entrada). */
  adminPipelines(): Promise<LinkedPipeline[]>;
  /** Workspaces e projetos da organização inteira, inclusive arquivados (sem o recorte da entrada). */
  adminWorkspaces(): Promise<Workspace[]>;
  adminProjects(): Promise<Project[]>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<Workspace>;
  setWorkspaceArchived(id: string, archived: boolean): Promise<Workspace>;
  createProject(workspaceId: string, name: string): Promise<Project>;
  updateProject(id: string, input: { name?: string; workspaceId?: string }): Promise<Project>;
  setProjectArchived(id: string, archived: boolean): Promise<Project>;
  invite(input: { email: string; role: Role; displayName?: string }): Promise<IssuedLink>;
  setMemberRole(userId: string, role: Role): Promise<void>;
  removeMember(userId: string): Promise<void>;
  /** Só o administrador da instalação. */
  issuePasswordReset(email: string): Promise<IssuedLink>;
  /** Tokens pessoais de acesso (API e MCP) da própria conta. */
  accessTokens(): Promise<AccessToken[]>;
  /** Cria um token na organização em uso; o valor só volta agora. */
  createAccessToken(input: { name: string; days: number }): Promise<{ token: string; accessToken: AccessToken }>;
  revokeAccessToken(id: string): Promise<void>;

  // ----- Distribuição (incremento 7) -----
  /** Cria o link; a URL só aparece agora (o servidor guarda o hash). */
  createShareLink(input: ShareInput): Promise<{ link: ShareLink; url: string }>;
  /** Exatamente o que o visitante vai ver, sem criar o link. */
  previewShareLink(input: ShareInput): Promise<PublicView>;
  shareLinks(filter?: { pipelineId?: string; executionId?: string }): Promise<ShareLink[]>;
  revokeShareLink(id: string): Promise<ShareLink>;
  orgSettings(): Promise<OrgSettings>;
  saveOrgSettings(settings: OrgSettings): Promise<OrgSettings>;
  emailStatus(): Promise<{ enabled: boolean }>;
  emailHistory(): Promise<EmailHistoryItem[]>;
  sendTestEmail(): Promise<void>;

  // ----- IA própria + MCP (incremento 8) -----
  aiProviders(): Promise<AiProvider[]>;
  createAiProvider(input: AiProviderInput): Promise<AiProvider>;
  testAiProvider(id: string): Promise<AiProvider>;
  archiveAiProvider(id: string): Promise<AiProvider>;
  mcpServers(): Promise<McpServer[]>;
  createMcpServer(input: { name: string; url: string; authHeader?: string; authValue?: string }): Promise<McpServer>;
  refreshMcpServer(id: string): Promise<McpServer>;
  setMcpTools(id: string, tools: Array<{ name: string; kind: McpTool["kind"]; authorized: boolean }>): Promise<McpServer>;
  archiveMcpServer(id: string): Promise<McpServer>;
  assistSessions(): Promise<AssistSession[]>;
  startAssistSession(input: AssistSessionInput): Promise<AssistSession>;
  assistSession(id: string): Promise<AssistSession>;
  applyAssistSession(id: string, input: { manifest?: PipelineManifest; note?: string }): Promise<PipelineDetail>;
  discardAssistSession(id: string): Promise<void>;

  /** Avisos em tempo real de mudanças de execução (SSE). Devolve a função que para de ouvir. */
  subscribe(onChange: (e: { executionId: string; pipelineId: string; status: string }) => void): () => void;

  // ----- Ações do incremento 2 -----
  connectors(): Promise<string[]>;
  /** Testa a credencial no provedor antes de guardar; recusa vira ApiError com a mensagem do teste. */
  createIntegration(input: { kind: string; name: string; endpoint: string; credential: string }): Promise<{ integration: Integration; check: ConnectionCheck }>;
  discover(integrationId: string, query: { q?: string; cursor?: string }): Promise<{ items: DiscoveredPipeline[]; nextCursor?: string }>;
  importPipeline(input: { projectId: string; integrationId: string; externalId: string; ref?: string }): Promise<PipelineDetail>;
  /** Incremento 4: o YAML da pipeline, a prévia da mudança e a gravação (commit ou PR). */
  definition(pipelineId: string, ref?: string): Promise<DefinitionView>;
  previewDefinition(pipelineId: string, content: string, ref?: string): Promise<DefinitionPreview>;
  applyDefinition(
    pipelineId: string,
    input: { content: string; expectedRevision: string; mode: ChangeMode; message?: string; ref?: string },
  ): Promise<{ change: AppliedChange; pipeline: PipelineDetail | null }>;
  repositories(integrationId: string): Promise<ExternalRepository[]>;
  pipelineTemplates(): Promise<PipelineTemplate[]>;
  renderTemplate(input: { integrationId: string; templateId: string; name: string; values: Record<string, string | boolean> }): Promise<{
    content: string;
    path: string;
    problems: string[];
  }>;
  createPipeline(input: NewPipelineInput): Promise<{ change: AppliedChange; pipeline: PipelineDetail | null }>;
  syncPipeline(id: string, ref?: string): Promise<PipelineDetail>;
}

// ---------- API ----------

export function apiSource(csrf: () => string): DataSource {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.method && init.method !== "GET") {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = csrf();
    }
    const res = await fetch(path, { credentials: "same-origin", ...init, headers });
    const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
    if (!res.ok) {
      const { error, message, ...details } = (body ?? {}) as { error?: string; message?: string };
      throw new ApiError(res.status, error ?? "internal", message ?? `Erro ${res.status}`, details);
    }
    return body as T;
  }
  const items = <T,>(path: string) => call<{ items: T[] }>(path).then((r) => r.items);
  return {
    mode: "api",
    session: () => call("/api/session"),
    organizations: () => items("/api/organizations"),
    switchOrganization: (organizationId) => call("/api/session/organization", { method: "POST", body: JSON.stringify({ organizationId }) }),
    workspaces: () => items("/api/workspaces"),
    projects: () => items("/api/projects"),
    pipelines: (projectId) => items(`/api/pipelines${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
    pipeline: (id) => call(`/api/pipelines/${encodeURIComponent(id)}`),
    versions: (id) => items(`/api/pipelines/${encodeURIComponent(id)}/manifest/versions`),
    version: (id, v) => call(`/api/pipelines/${encodeURIComponent(id)}/manifest/versions/${v}`),
    integrations: () => items("/api/integrations"),
    members: () => items("/api/members"),
    audit: () => items("/api/audit"),
    runs: async (pipelineId) => {
      const qs = new URLSearchParams({ limit: "200" });
      if (pipelineId) qs.set("pipelineId", pipelineId);
      return (await items<ApiExecution>(`/api/executions?${qs}`)).map(toRun);
    },
    profiles: (pipelineId) => items(`/api/pipelines/${encodeURIComponent(pipelineId)}/profiles`),
    saveProfile: (pipelineId, input, id) =>
      call(id ? `/api/profiles/${encodeURIComponent(id)}` : `/api/pipelines/${encodeURIComponent(pipelineId)}/profiles`, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(input),
      }),
    archiveProfile: (id) => call(`/api/profiles/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
    resources: () => items("/api/resources?includeArchived=true"),
    saveResource: (input, id) =>
      call(id ? `/api/resources/${encodeURIComponent(id)}` : "/api/resources", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(id ? { name: input.name, description: input.description ?? null, busyPolicy: input.busyPolicy, leaseTtlSeconds: input.leaseTtlSeconds } : input),
      }),
    setResourceArchived: (id, archived) =>
      call(`/api/resources/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST", body: "{}" }),
    saveManifest: (pipelineId, manifest, expectedVersion, note) =>
      call(`/api/pipelines/${encodeURIComponent(pipelineId)}/manifest`, {
        method: "PUT",
        body: JSON.stringify({ manifest, expectedVersion, ...(note ? { note } : {}) }),
      }),
    async execution(id) {
      const d = await call<ExecutionDetail & { execution: Parameters<typeof toRun>[0] & Record<string, unknown> }>(`/api/executions/${encodeURIComponent(id)}`);
      const e = d.execution as Record<string, unknown>;
      return {
        ...d,
        execution: {
          ...toRun(d.execution),
          externalRunId: (e.externalRunId as string | null) ?? null,
          failureKind: (e.failureKind as FailureKind) ?? "none",
          reportStatus: (e.reportStatus as ReportStatus) ?? "pending",
          runTags: (e.runTags as string[]) ?? [],
          agentOrPool: (e.agentOrPool as string | null) ?? null,
        },
      };
    },
    executionResults(id, filter = {}) {
      const q = new URLSearchParams();
      if (filter.status?.length) q.set("status", filter.status.join(","));
      if (filter.search) q.set("search", filter.search);
      const qs = q.toString();
      return call<ExecutionResults>(`/api/executions/${encodeURIComponent(id)}/results${qs ? `?${qs}` : ""}`);
    },
    pipelinePerformance: (pipelineId) => items(`/api/pipelines/${encodeURIComponent(pipelineId)}/performance`),
    async executionLogs(id) {
      const res = await fetch(`/api/executions/${encodeURIComponent(id)}/logs`, { credentials: "same-origin" });
      if (!res.ok) {
        const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : {};
        throw new ApiError(res.status, body.error ?? "internal", body.message ?? `Erro ${res.status}`);
      }
      return res.text();
    },
    listRefs: (pipelineId, search) =>
      items(`/api/pipelines/${encodeURIComponent(pipelineId)}/refs${search ? `?q=${encodeURIComponent(search)}` : ""}`),
    previewExecution: (input) => call("/api/executions/preview", { method: "POST", body: JSON.stringify(input) }),
    requestExecution: async (input) =>
      toRun((await call<{ execution: ApiExecution }>("/api/executions", { method: "POST", body: JSON.stringify(input) })).execution),
    cancelExecution: async (id) => toRun(await call<ApiExecution>(`/api/executions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" })),
    rerunExecution: async (id) =>
      toRun((await call<{ execution: ApiExecution }>(`/api/executions/${encodeURIComponent(id)}/rerun`, { method: "POST", body: "{}" })).execution),
    subscribe(onChange) {
      if (typeof EventSource === "undefined") return () => undefined;
      const source = new EventSource("/api/events", { withCredentials: true });
      const handle = (ev: Event) => {
        try {
          onChange(JSON.parse((ev as MessageEvent<string>).data));
        } catch {
          /* evento malformado: ignora */
        }
      };
      source.addEventListener("execution.changed", handle);
      source.addEventListener("alert.created", handle);
      return () => source.close();
    },
    createShareLink: (input) => call("/api/share-links", { method: "POST", body: JSON.stringify(input) }),
    previewShareLink: (input) => call("/api/share-links/preview", { method: "POST", body: JSON.stringify(input) }),
    shareLinks: (filter = {}) => {
      const q = new URLSearchParams();
      if (filter.pipelineId) q.set("pipelineId", filter.pipelineId);
      if (filter.executionId) q.set("executionId", filter.executionId);
      const qs = q.toString();
      return items(`/api/share-links${qs ? `?${qs}` : ""}`);
    },
    revokeShareLink: (id) => call(`/api/share-links/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
    orgSettings: () => call("/api/organization/settings"),
    saveOrgSettings: (settings) => call("/api/organization/settings", { method: "PUT", body: JSON.stringify(settings) }),
    emailStatus: () => call("/api/email/status"),
    emailHistory: () => items("/api/email/history"),
    sendTestEmail: async () => {
      await call("/api/email/test", { method: "POST", body: "{}" });
    },
    aiProviders: () => items("/api/ai-providers"),
    createAiProvider: (input) => call("/api/ai-providers", { method: "POST", body: JSON.stringify(input) }),
    testAiProvider: (id) => call(`/api/ai-providers/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" }),
    archiveAiProvider: (id) => call(`/api/ai-providers/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
    mcpServers: () => items("/api/mcp-servers"),
    createMcpServer: (input) => call("/api/mcp-servers", { method: "POST", body: JSON.stringify(input) }),
    refreshMcpServer: (id) => call(`/api/mcp-servers/${encodeURIComponent(id)}/refresh`, { method: "POST", body: "{}" }),
    setMcpTools: (id, tools) => call(`/api/mcp-servers/${encodeURIComponent(id)}/tools`, { method: "PUT", body: JSON.stringify({ tools }) }),
    archiveMcpServer: (id) => call(`/api/mcp-servers/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
    assistSessions: () => items("/api/assist-sessions"),
    startAssistSession: (input) => call("/api/assist-sessions", { method: "POST", body: JSON.stringify(input) }),
    assistSession: (id) => call(`/api/assist-sessions/${encodeURIComponent(id)}`),
    applyAssistSession: (id, input) => call(`/api/assist-sessions/${encodeURIComponent(id)}/apply`, { method: "POST", body: JSON.stringify(input) }),
    discardAssistSession: async (id) => {
      await call(`/api/assist-sessions/${encodeURIComponent(id)}/discard`, { method: "POST", body: "{}" });
    },
    rules: (pipelineId) => items(`/api/notification-rules${pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : ""}`),
    saveRule: (input, id) =>
      call(id ? `/api/notification-rules/${encodeURIComponent(id)}` : "/api/notification-rules", { method: id ? "PUT" : "POST", body: JSON.stringify(input) }),
    archiveRule: (id) => call(`/api/notification-rules/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
    alerts: (open) => items(`/api/alerts${open ? "?open=true" : ""}`),
    resolveAlert: (id, note) => call(`/api/alerts/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify(note ? { note } : {}) }),
    organization: () => call("/api/organization"),
    renameOrganization: (name) => call("/api/organization", { method: "PATCH", body: JSON.stringify({ name }) }),
    setOrganizationArchived: (archived) => call(`/api/organization/${archived ? "archive" : "unarchive"}`, { method: "POST", body: "{}" }),
    createOrganization: (input) => call("/api/organizations", { method: "POST", body: JSON.stringify(input) }),
    accessMatrix: () => call("/api/access-matrix"),
    accessPolicy: () => call("/api/access-policy"),
    saveAccessPolicy: (policy) => call("/api/access-policy", { method: "PUT", body: JSON.stringify(policy) }),
    adminPipelines: () => items("/api/pipelines"),
    adminWorkspaces: () => items("/api/workspaces?includeArchived=true"),
    adminProjects: () => items("/api/projects?includeArchived=true"),
    createWorkspace: (name) => call("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
    renameWorkspace: (id, name) => call(`/api/workspaces/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    setWorkspaceArchived: (id, archived) =>
      call(`/api/workspaces/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST", body: "{}" }),
    createProject: (workspaceId, name) => call("/api/projects", { method: "POST", body: JSON.stringify({ workspaceId, name }) }),
    updateProject: (id, input) => call(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
    setProjectArchived: (id, archived) =>
      call(`/api/projects/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST", body: "{}" }),
    invite: (input) => call("/api/invites", { method: "POST", body: JSON.stringify(input) }),
    setMemberRole: async (userId, role) => {
      await call(`/api/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role }) });
    },
    removeMember: async (userId) => {
      await call(`/api/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
    },
    issuePasswordReset: (email) => call("/api/admin/password-resets", { method: "POST", body: JSON.stringify({ email }) }),
    accessTokens: () => items("/api/access-tokens"),
    createAccessToken: (input) => call("/api/access-tokens", { method: "POST", body: JSON.stringify(input) }),
    revokeAccessToken: async (id) => {
      await call(`/api/access-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    connectors: () => items<string>("/api/connectors"),
    createIntegration: (input) => call("/api/integrations", { method: "POST", body: JSON.stringify(input) }),
    discover: (integrationId, q) => {
      const params = new URLSearchParams();
      if (q.q) params.set("q", q.q);
      if (q.cursor) params.set("cursor", q.cursor);
      const qs = params.toString();
      return call(`/api/integrations/${encodeURIComponent(integrationId)}/discover${qs ? `?${qs}` : ""}`);
    },
    importPipeline: (input) => call("/api/pipelines", { method: "POST", body: JSON.stringify(input) }),
    definition: (pipelineId, ref) =>
      call(`/api/pipelines/${encodeURIComponent(pipelineId)}/definition${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
    previewDefinition: (pipelineId, content, ref) =>
      call(`/api/pipelines/${encodeURIComponent(pipelineId)}/definition/preview`, { method: "POST", body: JSON.stringify({ content, ...(ref ? { ref } : {}) }) }),
    applyDefinition: (pipelineId, input) => call(`/api/pipelines/${encodeURIComponent(pipelineId)}/definition`, { method: "POST", body: JSON.stringify(input) }),
    repositories: async (integrationId) => (await call<{ items: ExternalRepository[] }>(`/api/integrations/${encodeURIComponent(integrationId)}/repositories`)).items,
    pipelineTemplates: async () => (await call<{ items: PipelineTemplate[] }>("/api/pipeline-templates")).items,
    renderTemplate: (input) => call("/api/pipeline-templates/render", { method: "POST", body: JSON.stringify(input) }),
    createPipeline: (input) => call("/api/pipelines/create", { method: "POST", body: JSON.stringify(input) }),
    syncPipeline: (id, ref) => call(`/api/pipelines/${encodeURIComponent(id)}/sync`, { method: "POST", body: JSON.stringify(ref ? { ref } : {}) }),
  };
}

/** Entra pela API. Devolve a sessão (com o token CSRF). */
export async function apiLogin(email: string, password: string): Promise<SessionView> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "internal", body.message ?? "Não foi possível entrar.");
  return body as SessionView;
}

/** Encerra a sessão atual (falha silenciosa: no pior caso a sessão expira sozinha). */
export async function apiLogout(csrfToken: string): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: { accept: "application/json", "x-csrf-token": csrfToken },
    credentials: "same-origin",
  }).catch(() => undefined);
}

/**
 * Descobre como abrir: "session" (já logado), "login" (API no ar, sem sessão) ou "offline"
 * (sem API: o proxy do Vite responde 502/504, ou a resposta não é da API).
 */
export async function probe(): Promise<{ state: "session"; session: SessionView } | { state: "login" | "offline" }> {
  try {
    const res = await fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin" });
    const json = res.headers.get("content-type")?.includes("application/json");
    if (res.ok && json) return { state: "session", session: await res.json() };
    if (res.status === 401 && json) return { state: "login" };
    // 404 com JSON: a API subiu sem banco e não registrou as rotas de negócio.
    return { state: "offline" };
  } catch {
    return { state: "offline" };
  }
}

/** Execução como a API devolve (só os campos que a tela usa). */
interface ApiExecution {
  id: string;
  pipelineId: string;
  status: ExecutionStatus;
  statusReason: string | null;
  triggerType: "manual" | "rerun" | "external" | "schedule";
  externalRunId: string | null;
  runNumber: string | null;
  ref: string | null;
  parameters: Record<string, string | number | boolean>;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuePosition: number | null;
  rerunOf: string | null;
  requestedBy: string | null;
  systemVersion: SystemVersion | null;
  tests?: TestSummary | null;
  reportStatus?: ReportStatus;
  failureKind?: FailureKind;
  performance?: Run["performance"];
}

const SUMMARY: Record<ExecutionStatus, Run["status"]> = {
  queued: "queued",
  dispatching: "queued",
  running: "running",
  cancelling: "running",
  stale: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  rejected: "rejected",
  unknown: "unknown",
};

function toRun(e: ApiExecution): Run {
  const started = e.startedAt ? Date.parse(e.startedAt) : null;
  const finished = e.finishedAt ? Date.parse(e.finishedAt) : null;
  return {
    id: e.id,
    pipelineId: e.pipelineId,
    number: e.runNumber ?? (e.externalRunId ? `#${e.externalRunId}` : "—"),
    status: SUMMARY[e.status],
    detailStatus: e.status,
    statusReason: e.statusReason,
    ref: e.ref ?? "",
    queuedAt: e.requestedAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    durationMinutes: started !== null && finished !== null ? Math.max(0, Math.round((finished - started) / 60000)) : null,
    trigger: e.triggerType === "external" ? "external" : e.triggerType === "schedule" ? "schedule" : "platform",
    parameters: e.parameters,
    queuePosition: e.queuePosition,
    rerunOf: e.rerunOf,
    requestedBy: e.requestedBy,
    systemVersion: e.systemVersion,
    tests: e.tests ?? null,
    ...(e.reportStatus ? { reportStatus: e.reportStatus } : {}),
    ...(e.failureKind ? { failureKind: e.failureKind } : {}),
    performance: e.performance ?? null,
  };
}

// ---------- Demonstração ----------

/** Tokens criados na demonstração (só em memória, sem valor real). */
const demoTokens: AccessToken[] = [];

const later = <T,>(value: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(value)), 40));

// Organização em uso na demonstração (a segunda só existe para mostrar a escolha na entrada).
let demoOrgId = demo.demoOrganizations[0]!.id;
const inMainDemoOrg = () => demoOrgId === demo.demoOrganizations[0]!.id;

function demoSessionNow(): SessionView {
  const s = structuredClone(demo.demoSession);
  const org = demo.demoOrganizations.find((o) => o.id === demoOrgId)!;
  s.organization = { ...s.organization!, id: org.id, name: org.name, slug: org.slug, role: org.role };
  if (org.role === "reader") {
    s.organization.permissions = Object.fromEntries(Object.keys(s.organization.permissions).map((k) => [k, k === "view"]));
  }
  return s;
}

export function demoSource(): DataSource {
  return {
    mode: "demo",
    session: () => later(demoSessionNow()),
    organizations: () => later(demo.demoOrganizations.map((o) => ({ ...o, active: o.id === demoOrgId }))),
    async switchOrganization(organizationId) {
      if (!demo.demoOrganizations.some((o) => o.id === organizationId)) throw new ApiError(404, "not-found", "Organização não encontrada.");
      demoOrgId = organizationId;
      return later(demoSessionNow());
    },
    workspaces: () => later(inMainDemoOrg() ? demo.demoWorkspaces : demo.demoLabWorkspaces),
    projects: () => later(inMainDemoOrg() ? demo.demoProjects : []),
    pipelines: (projectId) => later(inMainDemoOrg() ? demo.demoPipelines.filter((p) => !projectId || p.projectId === projectId) : []),
    async pipeline(id) {
      const pipeline = demo.demoPipelines.find((p) => p.id === id);
      if (!pipeline) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
      const manifest = demo.demoVersions[id]![0]!;
      const integration = demo.demoIntegrations[0]!;
      return later({
        pipeline,
        integration: { id: integration.id, name: integration.name, kind: integration.kind, status: integration.status },
        manifest,
        problems: compareWithProvider(manifest.manifest.parameters, pipeline.externalParameters),
      });
    },
    versions: (id) => later((demo.demoVersions[id] ?? []).map(({ manifest: _m, ...v }) => v)),
    async version(id, v) {
      const found = demo.demoVersions[id]?.find((x) => x.version === v);
      if (!found) throw new ApiError(404, "not-found", "Versão não encontrada.");
      return later(found);
    },
    integrations: () => later(demo.demoIntegrations),
    members: () => later(demo.demoMembers),
    audit: () => later(demo.demoAudit),
    runs: (pipelineId) => later(inMainDemoOrg() ? demo.demoRuns.filter((r) => !pipelineId || r.pipelineId === pipelineId) : []),
    profiles: (pipelineId) => later(demo.demoProfiles.filter((p) => p.pipelineId === pipelineId)),
    saveProfile: async (pipelineId, input, id) => later(demo.demoSaveProfile(pipelineId, input, id)),
    archiveProfile: async (id) => later(demo.demoArchiveProfile(id)),
    resources: () => later(demo.demoResources()),
    saveResource: async (input, id) => later(demo.demoSaveResource(input, id)),
    setResourceArchived: async (id, archived) => later(demo.demoArchiveResource(id, archived)),
    saveManifest: async (pipelineId, manifest, expectedVersion, note) => {
      await later(demo.demoSaveManifest(pipelineId, manifest, expectedVersion, note));
      return demoSource().pipeline(pipelineId);
    },
    execution: async (id) => later(demo.demoExecution(id)),
    executionLogs: async (id) => later(demo.demoLogs(id)),
    executionResults: async (id, filter) => later(demo.demoResults(id, filter)),
    pipelinePerformance: async (pipelineId) => later(demo.demoPerformanceTrend(pipelineId)),
    listRefs: (_pipelineId, search) => later(demo.demoRefs.filter((r) => !search || r.name.includes(search))),
    previewExecution: (input) => later(demo.demoPreview(input)),
    requestExecution: async (input) => {
      await later(null);
      return demo.demoRequest(input);
    },
    cancelExecution: async (id) => {
      await later(null);
      return demo.demoCancel(id);
    },
    rerunExecution: async (id) => {
      await later(null);
      return demo.demoRerun(id);
    },
    subscribe: (onChange) => demo.demoSubscribe(onChange),
    organization: () => later(demo.demoOrganization()),
    renameOrganization: async (name) => later(demo.demoRenameOrganization(name)),
    setOrganizationArchived: async (archived) => later(demo.demoSetOrganizationArchived(archived)),
    createOrganization: async (input) => later(demo.demoCreateOrganization(input)),
    accessMatrix: () => later(demo.ACCESS_MATRIX),
    accessPolicy: () => later(demo.demoPolicy),
    saveAccessPolicy: async (policy) => later(demo.demoSavePolicy(policy)),
    adminPipelines: () => later(inMainDemoOrg() ? demo.demoPipelines : []),
    adminWorkspaces: () => later(inMainDemoOrg() ? demo.demoWorkspaces : demo.demoLabWorkspaces),
    adminProjects: () => later(inMainDemoOrg() ? demo.demoProjects : []),
    createWorkspace: async (name) => later(demo.demoCreateWorkspace(name)),
    renameWorkspace: async (id, name) => later(demo.demoUpdate(demo.demoWorkspaces, id, { name })),
    setWorkspaceArchived: async (id, archived) => later(demo.demoArchive(demo.demoWorkspaces, id, archived)),
    createProject: async (workspaceId, name) => later(demo.demoCreateProject(workspaceId, name)),
    updateProject: async (id, input) => later(demo.demoUpdate(demo.demoProjects, id, input)),
    setProjectArchived: async (id, archived) => later(demo.demoArchive(demo.demoProjects, id, archived)),
    invite: async (input) => later(demo.demoInvite(input)),
    setMemberRole: async (userId, role) => {
      await later(demo.demoSetRole(userId, role));
    },
    removeMember: async (userId) => {
      await later(demo.demoRemoveMember(userId));
    },
    issuePasswordReset: async () => later({ url: `${location.origin}/redefinir-senha#token=demonstracao`, expiresAt: new Date(Date.now() + 86400000).toISOString() }),
    accessTokens: async () => later(demoTokens),
    createAccessToken: async ({ name, days }) => {
      const now = new Date();
      const accessToken: AccessToken = {
        id: crypto.randomUUID(),
        name,
        organizationId: "demo",
        organizationName: "Demonstração",
        createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + days * 86400000).toISOString(),
      };
      demoTokens.unshift(accessToken);
      return later({ token: "nexo_pat_demonstracao_sem_valor_real_000000000000", accessToken });
    },
    revokeAccessToken: async (id) => {
      demoTokens.splice(0, demoTokens.length, ...demoTokens.filter((t) => t.id !== id));
      await later(undefined);
    },
    createShareLink: async (input) => later(demo.demoCreateShare(input)),
    previewShareLink: async (input) => later(demo.demoShareView(input)),
    shareLinks: async (filter = {}) =>
      later(demo.demoShares.filter((l) => (!filter.pipelineId || l.pipelineId === filter.pipelineId) && (!filter.executionId || l.executionId === filter.executionId))),
    revokeShareLink: async (id) => later(demo.demoRevokeShare(id)),
    orgSettings: () => later(demo.demoSettings),
    saveOrgSettings: async (settings) => later(demo.demoSaveSettings(settings)),
    emailStatus: () => later({ enabled: false }),
    emailHistory: () => later([]),
    sendTestEmail: async () => {
      throw new ApiError(409, "conflict", "Na demonstração não há servidor de e-mail. Numa instalação real, configure SMTP_URL.");
    },
    aiProviders: () => later(demo.demoAiProviders),
    createAiProvider: async (input) => later(demo.demoCreateAiProvider(input)),
    testAiProvider: async (id) => later(demo.demoAiProviders.find((p) => p.id === id)!),
    archiveAiProvider: async (id) => later(demo.demoArchiveAiProvider(id)),
    mcpServers: () => later(demo.demoMcpServers),
    createMcpServer: async () => {
      throw new ApiError(409, "conflict", "Na demonstração não dá para conectar um servidor MCP de verdade. Veja o exemplo já cadastrado.");
    },
    refreshMcpServer: async (id) => later(demo.demoMcpServers.find((s) => s.id === id)!),
    setMcpTools: async (id, tools) => later(demo.demoSetMcpTools(id, tools)),
    archiveMcpServer: async (id) => later(demo.demoArchiveMcpServer(id)),
    assistSessions: () => later(demo.demoAssistSessions),
    startAssistSession: async (input) => later(demo.demoStartAssist(input)),
    assistSession: async (id) => later(demo.demoAssistSession(id)),
    applyAssistSession: async (id, input) => {
      const session = demo.demoApplyAssist(id, input.manifest);
      return demoSource().pipeline(session.appliedPipelineId!);
    },
    discardAssistSession: async (id) => {
      await later(demo.demoDiscardAssist(id));
    },
    rules: (pipelineId) => later(demo.demoRules.filter((r) => !r.archivedAt && (!pipelineId || !r.pipelineId || r.pipelineId === pipelineId))),
    saveRule: async (input, id) => {
      await later(null);
      return demo.demoSaveRule(input, id);
    },
    archiveRule: async (id) => {
      await later(null);
      return demo.demoArchiveRule(id);
    },
    alerts: (open) => later(inMainDemoOrg() ? demo.demoAlerts.filter((a) => !open || !a.resolvedAt) : []),
    resolveAlert: async (id, note) => {
      await later(null);
      return demo.demoResolveAlert(id, note);
    },
    connectors: () => later(["azure-devops", "github"]),
    createIntegration: async (input) => {
      await later(null);
      return demo.demoCreateIntegration(input);
    },
    discover: async (integrationId, q) => later(demo.demoDiscover(integrationId, q.q)),
    definition: (pipelineId) => later(demo.demoDefinition(pipelineId)),
    previewDefinition: (pipelineId, content) => later(demo.demoPreviewDefinition(pipelineId, content)),
    applyDefinition: async (pipelineId, input) => {
      const change = await later(demo.demoApplyDefinition(pipelineId, input));
      return { change, pipeline: input.mode === "commit" ? await demoSource().pipeline(pipelineId) : null };
    },
    repositories: () => later(demo.demoRepositories),
    pipelineTemplates: () => later(demo.DEMO_TEMPLATES),
    renderTemplate: (input) => later(demo.demoRenderTemplate(input)),
    createPipeline: async (input) => {
      const change = await later(demo.demoCreatePipelineChange(input));
      if (input.mode !== "commit") return { change, pipeline: null };
      const detail = await demoSource().importPipeline({ projectId: input.projectId, integrationId: input.integrationId, externalId: demo.demoNewExternalId(input.name) });
      return { change, pipeline: detail };
    },
    importPipeline: async (input) => {
      await later(null);
      const created = demo.demoImport(input);
      return demoSource().pipeline(created.id);
    },
    syncPipeline: async (id) => {
      await later(null);
      demo.demoSync(id);
      return demoSource().pipeline(id);
    },
  };
}

/**
 * Mesma fonte de dados, recortada no workspace escolhido na entrada: a árvore, a visão geral e as
 * listas só mostram projetos, pipelines e execuções desse workspace. Integrações, membros e
 * auditoria são da organização e continuam inteiros.
 */
export function scopeToWorkspace(data: DataSource, workspaceId: string): DataSource {
  const projectIds = async () => new Set((await data.projects()).filter((p) => p.workspaceId === workspaceId).map((p) => p.id));
  const pipelineIds = async () => {
    const ids = await projectIds();
    return new Set((await data.pipelines()).filter((p) => ids.has(p.projectId)).map((p) => p.id));
  };
  return {
    ...data,
    workspaces: async () => (await data.workspaces()).filter((w) => w.id === workspaceId),
    projects: async () => (await data.projects()).filter((p) => p.workspaceId === workspaceId),
    async pipelines(projectId) {
      const [ids, list] = await Promise.all([projectIds(), data.pipelines(projectId)]);
      return list.filter((p) => ids.has(p.projectId));
    },
    async runs(pipelineId) {
      const [ids, list] = await Promise.all([pipelineIds(), data.runs(pipelineId)]);
      return list && list.filter((r) => ids.has(r.pipelineId));
    },
  };
}
