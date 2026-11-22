// Formas das respostas da API (incrementos 1 e 2), com datas em texto ISO, como chegam no JSON.

export type Role = "admin" | "manager" | "operator" | "reader";

export interface SessionView {
  user: { id: string; email: string; displayName: string; isInstanceAdmin: boolean };
  organization: {
    id: string;
    name: string;
    slug: string;
    archived: boolean;
    role: Role;
    permissions: Record<string, boolean>;
  } | null;
  csrfToken: string;
  expiresAt: string;
}

/** Organização a que o usuário pertence (GET /api/organizations): é onde o acesso é concedido. */
export interface OrganizationChoice {
  id: string;
  name: string;
  slug: string;
  role: Role;
  archivedAt: string | null;
  /** É a organização em uso nesta sessão. */
  active: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  archivedAt: string | null;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  archivedAt: string | null;
}

export type ParameterSpec =
  | { name: string; label?: string; required: boolean; scope: "common" | "provider"; type: "string"; default?: string }
  | { name: string; label?: string; required: boolean; scope: "common" | "provider"; type: "number"; default?: number }
  | { name: string; label?: string; required: boolean; scope: "common" | "provider"; type: "boolean"; default?: boolean }
  | { name: string; label?: string; required: boolean; scope: "common" | "provider"; type: "enum"; options: string[]; default?: string };

export interface ValidationRule {
  id: string;
  message: string;
  when: { parameter: string; equals: string | number | boolean };
  then: { parameter: string; in: Array<string | number | boolean> };
}

export interface PipelineManifest {
  schemaVersion: "1";
  organizationRef: string;
  projectRef: string;
  provider: { kind: string; integrationRef: string };
  pipeline: { externalId: string; displayName: string };
  parameters: ParameterSpec[];
  validationRules: ValidationRule[];
  executionResources: Array<{ ref: string; exclusive: boolean }>;
  reports: Array<{ type: string }>;
  review: { status: "draft" | "approved"; requiresHumanApproval: boolean };
  /** Qual sistema a pipeline testa e de onde ler a versão dele em cada execução. */
  systemUnderTest?: SystemUnderTest;
}

export interface VersionPart {
  key: string;
  label: string;
  source: "runNumber" | "tag" | "parameter";
  parameter?: string;
  tagPrefix?: string;
  pattern?: string;
}

export interface SystemUnderTest {
  name: string;
  parts: VersionPart[];
}

/** Versão do sistema em teste capturada numa execução (ex.: distribuição e pacote). */
export interface SystemVersion {
  system: string;
  full: string;
  parts: Array<{ key: string; label: string; value: string }>;
  missing: string[];
}

export interface Capabilities {
  read: Record<"pipelines" | "parameters" | "runs" | "logs" | "artifacts" | "schedules" | "definition", boolean>;
  write: Record<"triggerRun" | "cancelRun" | "definitionViaApi" | "definitionViaCommit" | "definitionViaPullRequest", boolean>;
  events: { webhooks: boolean };
}

export interface LinkedPipeline {
  id: string;
  projectId: string;
  integrationId: string;
  externalId: string;
  name: string;
  externalUrl: string | null;
  externalPath: string | null;
  repositoryName: string | null;
  repositoryUrl: string | null;
  defaultRef: string | null;
  parametersRef: string | null;
  externalRevision: string | null;
  definitionRevision: string | null;
  capabilities: Capabilities;
  externalParameters: ParameterSpec[];
  syncState: "synchronized" | "pending" | "unknown";
  syncProblem: string | null;
  syncedAt: string | null;
  currentVersion: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface ManifestVersion {
  pipelineId: string;
  version: number;
  manifest: PipelineManifest;
  source: "discovery" | "manual" | "import" | "assist";
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ParameterProblem {
  parameter: string;
  severity: "error" | "info";
  message: string;
}

export interface PipelineDetail {
  pipeline: LinkedPipeline;
  integration: { id: string; name: string; kind: string; status: Integration["status"] };
  manifest: ManifestVersion;
  problems: ParameterProblem[];
}

export interface Integration {
  id: string;
  kind: string;
  name: string;
  endpoint: string;
  credentialKind: string;
  credentialUpdatedAt: string;
  status: "ok" | "failing" | "unchecked";
  lastCheck: { ok: boolean; identity?: string; missingPermissions: string[]; message?: string } | null;
  lastCheckedAt: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface Member {
  userId: string;
  displayName: string;
  email?: string;
  status: "invited" | "active" | "disabled";
  role: Role;
  since: string;
  invitePending: boolean;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorKind: string;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: "success" | "denied" | "failed";
  details: Record<string, unknown>;
  occurredAt: string;
}

/** Estado resumido de uma execução, para gráficos e selos. */
export type RunStatus = "succeeded" | "failed" | "cancelled" | "running" | "queued" | "rejected" | "unknown";

/** Estado completo vindo da API (incremento 3). */
export type ExecutionStatus =
  | "queued"
  | "rejected"
  | "dispatching"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "stale"
  | "unknown";

export interface Run {
  id: string;
  pipelineId: string;
  number: string;
  status: RunStatus;
  ref: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMinutes: number | null;
  /** schedule = agenda do provedor; manual = manual no provedor; platform = pela plataforma; external = fora da plataforma. */
  trigger: "schedule" | "manual" | "platform" | "external";
  parameters: Record<string, string | number | boolean>;
  /** Estado detalhado (cancelando, sem notícia...), quando vem da API. */
  detailStatus?: ExecutionStatus;
  statusReason?: string | null;
  queuePosition?: number | null;
  rerunOf?: string | null;
  systemVersion?: SystemVersion | null;
  requestedBy?: string | null;
  /** Contagem dos testes lidos dos relatórios; null = ainda sem relatório. */
  tests?: TestSummary | null;
  reportStatus?: ReportStatus;
  failureKind?: FailureKind;
  /** Desempenho (k6): thresholds e p95; null = execução sem resumo de desempenho. */
  performance?: { thresholdsTotal: number; thresholdsFailed: number; latencyP95: number | null } | null;
}

export type ReportStatus = "pending" | "available" | "partial" | "missing" | "invalid";
export type FailureKind = "none" | "test" | "infrastructure" | "threshold" | "unknown";
export type TestStatus = "passed" | "failed" | "skipped" | "flaky";

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
}

export interface TestResult {
  id: string;
  reportId: string;
  suite: string;
  name: string;
  file: string | null;
  project: string | null;
  status: TestStatus;
  durationMs: number | null;
  attempts: number;
  errorMessage: string | null;
  errorDetails: string | null;
  attachments: Array<{ name: string; contentType?: string; path?: string }> | null;
}

export interface ExecutionResults {
  executionId: string;
  reportStatus: ReportStatus;
  failureKind: FailureKind;
  summary: TestSummary | null;
  artifacts: Array<{ id: string; name: string; sizeBytes: number | null; status: "stored" | "skipped" | "failed"; reason: string | null; createdAt: string }>;
  reports: Array<{ id: string; artifactId: string; filePath: string; processorId: string; category: string; status: "processed" | "partial" | "unsupported" | "failed"; reason: string | null; tests: number }>;
  tests: TestResult[];
  /** Desempenho (k6), separado dos testes (RN-045). */
  performance: PerformanceResult[];
}

// ---------- Desempenho (incremento 6) ----------

export interface PerformanceMetric {
  name: string;
  type: "trend" | "rate" | "counter" | "gauge";
  contains: "time" | "data" | "default";
  values: Record<string, number>;
}

/** Resumo de desempenho de uma execução. Latência em ms; taxas de 0 a 1; vazão por segundo. */
export interface PerformanceResult {
  id: string;
  reportId: string;
  format: string;
  durationMs: number | null;
  vusMax: number | null;
  iterations: number | null;
  httpReqs: number | null;
  httpReqRate: number | null;
  httpReqFailedRate: number | null;
  latency: { avg: number | null; med: number | null; p90: number | null; p95: number | null; p99: number | null; max: number | null };
  checksRate: number | null;
  thresholdsTotal: number;
  thresholdsFailed: number;
  metrics: PerformanceMetric[];
  thresholds: Array<{ metric: string; expression: string; ok: boolean }>;
}

/** Ponto da série histórica de desempenho de uma pipeline. */
export interface PerformancePoint {
  executionId: string;
  finishedAt: string | null;
  runNumber: string | null;
  status: string;
  latencyP95: number | null;
  latencyP99: number | null;
  latencyAvg: number | null;
  httpReqRate: number | null;
  httpReqFailedRate: number | null;
  vusMax: number | null;
  thresholdsTotal: number;
  thresholdsFailed: number;
}

export interface ExecutionProfile {
  id: string;
  pipelineId: string;
  name: string;
  description: string | null;
  ref: string | null;
  parameters: Record<string, string | number | boolean>;
}

export interface ExecutionInput {
  pipelineId: string;
  profileId?: string;
  ref?: string;
  parameters?: Record<string, string | number | boolean>;
  idempotencyKey?: string;
  allowDuplicate?: boolean;
}

/** Prévia do pedido, para a confirmação (RF-044). */
export interface ExecutionPreview {
  pipeline: { id: string; name: string };
  manifestVersion: number;
  ref: string | null;
  parameters: Record<string, string | number | boolean>;
  violations: Array<{ parameter: string; message: string; ruleId?: string }>;
  resources: Array<{ id: string; ref: string; name: string; busyPolicy: "queue" | "reject"; busy: boolean }>;
  missingResources: string[];
  decision: { outcome: "dispatch" | "queue" | "reject" | "blocked"; reasons: string[]; queuedAhead: number };
  systemVersion: SystemVersion | null;
  /** Parâmetros que valem para a ref escolhida (o YAML muda por branch). */
  parameterSpecs: ParameterSpec[];
  parametersFrom: "manifest" | "branch";
  /** O que o provedor disse ao validar sem executar; ok null = não respondeu. */
  providerCheck: { ok: boolean; problems: string[] } | { ok: null; message: string } | null;
}

/** Branch ou tag do repositório da pipeline. */
export interface ExternalRef {
  name: string;
  ref: string;
  kind: "branch" | "tag";
}

export interface ConnectionCheck {
  ok: boolean;
  identity?: string;
  missingPermissions: string[];
  message?: string;
}

export interface DiscoveredPipeline {
  externalId: string;
  name: string;
  path?: string;
  url?: string;
  /** Projetos desta organização em que a pipeline já está vinculada. */
  linkedProjectIds: string[];
}

// ---------- Regras de evento e avisos ----------

export type Severity = "info" | "warning" | "critical";
/** Resultados finais que podem disparar uma regra. */
export type RuleStatus = "succeeded" | "failed" | "cancelled" | "unknown";

export interface RuleCondition {
  parameter: string;
  in: Array<string | number | boolean>;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  /** null = qualquer pipeline da organização. */
  pipelineId: string | null;
  onStatus: RuleStatus[];
  conditions: RuleCondition[];
  severity: Severity;
  title: string;
  message: string;
  channels: string[];
  /** E-mails que recebem o aviso quando o canal e-mail está ligado. */
  recipients: string[];
  archivedAt: string | null;
}

export type RuleInput = Pick<NotificationRule, "name" | "enabled" | "pipelineId" | "onStatus" | "conditions" | "severity" | "title" | "message"> & {
  channels?: string[];
  recipients?: string[];
};

export interface Alert {
  id: string;
  ruleId: string;
  executionId: string;
  pipelineId: string;
  pipelineName: string;
  severity: Severity;
  title: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

// ---------- Administração (organização, workspaces, projetos, membros) ----------

export interface Organization {
  id: string;
  name: string;
  slug: string;
  archivedAt: string | null;
}

export type Operation =
  | "view"
  | "execute"
  | "cancel"
  | "configurePipelines"
  | "manageIntegrations"
  | "createProjects"
  | "manageUsers"
  | "share"
  | "viewAudit";

/** "policy" = depende do que a organização concede ("Conforme política" no §6). */
export type Grant = "allow" | "deny" | "policy";

export interface AccessMatrix {
  roles: Role[];
  operations: Operation[];
  matrix: Record<Role, Record<Operation, Grant>>;
}

/** Concessões da organização nos casos "policy", por papel. */
export type AccessPolicy = Partial<Record<Role, Operation[]>>;

/** Token pessoal de acesso para API e MCP (ADR-017). O valor só aparece na criação. */
export interface AccessToken {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** Link de uso único (convite ou redefinição de senha). Com SMTP configurado, também vai por e-mail. */
export interface IssuedLink {
  url: string;
  expiresAt: string;
  /** O mesmo link foi para a fila de e-mail. */
  emailed?: boolean;
}

// ---------- Distribuição (incremento 7) ----------

export interface ShareOptions {
  parameters: boolean;
  errorDetails: boolean;
  branch: boolean;
  systemVersion: boolean;
  periodDays: number;
}

export interface ShareInput {
  scope: "execution" | "pipeline";
  pipelineId?: string;
  executionId?: string;
  access: "public" | "members";
  title?: string;
  days?: number;
  options?: Partial<ShareOptions>;
}

export interface ShareLink {
  id: string;
  scope: "execution" | "pipeline";
  pipelineId: string;
  pipelineName: string;
  executionId: string | null;
  access: "public" | "members";
  title: string;
  options: ShareOptions;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  status: "active" | "expired" | "revoked";
}

export interface PublicTest {
  suite: string;
  name: string;
  file: string | null;
  project: string | null;
  status: TestStatus;
  durationMs: number | null;
  attempts: number;
  errorMessage: string | null;
  errorDetails: string | null;
}

export interface PublicExecution {
  number: string;
  status: ExecutionStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  branch: string | null;
  systemVersion: string | null;
  parameters: Record<string, string | number | boolean> | null;
  reportStatus: ReportStatus;
  failureKind: FailureKind;
  summary: TestSummary | null;
  tests: PublicTest[];
  testsTruncated: boolean;
  performance: Array<Pick<PerformanceResult, "durationMs" | "vusMax" | "httpReqs" | "httpReqRate" | "httpReqFailedRate" | "latency" | "thresholds">>;
}

export interface PublicRun {
  number: string;
  status: ExecutionStatus;
  requestedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  failureKind: FailureKind;
  tests: Omit<TestSummary, "durationMs"> | null;
  performance: { latencyP95: number | null; thresholdsFailed: number; thresholdsTotal: number } | null;
}

/** O que o visitante de um link vê: a mesma forma na prévia e na página pública. */
export interface PublicView {
  kind: "execution" | "pipeline";
  title: string;
  organizationName: string;
  pipelineName: string;
  access: "public" | "members";
  expiresAt: string;
  generatedAt: string;
  execution?: PublicExecution;
  pipeline?: { periodDays: number; runs: PublicRun[] };
  omitted: string[];
}

export interface OrgSettings {
  sharing: { allowPublic: boolean; defaultDays: number; maxDays: number };
  retention: { artifactsDays: number; resultsDays: number; emailsDays: number };
}

export interface EmailHistoryItem {
  id: string;
  kind: "rule" | "invite" | "password-reset" | "test";
  recipient: string;
  subject: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

// ---------- Recursos, perfis e detalhe de execução (incremento 3) ----------

export interface ExecResource {
  id: string;
  ref: string;
  name: string;
  description: string | null;
  /** Ocupado: "queue" = espera na fila; "reject" = recusa o pedido. */
  busyPolicy: "queue" | "reject";
  leaseTtlSeconds: number;
  archivedAt: string | null;
  /** Quem segura o recurso agora. */
  lease: { executionId: string; holderKind: "internal" | "external"; since: string; expiresAt: string; expired: boolean } | null;
  queued: number;
}

export interface ResourceInput {
  ref?: string;
  name: string;
  description?: string;
  busyPolicy: "queue" | "reject";
  leaseTtlSeconds: number;
}

export interface ProfileInput {
  name: string;
  description?: string;
  ref?: string;
  parameters: Record<string, string | number | boolean>;
}

export interface ExecutionDetail {
  execution: Run & { externalRunId: string | null; failureKind: FailureKind; reportStatus: ReportStatus; runTags: string[]; agentOrPool: string | null };
  pipeline: { id: string; name: string; externalUrl: string | null; capabilities: Capabilities };
  transitions: Array<{ fromStatus: string | null; toStatus: string; reason: string | null; actorUserId: string | null; occurredAt: string }>;
  leases: Array<{ resourceId: string; resourceName: string; holderKind: "internal" | "external"; expiresAt: string }>;
  reruns: string[];
}

// ---------- Arquivo da pipeline e criação por modelo (incremento 4) ----------

export type ChangeMode = "commit" | "pull-request";

export interface DefinitionView {
  pipelineId: string;
  ref: string | null;
  path: string | null;
  format: "yaml" | "json" | "provider";
  content: string;
  revision: string;
  modes: ChangeMode[];
}

export interface DiffLine {
  kind: "same" | "add" | "remove" | "skip";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DefinitionPreview {
  diff: { lines: DiffLine[]; added: number; removed: number; changed: boolean };
  problems: string[];
  revision: string;
}

export interface AppliedChange {
  mode: ChangeMode | "api";
  externalRevision: string;
  url?: string;
  branch?: string;
}

export interface ExternalRepository {
  id: string;
  name: string;
  scope: string;
  defaultBranch?: string;
  url?: string;
}

export interface TemplateField {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "boolean" | "select";
  default: string | boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  report: string;
  fields: TemplateField[];
}

export interface NewPipelineInput {
  projectId: string;
  integrationId: string;
  repositoryId: string;
  branch: string;
  path: string;
  name: string;
  content: string;
  mode: ChangeMode;
  message?: string;
}

// ---------- IA própria + MCP (incremento 8) ----------

export interface AiProvider {
  id: string;
  name: string;
  kind: "anthropic" | "openai-compatible";
  endpoint: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  hasCredential: boolean;
  lastCheck: { ok: boolean; message: string } | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface AiProviderInput {
  name: string;
  kind: AiProvider["kind"];
  endpoint?: string;
  model: string;
  effort?: AiProvider["effort"];
  apiKey?: string;
}

export interface McpTool {
  name: string;
  description: string;
  readOnlyHint: boolean;
  kind: "read" | "mutate";
  authorized: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  authHeader: string | null;
  hasCredential: boolean;
  tools: McpTool[];
  serverInfo: { name?: string; version?: string } | null;
  lastCheck: { ok: boolean; message: string } | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface AssistReview {
  manifest: PipelineManifest | null;
  problems: string[];
  warnings: string[];
  changes: string[];
  notes: { summary: string; sources: string[]; uncertainties: string[] };
}

export interface AssistSession {
  id: string;
  projectId: string;
  integrationId: string;
  externalId: string;
  ref: string | null;
  pipelineName: string;
  providerId: string;
  providerName: string;
  mcpTools: string[];
  status: "queued" | "running" | "proposed" | "failed" | "applied" | "discarded";
  providerParameters: string[];
  review: AssistReview | null;
  steps: Array<{ tool: string; source: string; input: string; ok: boolean; chars: number; ms: number }>;
  usage: { inputTokens: number; outputTokens: number; turns: number } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  appliedPipelineId: string | null;
}

export interface AssistSessionInput {
  projectId: string;
  integrationId: string;
  externalId: string;
  ref?: string;
  providerId: string;
  mcpTools: string[];
  acknowledged: boolean;
}
