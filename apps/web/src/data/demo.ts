import type {
  AuditEvent,
  Capabilities,
  Integration,
  LinkedPipeline,
  ManifestVersion,
  Member,
  OrganizationChoice,
  ExecutionInput,
  ExecutionPreview,
  ExecutionProfile,
  ExternalRef,
  SystemVersion,
  Alert,
  NotificationRule,
  RuleInput,
  AccessMatrix,
  AccessPolicy,
  ExecResource,
  ExecutionDetail,
  ProfileInput,
  ResourceInput,
  IssuedLink,
  Organization,
  Role,
  ParameterSpec,
  PipelineManifest,
  Project,
  Run,
  RunStatus,
  SessionView,
  Workspace,
  ExecutionResults,
  TestResult,
  TestStatus,
  AppliedChange,
  ChangeMode,
  DefinitionPreview,
  DefinitionView,
  DiffLine,
  ExternalRepository,
  NewPipelineInput,
  PipelineTemplate,
  TemplateField,
  PerformancePoint,
  PerformanceResult,
  OrgSettings,
  PublicView,
  ShareInput,
  ShareLink,
  ShareOptions,
  AiProvider,
  AiProviderInput,
  AssistSession,
  AssistSessionInput,
  McpServer,
  McpTool,
} from "./types.ts";
import { ApiError } from "./errors.ts";

// Dados FICTÍCIOS para o modo demonstração. Imitam o formato e o comportamento observados no
// spike S1 (parâmetros por branch, execução agendada de madrugada, muitas falhas e cancelamentos),
// sem nenhum nome, id ou valor real de cliente (regra do repositório).

const ORG = { id: "00000000-0000-4000-8000-000000000001", name: "Empresa Exemplo", slug: "exemplo" };
const WS = "00000000-0000-4000-8000-0000000000a1";
export const PROJECT_WEB = "00000000-0000-4000-8000-0000000000b1";
export const PROJECT_MOBILE = "00000000-0000-4000-8000-0000000000b2";
const INTEGRATION = "00000000-0000-4000-8000-0000000000c1";
export const PIPE_E2E = "00000000-0000-4000-8000-0000000000d1";
export const PIPE_API = "00000000-0000-4000-8000-0000000000d2";
export const PIPE_MOBILE = "00000000-0000-4000-8000-0000000000d3";
export const PIPE_K6 = "00000000-0000-4000-8000-0000000000d4";
const PROJECT_LOAD = "00000000-0000-4000-8000-0000000000b3";

export const demoSession: SessionView = {
  user: { id: "u-demo", email: "voce@exemplo.test", displayName: "Você (demonstração)", isInstanceAdmin: true },
  organization: {
    ...ORG,
    archived: false,
    role: "admin",
    permissions: {
      view: true,
      execute: true,
      cancel: true,
      configurePipelines: true,
      manageIntegrations: true,
      createProjects: true,
      manageUsers: true,
      share: true,
      viewAudit: true,
    },
  },
  csrfToken: "demo",
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};

const WS_PERF = "00000000-0000-4000-8000-0000000000a2";

/** Segunda organização da demonstração: mostra a escolha de organização na entrada. */
export const DEMO_LAB_ORG = { id: "00000000-0000-4000-8000-000000000002", name: "Laboratório Exemplo", slug: "laboratorio" };

export const demoOrganizations: OrganizationChoice[] = [
  { ...ORG, role: "admin", archivedAt: null, active: true },
  { ...DEMO_LAB_ORG, role: "reader", archivedAt: null, active: false },
];

export const demoWorkspaces: Workspace[] = [
  { id: WS, name: "Qualidade", archivedAt: null },
  { id: WS_PERF, name: "Desempenho", archivedAt: null },
];

/** Workspaces da organização de laboratório (sem projetos: a demonstração só navega até a escolha). */
export const demoLabWorkspaces: Workspace[] = [{ id: "00000000-0000-4000-8000-0000000000a9", name: "Pesquisa", archivedAt: null }];

export const demoProjects: Project[] = [
  { id: PROJECT_WEB, workspaceId: WS, name: "Sistema Web", archivedAt: null },
  { id: PROJECT_MOBILE, workspaceId: WS, name: "Aplicativo", archivedAt: null },
  { id: PROJECT_LOAD, workspaceId: WS_PERF, name: "Carga (k6)", archivedAt: null },
];

const CAPS: Capabilities = {
  read: { pipelines: true, parameters: true, runs: true, logs: true, artifacts: true, schedules: false, definition: true },
  write: { triggerRun: true, cancelRun: true, definitionViaApi: false, definitionViaCommit: true, definitionViaPullRequest: true },
  events: { webhooks: false },
};

const p = (spec: {
  name: string;
  type: ParameterSpec["type"];
  label?: string;
  default?: string | number | boolean;
  options?: string[];
  required?: boolean;
}): ParameterSpec => ({ required: false, scope: "provider", ...spec }) as ParameterSpec;

const E2E_PARAMS: ParameterSpec[] = [
  p({ name: "branchAplicacao", label: "Branch da aplicação", type: "string", default: "main" }),
  p({ name: "massaDados", label: "Arquivo de massa de dados", type: "string", default: "massa-padrao.json" }),
  p({ name: "limparDados", label: "Limpar dados de teste", type: "boolean", default: true }),
  p({ name: "buildFrontend", label: "Build do frontend", type: "boolean", default: true }),
  p({ name: "buildBackend", label: "Build do backend", type: "boolean", default: true }),
  p({ name: "testesChromium", label: "Rodar testes no Chromium", type: "boolean", default: true }),
  p({ name: "testesFirefox", label: "Rodar testes no Firefox", type: "boolean", default: false }),
  p({ name: "testesWebkit", label: "Rodar testes no WebKit", type: "boolean", default: false }),
];

function manifestFor(pipe: LinkedPipeline, params: ParameterSpec[], extra: Partial<PipelineManifest> = {}): PipelineManifest {
  return {
    schemaVersion: "1",
    organizationRef: ORG.slug,
    projectRef: pipe.projectId,
    provider: { kind: "azure-devops", integrationRef: "Azure DevOps" },
    pipeline: { externalId: pipe.externalId, displayName: pipe.name },
    parameters: params,
    validationRules: [],
    executionResources: [],
    reports: [],
    review: { status: "draft", requiresHumanApproval: true },
    ...extra,
  };
}

const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function pipeline(over: Partial<LinkedPipeline> & Pick<LinkedPipeline, "id" | "name" | "projectId" | "externalId">): LinkedPipeline {
  return {
    integrationId: INTEGRATION,
    externalUrl: "https://dev.azure.com/exemplo/_build",
    externalPath: "Sistema Web",
    repositoryName: "sistema-web",
    repositoryUrl: "https://dev.azure.com/exemplo/Sistema%20Web/_git/sistema-web",
    defaultRef: "refs/heads/main",
    parametersRef: "refs/heads/main",
    externalRevision: "3",
    definitionRevision: "4f2a9c1",
    capabilities: CAPS,
    externalParameters: [],
    syncState: "synchronized",
    syncProblem: null,
    syncedAt: days(0.02),
    currentVersion: 1,
    createdAt: days(12),
    archivedAt: null,
    ...over,
  };
}

export const demoPipelines: LinkedPipeline[] = [
  pipeline({
    id: PIPE_E2E,
    name: "testes-e2e-playwright",
    projectId: PROJECT_WEB,
    externalId: "proj-web/381",
    parametersRef: "refs/heads/testes-maquina",
    repositoryName: "testes-e2e",
    repositoryUrl: "https://dev.azure.com/exemplo/Sistema%20Web/_git/testes-e2e",
    externalRevision: "5",
    definitionRevision: "6c883c1",
    externalParameters: E2E_PARAMS,
    currentVersion: 2,
  }),
  pipeline({
    id: PIPE_API,
    name: "testes-api",
    projectId: PROJECT_WEB,
    externalId: "proj-web/402",
    externalParameters: [p({ name: "ambiente", label: "Ambiente", type: "enum", options: ["homologacao", "staging"], default: "homologacao" })],
    syncState: "unknown",
    syncProblem: "O provedor não respondeu. Tente de novo em instantes.",
    syncedAt: days(1.4),
  }),
  pipeline({
    id: PIPE_MOBILE,
    name: "build-aplicativo",
    projectId: PROJECT_MOBILE,
    externalId: "proj-mobile/321",
    externalPath: "Aplicativo",
    repositoryName: "aplicativo",
    repositoryUrl: "https://dev.azure.com/exemplo/Aplicativo/_git/aplicativo",
    externalParameters: [],
  }),
  pipeline({
    id: PIPE_K6,
    name: "carga-api-k6",
    projectId: PROJECT_LOAD,
    externalId: "proj-web/455",
    externalPath: "Sistema Web",
    repositoryName: "testes-carga",
    repositoryUrl: "https://dev.azure.com/exemplo/Sistema%20Web/_git/testes-carga",
    externalParameters: [p({ name: "usuarios", label: "Usuários virtuais", type: "number", default: 50 })],
  }),
];

const E2E_V1 = manifestFor(demoPipelines[0]!, E2E_PARAMS);
const E2E_V2 = manifestFor(demoPipelines[0]!, E2E_PARAMS, {
  validationRules: [
    {
      id: "limpeza-so-chromium",
      message: "Limpar os dados só vale com testes no Chromium",
      when: { parameter: "limparDados", equals: true },
      then: { parameter: "testesChromium", in: [true] },
    },
  ],
  executionResources: [{ ref: "maquina-testes", exclusive: true }],
  reports: [{ type: "playwright-json" }],
  // A pipeline de exemplo clona o sistema, pega a última tag de versão e marca a execução com
  // "sistema-<distribuição>-<pacote>" (ex.: sistema-master-20250114.18).
  systemUnderTest: {
    name: "Sistema Web",
    parts: [
      { key: "distribuicao", label: "Distribuição", source: "tag", tagPrefix: "sistema-", pattern: "^(?<value>[^-]+)-" },
      { key: "pacote", label: "Pacote", source: "tag", tagPrefix: "sistema-", pattern: "^[^-]+-(?<value>.+)$" },
    ],
  },
});

export const demoVersions: Record<string, ManifestVersion[]> = {
  [PIPE_E2E]: [
    { pipelineId: PIPE_E2E, version: 2, manifest: E2E_V2, source: "manual", note: "Regra de restauração e máquina exclusiva", createdBy: "u-demo", createdAt: days(3) },
    { pipelineId: PIPE_E2E, version: 1, manifest: E2E_V1, source: "discovery", note: null, createdBy: "u-demo", createdAt: days(12) },
  ],
  [PIPE_API]: [
    {
      pipelineId: PIPE_API,
      version: 1,
      manifest: manifestFor(demoPipelines[1]!, demoPipelines[1]!.externalParameters),
      source: "discovery",
      note: null,
      createdBy: "u-demo",
      createdAt: days(9),
    },
  ],
  [PIPE_MOBILE]: [
    {
      pipelineId: PIPE_MOBILE,
      version: 1,
      manifest: manifestFor(demoPipelines[2]!, []),
      source: "discovery",
      note: null,
      createdBy: "u-demo",
      createdAt: days(8),
    },
  ],
  [PIPE_K6]: [
    {
      pipelineId: PIPE_K6,
      version: 1,
      manifest: manifestFor(demoPipelines[3]!, demoPipelines[3]!.externalParameters, { reports: [{ type: "k6-summary" }] }),
      source: "discovery",
      note: null,
      createdBy: "u-demo",
      createdAt: days(6),
    },
  ],
};

export const demoIntegrations: Integration[] = [
  {
    id: INTEGRATION,
    kind: "azure-devops",
    name: "Azure DevOps",
    endpoint: "https://dev.azure.com/exemplo",
    credentialKind: "pat",
    credentialUpdatedAt: days(12),
    status: "ok",
    lastCheck: { ok: true, missingPermissions: [] },
    lastCheckedAt: days(0.3),
    createdAt: days(12),
    archivedAt: null,
  },
];

export const demoMembers: Member[] = [
  { userId: "u-demo", displayName: "Você (demonstração)", email: "voce@exemplo.test", status: "active", role: "admin", since: days(14), invitePending: false },
  { userId: "u-2", displayName: "Pessoa Analista", email: "analista@exemplo.test", status: "active", role: "operator", since: days(10), invitePending: false },
  { userId: "u-3", displayName: "Pessoa Gestora", email: "gestora@exemplo.test", status: "invited", role: "manager", since: days(2), invitePending: true },
];

export const demoAudit: AuditEvent[] = [
  ["pipeline.manifest.save", "pipeline", PIPE_E2E, "success", 3],
  ["pipeline.sync", "pipeline", PIPE_API, "failed", 1.4],
  ["pipeline.import", "pipeline", PIPE_MOBILE, "success", 8],
  ["pipeline.import", "pipeline", PIPE_E2E, "success", 12],
  ["integration.test", "integration", INTEGRATION, "success", 0.3],
  ["integration.create", "integration", INTEGRATION, "success", 12],
  ["integration.create", "integration", null, "failed", 12.01],
  ["member.invite", "user", "u-3", "success", 2],
].map(([action, targetType, targetId, outcome, ago], i) => ({
  id: String(100 - i),
  actorUserId: "u-demo",
  actorKind: "user",
  action: action as string,
  targetType: targetType as string,
  targetId: targetId as string | null,
  outcome: outcome as AuditEvent["outcome"],
  details: {},
  occurredAt: days(ago as number),
}));

// ---------- Execuções (o incremento 3 traz as reais) ----------

/** Gerador determinístico: a demonstração mostra sempre o mesmo histórico. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

interface RunProfile {
  pipelineId: string;
  ref: string;
  seed: number;
  /** Horários fixos (UTC) e chance de disparos extras por dia. */
  hours: number[];
  extraChance: number;
  cancelRate: number;
  /** Chance de falha nos primeiros 15 dias e nos últimos 15. */
  failEarly: number;
  failLate: number;
  minutes: [number, number];
  parameters: Run["parameters"];
  /** A pipeline marca distribuição e pacote no número da execução. */
  versioned?: boolean;
}

// Cada pipeline com um comportamento: a e2e é lenta e instável; a de API roda várias vezes ao dia e
// quase sempre passa; o build do aplicativo começou a falhar na última semana.
const PROFILES: RunProfile[] = [
  {
    pipelineId: PIPE_E2E,
    ref: "refs/heads/testes-maquina",
    seed: 42,
    hours: [6],
    extraChance: 0.55,
    cancelRate: 0.25,
    failEarly: 0.55,
    failLate: 0.4,
    minutes: [100, 170],
    parameters: { branchAplicacao: "main", limparDados: true, testesChromium: true, testesFirefox: false },
    versioned: true,
  },
  {
    pipelineId: PIPE_API,
    ref: "refs/heads/main",
    seed: 7,
    hours: [9, 15, 21],
    extraChance: 0.3,
    cancelRate: 0.03,
    failEarly: 0.12,
    failLate: 0.06,
    minutes: [8, 14],
    parameters: { ambiente: "homologacao" },
  },
  {
    pipelineId: PIPE_MOBILE,
    ref: "refs/heads/main",
    seed: 99,
    hours: [11],
    extraChance: 0.25,
    cancelRate: 0.05,
    failEarly: 0.08,
    failLate: 0.5,
    minutes: [18, 26],
    parameters: {},
  },
  // Carga noturna com k6: falha quando o p95 passa do limite (threshold), não por teste.
  {
    pipelineId: PIPE_K6,
    ref: "refs/heads/main",
    seed: 314,
    hours: [2],
    extraChance: 0.15,
    cancelRate: 0.02,
    failEarly: 0.1,
    failLate: 0.3,
    minutes: [10, 12],
    parameters: { usuarios: 50 },
  },
];

function buildRuns(profile: RunProfile, seqStart: number): Run[] {
  const rnd = seeded(profile.seed);
  const runs: Run[] = [];
  let seq = seqStart;
  const now = new Date();
  for (let d = 29; d >= 0; d--) {
    const day = new Date(now);
    day.setUTCDate(now.getUTCDate() - d);
    const slots: Array<{ hour: number; trigger: Run["trigger"] }> = profile.hours.map((hour) => ({ hour, trigger: "schedule" }));
    if (rnd() < profile.extraChance) slots.push({ hour: 13 + Math.floor(rnd() * 6), trigger: rnd() < 0.5 ? "manual" : "platform" });
    for (const slot of slots) {
      const queued = new Date(day);
      queued.setUTCHours(slot.hour, Math.floor(rnd() * 50), 0, 0);
      if (queued > now) continue;
      const r = rnd();
      const fail = d >= 15 ? profile.failEarly : profile.failLate;
      const status: RunStatus = r < profile.cancelRate ? "cancelled" : r < profile.cancelRate + fail ? "failed" : "succeeded";
      const [lo, hi] = profile.minutes;
      const duration = status === "cancelled" ? Math.max(1, Math.round(lo * 0.2 + rnd() * lo * 0.3)) : Math.round(lo + rnd() * (hi - lo));
      const started = new Date(queued.getTime() + 6000);
      const finished = new Date(started.getTime() + duration * 60000);
      seq++;
      const base = `${queued.toISOString().slice(0, 10).replace(/-/g, "")}.${runs.filter((x) => x.queuedAt.slice(0, 10) === queued.toISOString().slice(0, 10)).length + 1}`;
      const version = profile.versioned ? demoVersion(queued, rnd) : undefined;
      runs.push({
        id: String(seq),
        pipelineId: profile.pipelineId,
        number: version ? `${base}-${version.parts[0]!.value}-${version.parts[1]!.value}` : base,
        ...(version ? { systemVersion: version } : {}),
        status: finished > now ? "running" : status,
        detailStatus: finished > now ? "running" : status,
        ref: profile.ref,
        queuedAt: queued.toISOString(),
        startedAt: started.toISOString(),
        finishedAt: finished > now ? null : finished.toISOString(),
        durationMinutes: finished > now ? null : duration,
        trigger: slot.trigger,
        parameters: profile.parameters,
      });
    }
  }
  return runs;
}

/** Distribuição e pacote fictícios: o pacote é do dia anterior, com um contador de build. */
function demoVersion(queued: Date, rnd: () => number): SystemVersion {
  const day = new Date(queued.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const distribution = rnd() < 0.8 ? "master" : "4.2";
  const pkg = `${day}.${1 + Math.floor(rnd() * 24)}`;
  return {
    system: "Sistema Web",
    full: `${distribution} · ${pkg}`,
    parts: [
      { key: "distribuicao", label: "Distribuição", value: distribution },
      { key: "pacote", label: "Pacote", value: pkg },
    ],
    missing: [],
  };
}

/** Todas as execuções, da mais recente para a mais antiga. */
// Testes simulados das execuções da demonstração.
const DEMO_SPECS = [
  ["login.spec.ts", "Login", ["entra com senha válida", "bloqueia após 3 tentativas", "recupera a senha por e-mail", "mantém a sessão ao recarregar"]],
  ["documentos.spec.ts", "Documentos", ["cria documento a partir de modelo", "assina com certificado", "anexa arquivo grande", "busca por número", "arquiva e restaura"]],
  ["fluxos.spec.ts", "Fluxos de aprovação", ["aprova em duas etapas", "devolve para correção", "notifica o responsável", "respeita o prazo"]],
  ["relatorios.spec.ts", "Relatórios", ["exporta em PDF", "filtra por período", "mostra o total por setor"]],
] as const;
const DEMO_TOTAL = 214;

export const demoRuns: Run[] = PROFILES.flatMap((p, i) => buildRuns(p, 1000 + i * 1000))
  .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
  .map(withDemoTests);

// ---------- Resultados de testes (simulados) ----------


/** Execuções que terminaram ganham contagem de testes; algumas falhas não publicam relatório. */
function withDemoTests(run: Run): Run {
  if (run.status !== "succeeded" && run.status !== "failed") return { ...run, tests: null, reportStatus: run.status === "cancelled" ? "missing" : "pending" };
  const n = Number(run.id);
  if (run.pipelineId === PIPE_K6) {
    // Desempenho nunca vira contagem de testes (RN-045): só thresholds e latência.
    const perf = demoPerformanceOf(run);
    return {
      ...run,
      tests: null,
      reportStatus: "available",
      failureKind: run.status === "failed" ? "threshold" : "none",
      performance: { thresholdsTotal: perf.thresholdsTotal, thresholdsFailed: perf.thresholdsFailed, latencyP95: perf.latency.p95 },
    };
  }
  if (run.status === "failed" && n % 4 === 0) return { ...run, tests: null, reportStatus: "missing", failureKind: "infrastructure" };
  const failed = run.status === "failed" ? 1 + (n % 7) : 0;
  const flaky = n % 3 === 0 ? 1 + (n % 2) : 0;
  const skipped = 4;
  return {
    ...run,
    tests: { total: DEMO_TOTAL, passed: DEMO_TOTAL - failed - flaky - skipped, failed, flaky, skipped, durationMs: (run.durationMinutes ?? 30) * 60000 },
    reportStatus: "available",
    failureKind: failed ? "test" : "none",
  };
}

/** Resumo k6 fictício e determinístico: falha = p95 acima de 500 ms. */
function demoPerformanceOf(run: Run): PerformanceResult {
  const n = Number(run.id);
  const failed = run.status === "failed";
  const p95 = failed ? 540 + (n % 9) * 23 : 280 + (n % 13) * 15;
  const errors = failed ? 0.012 + (n % 5) * 0.004 : 0.001 + (n % 4) * 0.0015;
  const rate = 42 + (n % 11) * 1.7;
  const durationMs = (run.durationMinutes ?? 10) * 60000;
  return {
    id: `perf-${run.id}`,
    reportId: "r1",
    format: "handle-summary",
    durationMs,
    vusMax: 50,
    iterations: Math.round((rate * durationMs) / 1000 / 3),
    httpReqs: Math.round((rate * durationMs) / 1000),
    httpReqRate: rate,
    httpReqFailedRate: errors,
    latency: { avg: Math.round(p95 * 0.42), med: Math.round(p95 * 0.35), p90: Math.round(p95 * 0.82), p95, p99: Math.round(p95 * 1.6), max: Math.round(p95 * 3.1) },
    checksRate: 1 - errors,
    thresholdsTotal: 2,
    thresholdsFailed: failed ? 1 : 0,
    metrics: [],
    thresholds: [
      { metric: "http_req_duration", expression: "p(95)<500", ok: p95 < 500 },
      { metric: "http_req_failed", expression: "rate<0.05", ok: true },
    ],
  };
}

export function demoPerformanceTrend(pipelineId: string): PerformancePoint[] {
  return demoRuns
    .filter((r) => r.pipelineId === pipelineId && r.performance)
    .slice(0, 50)
    .reverse()
    .map((r) => {
      const p = demoPerformanceOf(r);
      return {
        executionId: r.id,
        finishedAt: r.finishedAt,
        runNumber: r.number,
        status: r.status,
        latencyP95: p.latency.p95,
        latencyP99: p.latency.p99,
        latencyAvg: p.latency.avg,
        httpReqRate: p.httpReqRate,
        httpReqFailedRate: p.httpReqFailedRate,
        vusMax: p.vusMax,
        thresholdsTotal: p.thresholdsTotal,
        thresholdsFailed: p.thresholdsFailed,
      };
    });
}

export function demoResults(id: string, filter: { status?: TestStatus[]; search?: string } = {}): ExecutionResults {
  const run = demoRuns.find((r) => r.id === id);
  if (!run) throw new ApiError(404, "not-found", "Execução não encontrada.");
  const base = { executionId: id, reportStatus: run.reportStatus ?? "pending", failureKind: run.failureKind ?? "none", summary: run.tests ?? null, performance: [] };
  if (run.pipelineId === PIPE_K6 && run.performance) {
    return {
      ...base,
      artifacts: [{ id: "a1", name: "k6-summary", sizeBytes: 48_200, status: "stored", reason: null, createdAt: run.finishedAt ?? run.queuedAt }],
      reports: [{ id: "r1", artifactId: "a1", filePath: "summary.json", processorId: "k6-summary@1", category: "performance", status: "processed", reason: null, tests: 0 }],
      tests: [],
      performance: [demoPerformanceOf(run)],
    };
  }
  if (!run.tests) return { ...base, artifacts: [], reports: [], tests: [] };
  const s = run.tests;
  const tests: TestResult[] = [];
  let i = 0;
  const statusAt = (k: number): TestStatus => (k < s.failed ? "failed" : k < s.failed + s.flaky ? "flaky" : k < s.failed + s.flaky + s.skipped ? "skipped" : "passed");
  for (let k = 0; k < s.total; k++) {
    const [file, suite, names] = DEMO_SPECS[k % DEMO_SPECS.length]!;
    const name = `${names[Math.floor(k / DEMO_SPECS.length) % names.length]}${k >= 16 ? ` (cenário ${k - 15})` : ""}`;
    const status = statusAt(k);
    const t: TestResult = {
      id: String(++i),
      reportId: "r1",
      suite,
      name,
      file: `tests/${file}`,
      project: "chromium",
      status,
      durationMs: status === "skipped" ? 0 : 800 + ((k * 397) % 9000),
      attempts: status === "flaky" ? 2 : status === "failed" ? 3 : 1,
      errorMessage: null,
      errorDetails: null,
      attachments: null,
    };
    if (status === "failed" || status === "flaky") {
      t.errorMessage = status === "failed" ? "expect(locator).toBeVisible() failed: Timeout 15000ms" : "Timeout 30000ms exceeded (passou na nova tentativa)";
      t.errorDetails = `Error: ${t.errorMessage}

  Locator: getByRole('button', { name: 'Salvar' })

    at ${file}:${40 + k}:18`;
      t.attachments = [{ name: "screenshot", contentType: "image/png", path: `test-results/${k}/test-failed-1.png` }];
    }
    tests.push(t);
  }
  const order: Record<TestStatus, number> = { failed: 0, flaky: 1, skipped: 2, passed: 3 };
  const q = filter.search?.toLowerCase();
  return {
    ...base,
    artifacts: [{ id: "a1", name: "playwright-results", sizeBytes: 18_400_000, status: "stored", reason: null, createdAt: run.finishedAt ?? run.queuedAt }],
    reports: [{ id: "r1", artifactId: "a1", filePath: "results.json", processorId: "playwright-json@1", category: "functional", status: "processed", reason: null, tests: s.total }],
    tests: tests
      .filter((t) => (!filter.status?.length || filter.status.includes(t.status)) && (!q || `${t.suite} ${t.name} ${t.file}`.toLowerCase().includes(q)))
      .sort((a, b) => order[a.status] - order[b.status]),
  };
}

// ---------- Ações simuladas (modo demonstração) ----------
// Imitam as regras do servidor: credencial testada antes de guardar, nome único, pipeline que não
// entra duas vezes no mesmo projeto. Nada sai do navegador.

/** Pipelines "existentes no Azure" fictício, para a descoberta. */
const DEMO_EXTERNAL: Array<{ externalId: string; name: string; path: string }> = [
  { externalId: "proj-web/381", name: "testes-e2e-playwright", path: "Sistema Web" },
  { externalId: "proj-web/402", name: "testes-api", path: "Sistema Web" },
  { externalId: "proj-web/445", name: "checkout-firefox", path: "Sistema Web" },
  { externalId: "proj-web/446", name: "checkout-chromium", path: "Sistema Web" },
  { externalId: "proj-web/153", name: "analise-sonar", path: "Sistema Web" },
  { externalId: "proj-mobile/321", name: "build-aplicativo", path: "Aplicativo" },
  { externalId: "proj-mobile/322", name: "distribuir-aplicativo", path: "Aplicativo" },
  { externalId: "proj-cloud/376", name: "deploy-kubernetes", path: "Nuvem" },
];

export function demoCreateIntegration(input: { kind: string; name: string; endpoint: string; credential: string }) {
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "invalid", "Informe o nome da integração.");
  if (demoIntegrations.some((i) => !i.archivedAt && i.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, "conflict", "Já existe uma integração com esse nome.");
  }
  if (!/^https:\/\/(dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9._-]*|[a-z0-9-]+\.visualstudio\.com)\/?$/.test(input.endpoint.trim())) {
    throw new ApiError(400, "invalid", "use https://dev.azure.com/<organização>");
  }
  // Simulação: credencial curta é "recusada pelo provedor", para dar para ver o erro.
  if (input.credential.trim().length < 20) {
    throw new ApiError(400, "invalid", "O provedor recusou a credencial: ela está errada, expirou ou foi revogada. (simulação: use 20 caracteres ou mais)", {
      missingPermissions: [],
    });
  }
  const now = new Date().toISOString();
  const integration: Integration = {
    id: `demo-int-${demoIntegrations.length + 1}`,
    kind: input.kind,
    name,
    endpoint: input.endpoint.trim().replace(/\/$/, ""),
    credentialKind: "pat",
    credentialUpdatedAt: now,
    status: "ok",
    lastCheck: { ok: true, missingPermissions: [] },
    lastCheckedAt: now,
    createdAt: now,
    archivedAt: null,
  };
  demoIntegrations.push(integration);
  return { integration, check: { ok: true, identity: "conta de serviço (simulada)", missingPermissions: [] as string[] } };
}

export function demoDiscover(integrationId: string, q?: string) {
  if (!demoIntegrations.some((i) => i.id === integrationId)) throw new ApiError(404, "not-found", "Integração não encontrada.");
  const needle = q?.trim().toLowerCase();
  return {
    items: DEMO_EXTERNAL.filter((p) => !needle || p.name.toLowerCase().includes(needle)).map((p) => ({
      ...p,
      linkedProjectIds: demoPipelines.filter((x) => !x.archivedAt && x.externalId === p.externalId).map((x) => x.projectId),
    })),
  };
}

export function demoImport(input: { projectId: string; integrationId: string; externalId: string; ref?: string }) {
  const external = DEMO_EXTERNAL.find((p) => p.externalId === input.externalId);
  if (!external) throw new ApiError(404, "not-found", "Não encontrado no provedor, ou a credencial não tem acesso.");
  if (demoPipelines.some((p) => !p.archivedAt && p.projectId === input.projectId && p.externalId === input.externalId)) {
    throw new ApiError(409, "conflict", "Esta pipeline já está vinculada a este projeto.");
  }
  const now = new Date().toISOString();
  const params: ParameterSpec[] = [
    p({ name: "ambiente", label: "Ambiente", type: "enum", options: ["homologacao", "staging"], default: "homologacao" }),
    p({ name: "executarTestes", label: "Executar testes", type: "boolean", default: true }),
  ];
  const pipe = pipeline({
    id: `demo-pipe-${demoPipelines.length + 1}`,
    name: external.name,
    projectId: input.projectId,
    externalId: external.externalId,
    integrationId: input.integrationId,
    externalPath: external.path,
    repositoryName: external.name,
    repositoryUrl: `https://dev.azure.com/exemplo/${encodeURIComponent(external.path)}/_git/${external.name}`,
    parametersRef: input.ref ? (input.ref.startsWith("refs/") ? input.ref : `refs/heads/${input.ref}`) : "refs/heads/main",
    externalParameters: params,
    syncedAt: now,
    createdAt: now,
  });
  demoPipelines.push(pipe);
  demoVersions[pipe.id] = [{ pipelineId: pipe.id, version: 1, manifest: manifestFor(pipe, params), source: "discovery", note: null, createdBy: "u-demo", createdAt: now }];
  demoAudit.unshift({
    id: String(Date.now()),
    actorUserId: "u-demo",
    actorKind: "user",
    action: "pipeline.import",
    targetType: "pipeline",
    targetId: pipe.id,
    outcome: "success",
    details: {},
    occurredAt: now,
  });
  return pipe;
}

export function demoSync(id: string) {
  const pipe = demoPipelines.find((p) => p.id === id);
  if (!pipe) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
  pipe.syncState = "synchronized";
  pipe.syncProblem = null;
  pipe.syncedAt = new Date().toISOString();
}

// ---------- Execução simulada (incremento 3) ----------
// Imita as regras do servidor: parâmetros validados, recurso exclusivo da pipeline de testes, fila
// quando ocupado, cancelamento e reexecução ligada à original. Nada sai do navegador.

export const demoProfiles: ExecutionProfile[] = [
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    pipelineId: PIPE_E2E,
    name: "Noturno completo",
    description: "Limpa os dados e roda no Chromium e no Firefox",
    ref: "refs/heads/testes-maquina",
    parameters: { limparDados: true, testesChromium: true, testesFirefox: true },
  },
  {
    id: "00000000-0000-4000-8000-0000000000e2",
    pipelineId: PIPE_E2E,
    name: "Rápido sem limpar dados",
    description: null,
    ref: null,
    parameters: { limparDados: false, buildFrontend: false },
  },
];

type Listener = (e: { executionId: string; pipelineId: string; status: string }) => void;
const listeners = new Set<Listener>();
const emit = (r: Run) => listeners.forEach((l) => l({ executionId: r.id, pipelineId: r.pipelineId, status: r.detailStatus ?? r.status }));

export function demoSubscribe(onChange: Listener): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function activeOn(pipelineId: string): Run[] {
  return demoRuns.filter((r) => r.pipelineId === pipelineId && (r.status === "running" || r.status === "queued"));
}

export function demoPreview(input: ExecutionInput): ExecutionPreview {
  const pipe = demoPipelines.find((x) => x.id === input.pipelineId);
  if (!pipe) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
  const base = demoVersions[pipe.id]![0]!.manifest;
  // Como no Azure, o YAML muda por branch: a branch de smoke declara "suite" a mais.
  const onSmokeBranch = (input.ref ?? "").endsWith("publicar-relatorios");
  const manifest = onSmokeBranch
    ? { ...base, parameters: [...base.parameters, { name: "suite", label: "O que rodar", type: "enum" as const, options: ["regressao", "smoke", "completa"], default: "regressao", required: false, scope: "provider" as const }] }
    : base;
  const profile = demoProfiles.find((x) => x.id === input.profileId);
  const values = { ...(profile?.parameters ?? {}), ...(input.parameters ?? {}) };
  const violations: ExecutionPreview["violations"] = [];
  const effective: Run["parameters"] = {};
  for (const name of Object.keys(values)) {
    if (!manifest.parameters.some((x) => x.name === name)) violations.push({ parameter: name, message: "parâmetro não declarado no manifesto" });
  }
  for (const spec of manifest.parameters) {
    const v = values[spec.name] ?? spec.default;
    if (v === undefined) continue;
    const expected = spec.type === "enum" ? "string" : spec.type;
    if (typeof v !== expected) violations.push({ parameter: spec.name, message: `tipo esperado: ${spec.type}` });
    else effective[spec.name] = v;
  }
  for (const rule of manifest.validationRules) {
    if (effective[rule.when.parameter] !== rule.when.equals) continue;
    const actual = effective[rule.then.parameter];
    if (actual === undefined || !rule.then.in.includes(actual)) violations.push({ parameter: rule.then.parameter, message: rule.message, ruleId: rule.id });
  }
  const exclusive = manifest.executionResources.filter((r) => r.exclusive);
  const busy = exclusive.length > 0 && activeOn(pipe.id).length > 0;
  const queuedAhead = exclusive.length ? activeOn(pipe.id).filter((r) => r.status === "queued").length : 0;
  const reasons: string[] = [];
  let outcome: ExecutionPreview["decision"]["outcome"] = "dispatch";
  if (violations.length) {
    outcome = "blocked";
    reasons.push("Há parâmetros inválidos.");
  } else if (busy) {
    outcome = "queue";
    reasons.push('O recurso "Máquina de testes" está ocupado por outra execução.');
    if (queuedAhead) reasons.push(queuedAhead === 1 ? "Há 1 pedido na frente na fila." : `Há ${queuedAhead} pedidos na frente na fila.`);
  }
  return {
    pipeline: { id: pipe.id, name: pipe.name },
    manifestVersion: pipe.currentVersion,
    ref: input.ref || profile?.ref || pipe.parametersRef,
    parameters: effective,
    violations,
    resources: exclusive.map((r) => ({ id: r.ref, ref: r.ref, name: "Máquina de testes", busyPolicy: "queue", busy })),
    missingResources: [],
    decision: { outcome, reasons, queuedAhead },
    systemVersion: null,
    parameterSpecs: manifest.parameters,
    parametersFrom: onSmokeBranch ? "branch" : "manifest",
    // Imita a prévia do Azure: aceita o que a validação do painel aceitou.
    providerCheck: violations.length ? null : { ok: true, problems: [] },
  };
}

export const demoRefs: ExternalRef[] = [
  { name: "testes-maquina", ref: "refs/heads/testes-maquina", kind: "branch" },
  { name: "main", ref: "refs/heads/main", kind: "branch" },
  { name: "feature/publicar-relatorios", ref: "refs/heads/feature/publicar-relatorios", kind: "branch" },
  { name: "sistema-master-20250115.8", ref: "refs/tags/sistema-master-20250115.8", kind: "tag" },
  { name: "sistema-4.2-20250114.3", ref: "refs/tags/sistema-4.2-20250114.3", kind: "tag" },
];

let demoSeq = 900000;

export function demoRequest(input: ExecutionInput, rerunOf?: string): Run {
  const preview = demoPreview(input);
  if (preview.decision.outcome === "blocked") {
    throw new ApiError(400, "invalid", preview.decision.reasons.join(" "), { violations: preview.violations });
  }
  const queued = preview.decision.outcome === "queue";
  const now = new Date().toISOString();
  const run: Run = {
    id: String(++demoSeq),
    pipelineId: input.pipelineId,
    number: queued ? "—" : `${now.slice(0, 10).replace(/-/g, "")}.${demoSeq % 100}`,
    status: queued ? "queued" : "running",
    detailStatus: queued ? "queued" : "running",
    statusReason: queued ? preview.decision.reasons.join(" ") : null,
    queuePosition: queued ? preview.decision.queuedAhead + 1 : null,
    ref: preview.ref ?? "",
    queuedAt: now,
    startedAt: queued ? null : now,
    finishedAt: null,
    durationMinutes: null,
    trigger: "platform",
    parameters: preview.parameters,
    rerunOf: rerunOf ?? null,
    requestedBy: "u-demo",
    systemVersion: null,
  };
  demoRuns.unshift(run);
  emit(run);
  return structuredClone(run);
}

export function demoCancel(id: string): Run {
  const run = demoRuns.find((r) => r.id === id);
  if (!run) throw new ApiError(404, "not-found", "Execução não encontrada.");
  if (run.status !== "running" && run.status !== "queued") throw new ApiError(409, "conflict", "A execução já terminou.");
  const wasRunning = run.status === "running";
  Object.assign(run, { status: "cancelled", detailStatus: "cancelled", finishedAt: new Date().toISOString(), queuePosition: null });
  if (run.startedAt) run.durationMinutes = Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 60000));
  emit(run);
  // Recurso liberado: o primeiro da fila da mesma pipeline começa.
  const next = wasRunning ? [...demoRuns].reverse().find((r) => r.pipelineId === run.pipelineId && r.status === "queued") : undefined;
  if (next) {
    Object.assign(next, { status: "running", detailStatus: "running", startedAt: new Date().toISOString(), statusReason: null, queuePosition: null });
    emit(next);
  }
  return structuredClone(run);
}

export function demoRerun(id: string): Run {
  const original = demoRuns.find((r) => r.id === id);
  if (!original) throw new ApiError(404, "not-found", "Execução não encontrada.");
  return demoRequest({ pipelineId: original.pipelineId, ref: original.ref, parameters: original.parameters }, original.id);
}

// ---------- Regras de evento e avisos (demonstração) ----------

export const demoRules: NotificationRule[] = [
  {
    id: "00000000-0000-4000-8000-0000000000f1",
    name: "Liberar versão depois do smoke",
    enabled: true,
    pipelineId: PIPE_E2E,
    onStatus: ["succeeded"],
    conditions: [{ parameter: "suite", in: ["smoke", "completa"] }],
    severity: "warning",
    title: "Liberar versão para homologação",
    message: "A suíte smoke passou em {versao} ({branch}). A versão pode seguir para homologação.",
    channels: ["panel"],
    recipients: [],
    archivedAt: null,
  },
];

export const demoAlerts: Alert[] = [
  {
    id: "00000000-0000-4000-8000-0000000000f9",
    ruleId: "00000000-0000-4000-8000-0000000000f1",
    executionId: "demo",
    pipelineId: PIPE_E2E,
    pipelineName: "testes-e2e-playwright",
    severity: "warning",
    title: "Liberar versão para homologação",
    message: "A suíte smoke passou em master · 20250115.8 (testes-maquina). A versão pode seguir para homologação.",
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  },
];

export function demoSaveRule(input: RuleInput, id?: string): NotificationRule {
  if (!input.onStatus.length) throw new ApiError(400, "invalid", "Escolha ao menos um resultado.");
  const channels = input.channels?.includes("email") ? ["panel", "email"] : ["panel"];
  const recipients = channels.includes("email") ? (input.recipients ?? []) : [];
  if (channels.includes("email") && !recipients.length) throw new ApiError(400, "invalid", "Informe ao menos um e-mail para receber o aviso.");
  if (id) {
    const rule = demoRules.find((r) => r.id === id);
    if (!rule) throw new ApiError(404, "not-found", "Regra não encontrada.");
    Object.assign(rule, input, { channels, recipients });
    return structuredClone(rule);
  }
  const rule: NotificationRule = { ...input, id: crypto.randomUUID(), channels, recipients, archivedAt: null };
  demoRules.push(rule);
  return structuredClone(rule);
}

export function demoArchiveRule(id: string): NotificationRule {
  const rule = demoRules.find((r) => r.id === id);
  if (!rule) throw new ApiError(404, "not-found", "Regra não encontrada.");
  rule.archivedAt = new Date().toISOString();
  return structuredClone(rule);
}

export function demoResolveAlert(id: string, note?: string): Alert {
  const alert = demoAlerts.find((a) => a.id === id);
  if (!alert) throw new ApiError(404, "not-found", "Aviso não encontrado.");
  alert.resolvedAt ??= new Date().toISOString();
  alert.resolvedBy ??= "u-demo";
  alert.resolutionNote ??= note ?? null;
  return structuredClone(alert);
}

// ---------- Administração (demonstração) ----------

/** Cópia da matriz do §6 só para a demonstração; com a API, ela vem de /api/access-matrix. */
export const ACCESS_MATRIX: AccessMatrix = {
  roles: ["admin", "manager", "operator", "reader"],
  operations: ["view", "execute", "cancel", "configurePipelines", "manageIntegrations", "createProjects", "manageUsers", "share", "viewAudit"],
  matrix: {
    admin: { view: "allow", execute: "allow", cancel: "allow", configurePipelines: "allow", manageIntegrations: "allow", createProjects: "allow", manageUsers: "allow", share: "allow", viewAudit: "allow" },
    manager: { view: "allow", execute: "allow", cancel: "allow", configurePipelines: "allow", manageIntegrations: "policy", createProjects: "allow", manageUsers: "policy", share: "allow", viewAudit: "policy" },
    operator: { view: "allow", execute: "allow", cancel: "policy", configurePipelines: "policy", manageIntegrations: "deny", createProjects: "deny", manageUsers: "deny", share: "policy", viewAudit: "deny" },
    reader: { view: "allow", execute: "deny", cancel: "deny", configurePipelines: "deny", manageIntegrations: "deny", createProjects: "deny", manageUsers: "deny", share: "deny", viewAudit: "deny" },
  },
};

export let demoPolicy: AccessPolicy = { operator: ["cancel"] };

export function demoSavePolicy(policy: AccessPolicy): AccessPolicy {
  demoPolicy = structuredClone(policy);
  return demoPolicy;
}

const demoOrg: Organization = { id: ORG.id, name: ORG.name, slug: ORG.slug, archivedAt: null };

export function demoOrganization(): Organization {
  return structuredClone(demoOrg);
}

export function demoRenameOrganization(name: string): Organization {
  if (!name.trim()) throw new ApiError(400, "invalid", "Informe o nome da organização.");
  demoOrg.name = name.trim();
  return structuredClone(demoOrg);
}

export function demoSetOrganizationArchived(archived: boolean): Organization {
  demoOrg.archivedAt = archived ? new Date().toISOString() : null;
  return structuredClone(demoOrg);
}

export function demoCreateOrganization(input: { name: string; slug: string }): Organization {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(input.slug)) throw new ApiError(400, "invalid", "Slug: letras minúsculas, números e hífen.");
  return { id: crypto.randomUUID(), name: input.name, slug: input.slug, archivedAt: null };
}

export function demoCreateWorkspace(name: string): Workspace {
  if (demoWorkspaces.some((w) => !w.archivedAt && w.name.toLowerCase() === name.trim().toLowerCase())) {
    throw new ApiError(409, "conflict", "Já existe um workspace com esse nome.");
  }
  const ws: Workspace = { id: crypto.randomUUID(), name: name.trim(), archivedAt: null };
  demoWorkspaces.push(ws);
  return structuredClone(ws);
}

export function demoCreateProject(workspaceId: string, name: string): Project {
  const p: Project = { id: crypto.randomUUID(), workspaceId, name: name.trim(), archivedAt: null };
  demoProjects.push(p);
  return structuredClone(p);
}

export function demoUpdate<T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T {
  const item = list.find((x) => x.id === id);
  if (!item) throw new ApiError(404, "not-found", "Não encontrado.");
  Object.assign(item, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  return structuredClone(item);
}

export function demoArchive<T extends { id: string; archivedAt: string | null }>(list: T[], id: string, archived: boolean): T {
  if (archived && list === (demoWorkspaces as unknown as T[]) && demoProjects.some((p) => p.workspaceId === id && !p.archivedAt)) {
    throw new ApiError(409, "conflict", "O workspace tem projetos ativos. Arquive ou mova os projetos antes.");
  }
  return demoUpdate(list, id, { archivedAt: archived ? new Date().toISOString() : null } as Partial<T>);
}

export function demoInvite(input: { email: string; role: Role; displayName?: string }): IssuedLink {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new ApiError(400, "invalid", "E-mail inválido.");
  demoMembers.push({
    userId: crypto.randomUUID(),
    displayName: input.displayName || input.email.split("@")[0]!,
    email: input.email,
    status: "invited",
    role: input.role,
    since: new Date().toISOString(),
    invitePending: true,
  });
  return { url: `${location.origin}/convite#token=demonstracao`, expiresAt: new Date(Date.now() + 72 * 3600000).toISOString() };
}

export function demoSetRole(userId: string, role: Role): null {
  const m = demoMembers.find((x) => x.userId === userId);
  if (!m) throw new ApiError(404, "not-found", "Membro não encontrado.");
  if (m.role === "admin" && role !== "admin" && demoMembers.filter((x) => x.role === "admin").length === 1) {
    throw new ApiError(409, "conflict", "A organização precisa de ao menos um admin.");
  }
  m.role = role;
  return null;
}

export function demoRemoveMember(userId: string): null {
  const i = demoMembers.findIndex((x) => x.userId === userId);
  if (i < 0) throw new ApiError(404, "not-found", "Membro não encontrado.");
  if (demoMembers[i]!.role === "admin" && demoMembers.filter((x) => x.role === "admin").length === 1) {
    throw new ApiError(409, "conflict", "A organização precisa de ao menos um admin.");
  }
  demoMembers.splice(i, 1);
  return null;
}

// ---------- Recursos, perfis, manifesto e detalhe de execução (demonstração) ----------

const demoResourceList: Array<Omit<ExecResource, "lease" | "queued">> = [
  {
    id: "00000000-0000-4000-8000-0000000000a7",
    ref: "maquina-testes",
    name: "Máquina de testes",
    description: "Agente self-hosted onde a pipeline de testes roda (uma execução por vez).",
    busyPolicy: "queue",
    leaseTtlSeconds: 900,
    archivedAt: null,
  },
];

export function demoResources(): ExecResource[] {
  return demoResourceList.map((r) => {
    const holder = demoRuns.find((x) => x.pipelineId === PIPE_E2E && x.status === "running");
    return {
      ...r,
      lease: r.ref === "maquina-testes" && holder
        ? { executionId: holder.id, holderKind: holder.trigger === "external" ? "external" : "internal", since: holder.startedAt ?? holder.queuedAt, expiresAt: new Date(Date.now() + 600_000).toISOString(), expired: false }
        : null,
      queued: r.ref === "maquina-testes" ? demoRuns.filter((x) => x.pipelineId === PIPE_E2E && x.status === "queued").length : 0,
    };
  });
}

export function demoSaveResource(input: ResourceInput, id?: string): unknown {
  if (id) {
    const r = demoResourceList.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "not-found", "Recurso não encontrado.");
    Object.assign(r, { name: input.name, description: input.description ?? null, busyPolicy: input.busyPolicy, leaseTtlSeconds: input.leaseTtlSeconds });
    return r;
  }
  if (!input.ref || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.ref)) throw new ApiError(400, "invalid", "Identificador: letras, números, ponto, hífen e sublinhado.");
  if (demoResourceList.some((x) => !x.archivedAt && x.ref.toLowerCase() === input.ref!.toLowerCase())) {
    throw new ApiError(409, "conflict", "Já existe um recurso com esse identificador.");
  }
  const r = { id: crypto.randomUUID(), ref: input.ref, name: input.name, description: input.description ?? null, busyPolicy: input.busyPolicy, leaseTtlSeconds: input.leaseTtlSeconds, archivedAt: null };
  demoResourceList.push(r);
  return r;
}

export function demoArchiveResource(id: string, archived: boolean): unknown {
  const r = demoResourceList.find((x) => x.id === id);
  if (!r) throw new ApiError(404, "not-found", "Recurso não encontrado.");
  if (archived && demoResources().find((x) => x.id === id)?.lease) throw new ApiError(409, "conflict", "O recurso está em uso. Espere a execução terminar.");
  r.archivedAt = archived ? new Date().toISOString() : null;
  return r;
}

export function demoSaveProfile(pipelineId: string, input: ProfileInput, id?: string): ExecutionProfile {
  if (id) {
    const p = demoProfiles.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "not-found", "Perfil não encontrado.");
    Object.assign(p, { name: input.name, description: input.description ?? null, ref: input.ref ?? null, parameters: input.parameters });
    return structuredClone(p);
  }
  const p: ExecutionProfile = { id: crypto.randomUUID(), pipelineId, name: input.name, description: input.description ?? null, ref: input.ref ?? null, parameters: input.parameters };
  demoProfiles.push(p);
  return structuredClone(p);
}

export function demoArchiveProfile(id: string): ExecutionProfile {
  const i = demoProfiles.findIndex((x) => x.id === id);
  if (i < 0) throw new ApiError(404, "not-found", "Perfil não encontrado.");
  const [p] = demoProfiles.splice(i, 1);
  return p!;
}

export function demoSaveManifest(pipelineId: string, manifest: PipelineManifest, expectedVersion: number, note?: string): null {
  const list = demoVersions[pipelineId];
  const pipe = demoPipelines.find((p) => p.id === pipelineId);
  if (!list || !pipe) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
  if (pipe.currentVersion !== expectedVersion) {
    throw new ApiError(409, "conflict", `O manifesto mudou desde que você abriu (versão atual: ${pipe.currentVersion}). Recarregue e refaça a alteração.`);
  }
  pipe.currentVersion += 1;
  list.unshift({ pipelineId, version: pipe.currentVersion, manifest: structuredClone(manifest), source: "manual", note: note ?? null, createdBy: "u-demo", createdAt: new Date().toISOString() });
  return null;
}

export function demoExecution(id: string): ExecutionDetail {
  const run = demoRuns.find((r) => r.id === id);
  if (!run) throw new ApiError(404, "not-found", "Execução não encontrada.");
  const pipe = demoPipelines.find((p) => p.id === run.pipelineId)!;
  const t = (to: string, at: string | null, reason: string | null = null) => (at ? [{ fromStatus: null, toStatus: to, reason, actorUserId: null, occurredAt: at }] : []);
  const finalStatus = run.status === "running" || run.status === "queued" ? [] : t(run.status, run.finishedAt);
  return {
    execution: {
      ...run,
      externalRunId: run.number === "—" ? null : String(124000 + Number(run.id) % 1000),
      failureKind: run.failureKind ?? (run.status === "failed" ? "unknown" : "none"),
      reportStatus: run.reportStatus ?? "pending",
      runTags: run.systemVersion ? [`sistema-${run.systemVersion.parts.map((p) => p.value).join("-")}`] : [],
      agentOrPool: "agente-testes",
    },
    pipeline: { id: pipe.id, name: pipe.name, externalUrl: pipe.externalUrl, capabilities: pipe.capabilities },
    transitions: [...t("queued", run.queuedAt), ...t("running", run.startedAt), ...finalStatus],
    leases: run.status === "running" ? [{ resourceId: demoResourceList[0]!.id, resourceName: "Máquina de testes", holderKind: "internal", expiresAt: new Date(Date.now() + 600_000).toISOString() }] : [],
    reruns: demoRuns.filter((r) => r.rerunOf === id).map((r) => r.id),
  };
}

export function demoLogs(id: string): string {
  const run = demoRuns.find((r) => r.id === id);
  if (!run || run.number === "—") throw new ApiError(409, "conflict", "A execução ainda não chegou ao provedor: não há logs.");
  return [
    "===== Testes =====",
    "→ projeto-testes: testes-maquina",
    "→ Versão do pacote: Distribuição=master Build=20250115.8",
    "→ Modo de testes: regressao (npm run test:regressao:pipeline)",
    "Running 214 tests using 4 workers",
    run.status === "failed" ? "  ✘ 7 failed\n  ✓ 207 passed" : "  ✓ 214 passed",
  ].join("\n");
}

// ---------- Arquivo da pipeline e criação por modelo (incremento 4, simulado) ----------
// Na demonstração o "repositório" fica na memória: dá para editar, ver a diferença e gravar.

const demoFiles = new Map<string, { content: string; revision: number }>();

function demoYamlFor(pipe: LinkedPipeline): string {
  return [
    `# ${pipe.name}`,
    "trigger: none",
    "",
    "parameters:",
    "  - name: suite",
    '    displayName: "Modo dos testes"',
    "    type: string",
    "    default: regressao",
    "    values: [regressao, smoke]",
    "",
    "pool:",
    '  name: "maquina-testes"',
    "",
    "steps:",
    "  - checkout: self",
    '  - script: "npm ci"',
    '    displayName: "Instalar dependências"',
    '  - script: "npx playwright test --reporter=list,json,junit"',
    '    displayName: "Rodar testes"',
    "    env:",
    '      SUITE_TESTES: "${{ parameters.suite }}"',
    "  - task: PublishPipelineArtifact@1",
    "    condition: always()",
    "    inputs:",
    '      targetPath: "test-results"',
    "      artifact: test-results",
    "",
  ].join("\n");
}

function demoFile(pipelineId: string) {
  const pipe = demoPipelines.find((p) => p.id === pipelineId);
  if (!pipe) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
  if (!demoFiles.has(pipelineId)) demoFiles.set(pipelineId, { content: demoYamlFor(pipe), revision: 1 });
  return demoFiles.get(pipelineId)!;
}

export function demoDefinition(pipelineId: string): DefinitionView {
  const f = demoFile(pipelineId);
  return { pipelineId, ref: null, path: "pipelines/testes.yml", format: "yaml", content: f.content, revision: `rev-${f.revision}`, modes: ["commit", "pull-request"] };
}

/** Diferença linha a linha (mesma regra do servidor, sem o recorte de contexto). */
function demoDiff(before: string, after: string): DefinitionPreview["diff"] {
  const split = (t: string) => (t === "" ? [] : t.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));
  const a = split(before);
  const b = split(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const full: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) full.push({ kind: "same", text: a[i]!, oldLine: ++i, newLine: ++j });
    else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) full.push({ kind: "add", text: b[j]!, newLine: ++j });
    else full.push({ kind: "remove", text: a[i]!, oldLine: ++i });
  }
  const keep = full.map((l, k) => full.slice(Math.max(0, k - 3), k + 4).some((x) => x.kind !== "same"));
  const lines: DiffLine[] = [];
  let skipped = 0;
  full.forEach((l, k) => {
    if (!keep[k]) return void skipped++;
    if (skipped) lines.push({ kind: "skip", text: `${skipped} ${skipped === 1 ? "linha igual" : "linhas iguais"}` });
    skipped = 0;
    lines.push(l);
  });
  if (skipped && lines.length) lines.push({ kind: "skip", text: `${skipped} linhas iguais` });
  const added = full.filter((l) => l.kind === "add").length;
  const removed = full.filter((l) => l.kind === "remove").length;
  return { lines, added, removed, changed: added + removed > 0 };
}

/** Checagem leve de sintaxe para a demonstração: tabulação e colchetes sem fechar. */
function demoYamlProblems(content: string): string[] {
  const problems: string[] = [];
  if (!content.trim()) return ["O arquivo está vazio."];
  content.split("\n").forEach((line, k) => {
    if (/^\t/.test(line)) problems.push(`Linha ${k + 1}: YAML não aceita tabulação para recuar.`);
    if ((line.match(/\[/g)?.length ?? 0) !== (line.match(/\]/g)?.length ?? 0)) problems.push(`Linha ${k + 1}: colchete sem fechar.`);
  });
  return problems.slice(0, 10);
}

export function demoPreviewDefinition(pipelineId: string, content: string): DefinitionPreview {
  const f = demoFile(pipelineId);
  return { diff: demoDiff(f.content, content), problems: demoYamlProblems(content), revision: `rev-${f.revision}` };
}

export function demoApplyDefinition(pipelineId: string, input: { content: string; expectedRevision: string; mode: ChangeMode; message?: string }): AppliedChange {
  const f = demoFile(pipelineId);
  const problems = demoYamlProblems(input.content);
  if (problems.length) throw new ApiError(400, "invalid", "O YAML tem problemas de sintaxe.", { problems });
  if (input.expectedRevision !== `rev-${f.revision}`) {
    throw new ApiError(409, "conflict", "O arquivo mudou no provedor desde que você abriu. Recarregue para ver a versão atual e refaça a alteração.");
  }
  if (input.mode === "pull-request") {
    return { mode: "pull-request", externalRevision: "demo-pr", branch: "nexo/alteracao-demo", url: "https://dev.azure.com/exemplo/Sistema%20Web/_git/testes/pullrequest/101" };
  }
  demoFiles.set(pipelineId, { content: input.content.endsWith("\n") ? input.content : `${input.content}\n`, revision: f.revision + 1 });
  return { mode: "commit", externalRevision: `demo-${f.revision + 1}`, branch: "main", url: "https://dev.azure.com/exemplo/Sistema%20Web/_git/testes/commit/demo" };
}

export const demoRepositories: ExternalRepository[] = [
  { id: "proj-web/testes-e2e", name: "testes-e2e", scope: "Sistema Web", defaultBranch: "main" },
  { id: "proj-web/testes-api", name: "testes-api", scope: "Sistema Web", defaultBranch: "main" },
  { id: "proj-mobile/app-testes", name: "app-testes", scope: "Aplicativo", defaultBranch: "develop" },
];

const AGENT_FIELD: TemplateField = {
  key: "agent",
  label: "Onde roda",
  help: "ubuntu-latest usa uma máquina do provedor. Para a máquina de vocês, informe o nome do pool (Azure) ou o rótulo do runner (GitHub).",
  kind: "text",
  default: "ubuntu-latest",
  required: true,
};
const DIR_FIELD: TemplateField = { key: "workingDirectory", label: "Pasta do projeto de testes", help: "Relativa à raiz do repositório.", kind: "text", default: "." };
const MODE_FIELD: TemplateField = {
  key: "withMode",
  label: "Ter a escolha de suíte",
  help: "Cria o parâmetro suite (regressao ou smoke), escolhido na hora de executar, sem mexer no arquivo.",
  kind: "boolean",
  default: false,
};
const SCHEDULE_FIELD: TemplateField = {
  key: "schedule",
  label: "Agenda (opcional)",
  help: "Formato cron, em UTC. Ex.: 0 6 * * 1-5 = dias úteis às 6h UTC. Vazio = só quando alguém executar.",
  kind: "text",
  default: "",
  placeholder: "0 6 * * 1-5",
};
const NODE_FIELD: TemplateField = {
  key: "nodeVersion",
  label: "Versão do Node",
  kind: "select",
  default: "22",
  options: ["18", "20", "22", "24"].map((v) => ({ value: v, label: `Node ${v}` })),
};

export const DEMO_TEMPLATES: PipelineTemplate[] = [
  {
    id: "playwright",
    name: "Playwright",
    description: "Testes de interface com Playwright em Node. Instala os navegadores, roda e publica o relatório.",
    report: "JSON e JUnit do Playwright (pasta test-results)",
    fields: [AGENT_FIELD, DIR_FIELD, NODE_FIELD, { key: "testCommand", label: "Comando dos testes", kind: "text", default: "npx playwright test", required: true }, MODE_FIELD, SCHEDULE_FIELD],
  },
  {
    id: "node-junit",
    name: "Testes em Node (JUnit)",
    description: "Qualquer runner Node que gere JUnit XML: node --test, Vitest, Jest, Mocha.",
    report: "JUnit XML",
    fields: [AGENT_FIELD, DIR_FIELD, NODE_FIELD, { key: "testCommand", label: "Comando dos testes", kind: "text", default: "npm test", required: true }, MODE_FIELD, SCHEDULE_FIELD],
  },
  {
    id: "k6",
    name: "Desempenho com k6",
    description: "Teste de carga com k6. O resumo vira métrica de desempenho, separada da taxa de aprovação.",
    report: "Resumo do k6 (summary.json)",
    fields: [AGENT_FIELD, DIR_FIELD, { key: "script", label: "Script do k6", kind: "text", default: "tests/carga.js", required: true }, SCHEDULE_FIELD],
  },
  {
    id: "command",
    name: "Comando livre",
    description: "Você diz o comando e onde fica o relatório. Serve para qualquer linguagem.",
    report: "O arquivo informado (JUnit XML ou JSON do Playwright)",
    fields: [
      AGENT_FIELD,
      DIR_FIELD,
      { key: "testCommand", label: "Comando dos testes", kind: "text", default: "", required: true, placeholder: "./gradlew test" },
      { key: "reportPath", label: "Pasta ou arquivo do relatório", kind: "text", default: "test-results", required: true },
      MODE_FIELD,
      SCHEDULE_FIELD,
    ],
  },
];

const demoSlug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "testes";

export function demoRenderTemplate(input: { integrationId: string; templateId: string; name: string; values: Record<string, string | boolean> }) {
  const t = DEMO_TEMPLATES.find((x) => x.id === input.templateId);
  if (!t) throw new ApiError(400, "invalid", "Modelo de pipeline desconhecido.");
  if (!input.name.trim()) throw new ApiError(400, "invalid", "Informe um nome de até 120 caracteres.");
  const v = (key: string) => input.values[key] ?? t.fields.find((f) => f.key === key)?.default ?? "";
  for (const f of t.fields) if (f.required && !String(v(f.key)).trim()) throw new ApiError(400, "invalid", `Informe: ${f.label}.`);
  const q = (s: unknown) => JSON.stringify(String(s));
  const agent = String(v("agent"));
  const lines = [`# ${input.name}: criada pelo Nexo a partir do modelo "${t.name}".`, "trigger: none", ""];
  if (v("schedule")) lines.push("schedules:", `  - cron: ${q(v("schedule"))}`, "    branches:", "      include: [main]", "    always: true", "");
  if (v("withMode") === true) lines.push("parameters:", "  - name: suite", "    type: string", "    default: regressao", "    values: [regressao, smoke]", "");
  lines.push("pool:", /-latest$/.test(agent) ? `  vmImage: ${q(agent)}` : `  name: ${q(agent)}`, "", "steps:", "  - checkout: self");
  if (v("nodeVersion")) lines.push("  - task: NodeTool@0", "    inputs:", `      versionSpec: ${q(`${v("nodeVersion")}.x`)}`, '  - script: "npm ci"');
  if (t.id === "playwright") lines.push('  - script: "npx playwright install --with-deps"');
  lines.push(`  - script: ${q(t.id === "k6" ? `k6 run --summary-export=test-results/summary.json ${v("script")}` : v("testCommand"))}`, `    workingDirectory: ${q(v("workingDirectory"))}`);
  lines.push("  - task: PublishPipelineArtifact@1", "    condition: always()", "    inputs:", `      targetPath: ${q(v("reportPath") || "test-results")}`, "      artifact: test-results", "");
  return { content: lines.join("\n"), path: `pipelines/${demoSlug(input.name)}.yml`, problems: [] as string[] };
}

export function demoCreatePipelineChange(input: NewPipelineInput): AppliedChange {
  const problems = demoYamlProblems(input.content);
  if (problems.length) throw new ApiError(400, "invalid", "O YAML tem problemas de sintaxe.", { problems });
  if (!/\.ya?ml$/i.test(input.path)) throw new ApiError(400, "invalid", "O arquivo precisa terminar em .yml ou .yaml.");
  return input.mode === "pull-request"
    ? { mode: "pull-request", externalRevision: "demo-pr", branch: "nexo/nova-pipeline-demo", url: "https://dev.azure.com/exemplo/Sistema%20Web/_git/testes/pullrequest/102" }
    : { mode: "commit", externalRevision: "demo-novo", branch: input.branch };
}

/** Registra a pipeline recém-criada como "existente no provedor", para o vínculo da demonstração. */
export function demoNewExternalId(name: string): string {
  const externalId = `proj-web/${900 + DEMO_EXTERNAL.length}`;
  DEMO_EXTERNAL.push({ externalId, name, path: "Sistema Web" });
  return externalId;
}

// ---------- Links compartilhados e configurações (incremento 7) ----------
// Na demonstração o "token" carrega o próprio pedido (codificado), para a página pública abrir numa
// aba nova sem servidor. Numa instalação real o token é aleatório e só o hash fica no navegador.

export let demoSettings: OrgSettings = {
  sharing: { allowPublic: true, defaultDays: 7, maxDays: 90 },
  retention: { artifactsDays: 90, resultsDays: 365, emailsDays: 90 },
};

export function demoSaveSettings(s: OrgSettings): OrgSettings {
  const maxDays = Math.min(365, Math.max(1, Math.round(s.sharing.maxDays)));
  demoSettings = {
    sharing: { allowPublic: s.sharing.allowPublic, maxDays, defaultDays: Math.min(maxDays, Math.max(1, Math.round(s.sharing.defaultDays))) },
    retention: {
      artifactsDays: Math.max(1, Math.round(s.retention.artifactsDays)),
      resultsDays: Math.max(30, Math.round(s.retention.resultsDays)),
      emailsDays: Math.max(1, Math.round(s.retention.emailsDays)),
    },
  };
  return structuredClone(demoSettings);
}

export const demoShares: ShareLink[] = [];

const SHARE_DEFAULTS: ShareOptions = { parameters: false, errorDetails: false, branch: true, systemVersion: true, periodDays: 30 };

const ALWAYS_OMITTED = ["logs da execução", "arquivos e artefatos originais", "endereços do provedor e do repositório", "quem pediu a execução", "configuração da pipeline e integrações"];

function shareTarget(input: ShareInput) {
  if (input.access === "public" && !demoSettings.sharing.allowPublic) throw new ApiError(403, "forbidden", "Esta organização não permite links públicos. Use um link só para membros.");
  const days = input.days ?? demoSettings.sharing.defaultDays;
  if (days < 1 || days > demoSettings.sharing.maxDays) throw new ApiError(400, "invalid", `A validade precisa ser de 1 a ${demoSettings.sharing.maxDays} dias.`);
  const run = input.scope === "execution" ? demoRuns.find((r) => r.id === input.executionId) : undefined;
  const pipelineId = run?.pipelineId ?? input.pipelineId;
  const pipe = demoPipelines.find((p) => p.id === pipelineId);
  if (!pipe) throw new ApiError(404, "not-found", "Pipeline não encontrada.");
  return { run, pipe, days, options: { ...SHARE_DEFAULTS, ...input.options } };
}

export function demoShareView(input: ShareInput): PublicView {
  const { run, pipe, days, options: o } = shareTarget(input);
  const omitted = [...ALWAYS_OMITTED];
  if (!o.parameters) omitted.push("parâmetros usados");
  if (!o.errorDetails) omitted.push("detalhe técnico dos erros (só a primeira linha aparece)");
  if (!o.branch) omitted.push("branch");
  if (!o.systemVersion) omitted.push("versão do sistema em teste");
  const base: PublicView = {
    kind: input.scope,
    title: input.title?.trim() || (input.scope === "execution" ? `Resultado de ${pipe.name}` : `Painel de ${pipe.name}`),
    organizationName: ORG.name,
    pipelineName: pipe.name,
    access: input.access,
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    generatedAt: new Date().toISOString(),
    omitted,
  };
  if (run) {
    const r = demoResults(run.id);
    return {
      ...base,
      execution: {
        number: run.number,
        status: run.detailStatus ?? "succeeded",
        requestedAt: run.queuedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        branch: o.branch ? run.ref.replace(/^refs\/(heads|tags)\//, "") : null,
        systemVersion: o.systemVersion && run.systemVersion ? `${run.systemVersion.system} ${run.systemVersion.parts.map((p) => p.value).join(" · ")}` : null,
        parameters: o.parameters ? run.parameters : null,
        reportStatus: r.reportStatus,
        failureKind: r.failureKind,
        summary: r.summary,
        tests: r.tests.map(({ id: _i, reportId: _r, attachments: _a, ...t }) => ({ ...t, errorDetails: o.errorDetails ? t.errorDetails : null })),
        testsTruncated: false,
        performance: r.performance,
      },
    };
  }
  const since = Date.now() - o.periodDays * 86400000;
  return {
    ...base,
    pipeline: {
      periodDays: o.periodDays,
      runs: demoRuns
        .filter((x) => x.pipelineId === pipe.id && Date.parse(x.queuedAt) >= since)
        .map((x) => ({
          number: x.number,
          status: x.detailStatus ?? "succeeded",
          requestedAt: x.queuedAt,
          finishedAt: x.finishedAt,
          durationMs: x.durationMinutes === null ? null : x.durationMinutes * 60000,
          failureKind: x.failureKind ?? "none",
          tests: x.tests ? { total: x.tests.total, passed: x.tests.passed, failed: x.tests.failed, skipped: x.tests.skipped, flaky: x.tests.flaky } : null,
          performance: x.performance ?? null,
        })),
    },
  };
}

const toBase64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export function demoCreateShare(input: ShareInput): { link: ShareLink; url: string } {
  const { run, pipe, days, options } = shareTarget(input);
  const view = demoShareView(input);
  const link: ShareLink = {
    id: crypto.randomUUID(),
    scope: input.scope,
    pipelineId: pipe.id,
    pipelineName: pipe.name,
    executionId: run?.id ?? null,
    access: input.access,
    title: view.title,
    options,
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    status: "active",
  };
  demoShares.unshift(link);
  return { link: structuredClone(link), url: `${location.origin}/compartilhado#demo.${toBase64Url(JSON.stringify(input))}` };
}

/** Página pública na demonstração: reconstrói a visão a partir do pedido que veio no token. */
export function demoViewFromToken(token: string): PublicView {
  if (!token.startsWith("demo.")) throw new ApiError(404, "not-found", "Este link não existe, expirou ou foi revogado.");
  try {
    return demoShareView(JSON.parse(fromBase64Url(token.slice(5))) as ShareInput);
  } catch {
    throw new ApiError(404, "not-found", "Este link não existe, expirou ou foi revogado.");
  }
}

export function demoRevokeShare(id: string): ShareLink {
  const link = demoShares.find((l) => l.id === id);
  if (!link) throw new ApiError(404, "not-found", "Link não encontrado.");
  link.revokedAt = new Date().toISOString();
  link.status = "revoked";
  return structuredClone(link);
}

// ---------- IA própria + MCP (incremento 8) ----------
// Na demonstração não há chamada a modelo nenhum: a "IA" devolve uma proposta pronta depois de
// alguns segundos, para mostrar o fluxo (pedir, revisar, corrigir, aplicar) sem gastar nada.

export const demoAiProviders: AiProvider[] = [
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    name: "Claude (demonstração)",
    kind: "anthropic",
    endpoint: "",
    model: "claude-opus-5-5",
    effort: "high",
    hasCredential: true,
    lastCheck: { ok: true, message: "Simulado: nenhuma chamada sai da demonstração." },
    lastCheckedAt: days(1),
    createdAt: days(5),
  },
];

export function demoCreateAiProvider(input: AiProviderInput): AiProvider {
  if (!input.name.trim() || !input.model.trim()) throw new ApiError(400, "invalid", "Informe o nome e o modelo.");
  const provider: AiProvider = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    kind: input.kind,
    endpoint: input.endpoint ?? "",
    model: input.model.trim(),
    effort: input.effort ?? null,
    hasCredential: Boolean(input.apiKey),
    lastCheck: { ok: true, message: "Simulado: na demonstração a chave não é testada." },
    lastCheckedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  demoAiProviders.push(provider);
  return structuredClone(provider);
}

export function demoArchiveAiProvider(id: string): AiProvider {
  const i = demoAiProviders.findIndex((p) => p.id === id);
  if (i < 0) throw new ApiError(404, "not-found", "Provedor não encontrado.");
  return demoAiProviders.splice(i, 1)[0]!;
}

export const demoMcpServers: McpServer[] = [
  {
    id: "00000000-0000-4000-8000-0000000000e2",
    name: "Documentação interna",
    url: "https://mcp.exemplo.test/mcp",
    authHeader: "Authorization",
    hasCredential: true,
    serverInfo: { name: "docs-exemplo", version: "1.0" },
    tools: [
      { name: "buscar_documento", description: "Busca páginas da documentação de testes", readOnlyHint: true, kind: "read", authorized: true },
      { name: "listar_ambientes", description: "Lista os ambientes de homologação", readOnlyHint: true, kind: "read", authorized: false },
      { name: "abrir_chamado", description: "Abre um chamado no suporte", readOnlyHint: false, kind: "mutate", authorized: false },
    ],
    lastCheck: { ok: true, message: "3 ferramenta(s) encontrada(s)" },
    lastCheckedAt: days(1),
    createdAt: days(4),
  },
];

export function demoSetMcpTools(id: string, tools: Array<{ name: string; kind: McpTool["kind"]; authorized: boolean }>): McpServer {
  const server = demoMcpServers.find((s) => s.id === id);
  if (!server) throw new ApiError(404, "not-found", "Servidor não encontrado.");
  for (const t of tools) {
    if (t.authorized && t.kind !== "read") throw new ApiError(400, "invalid", `"${t.name}" é de mutação: a IA só usa ferramentas de leitura.`);
    const found = server.tools.find((x) => x.name === t.name);
    if (found) Object.assign(found, { kind: t.kind, authorized: t.authorized });
  }
  return structuredClone(server);
}

export function demoArchiveMcpServer(id: string): McpServer {
  const i = demoMcpServers.findIndex((s) => s.id === id);
  if (i < 0) throw new ApiError(404, "not-found", "Servidor não encontrado.");
  return demoMcpServers.splice(i, 1)[0]!;
}

export const demoAssistSessions: AssistSession[] = [];

function demoBaseline(input: AssistSessionInput): { manifest: PipelineManifest; name: string; params: ParameterSpec[] } {
  const linked = demoPipelines.find((x) => x.projectId === input.projectId && x.externalId === input.externalId && !x.archivedAt);
  const external = DEMO_EXTERNAL.find((x) => x.externalId === input.externalId);
  const name = linked?.name ?? external?.name ?? input.externalId;
  const params: ParameterSpec[] = linked?.externalParameters ?? [
    p({ name: "ambiente", type: "enum", options: ["homologacao", "staging"], default: "homologacao" }),
    p({ name: "executarTestes", type: "boolean", default: true }),
  ];
  // A descoberta lê os nomes crus; a IA propõe rótulos legíveis.
  const raw = params.map((x) => ({ ...x, label: undefined }) as ParameterSpec);
  const fake = pipeline({ id: "x", name, projectId: input.projectId, externalId: input.externalId });
  return { manifest: manifestFor(fake, raw), name, params };
}

export function demoStartAssist(input: AssistSessionInput): AssistSession {
  if (!input.acknowledged) throw new ApiError(400, "invalid", "Confirme que você sabe quais dados serão enviados ao modelo.");
  const provider = demoAiProviders.find((x) => x.id === input.providerId);
  if (!provider) throw new ApiError(404, "not-found", "Provedor de IA não encontrado.");
  const base = demoBaseline(input);
  const session: AssistSession = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    integrationId: input.integrationId,
    externalId: input.externalId,
    ref: input.ref ?? null,
    pipelineName: base.name,
    providerId: provider.id,
    providerName: provider.name,
    mcpTools: input.mcpTools,
    status: "running",
    providerParameters: base.params.map((x) => x.name),
    review: null,
    steps: [],
    usage: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    appliedPipelineId: null,
  };
  demoAssistSessions.unshift(session);
  setTimeout(() => {
    const labeled = base.params.map((x) => ({ ...x, label: x.label ?? x.name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) }));
    const hasMachine = demoResourceList.some((r) => r.ref === "maquina-testes");
    session.status = "proposed";
    session.finishedAt = new Date().toISOString();
    session.usage = { inputTokens: 18_400, outputTokens: 2_100, turns: 3 };
    session.steps = [
      { tool: "nexo_read_definition", source: "arquivo da pipeline no provedor", input: "{}", ok: true, chars: 6_820, ms: 640 },
      { tool: "nexo_read_parameters", source: "parâmetros da pipeline no provedor", input: "{}", ok: true, chars: 1_240, ms: 410 },
      { tool: "nexo_list_resources", source: "catálogo de recursos do Nexo", input: "{}", ok: true, chars: 180, ms: 12 },
      ...(input.mcpTools.length ? [{ tool: "mcp_documentacao_interna_buscar_documento", source: "MCP Documentação interna / buscar_documento", input: '{"q":"smoke"}', ok: true, chars: 2_300, ms: 820 }] : []),
    ];
    session.review = {
      manifest: {
        ...base.manifest,
        parameters: labeled,
        executionResources: hasMachine ? [{ ref: "maquina-testes", exclusive: true }] : [],
        reports: [{ type: "playwright-json" }],
      },
      problems: [],
      warnings: hasMachine ? [] : ['recurso "maquina-testes" não está cadastrado: a execução fica bloqueada até cadastrar ou tirar'],
      changes: labeled.map((x) => `${x.name}: rótulo "${x.label}"`),
      notes: {
        summary: `A pipeline ${base.name} roda os testes de ponta a ponta numa máquina dedicada e publica o relatório JSON do Playwright.`,
        sources: ["arquivo da pipeline: pool 'maquina-testes' no job de testes", "arquivo da pipeline: passo que publica results.json como artefato"],
        uncertainties: ["Não ficou claro se o arquivo de massa de dados aceita outros arquivos além do padrão."],
      },
    };
  }, 2500);
  return structuredClone(session);
}

export function demoAssistSession(id: string): AssistSession {
  const s = demoAssistSessions.find((x) => x.id === id);
  if (!s) throw new ApiError(404, "not-found", "Sessão não encontrada.");
  return structuredClone(s);
}

export function demoApplyAssist(id: string, edited?: PipelineManifest): AssistSession {
  const s = demoAssistSessions.find((x) => x.id === id);
  if (!s || s.status !== "proposed") throw new ApiError(409, "conflict", "Esta sessão não tem proposta pronta para aplicar.");
  const manifest = edited ?? s.review?.manifest;
  if (!manifest) throw new ApiError(400, "invalid", "A proposta não passou na validação.");
  let pipe = demoPipelines.find((x) => x.projectId === s.projectId && x.externalId === s.externalId && !x.archivedAt);
  if (!pipe) pipe = demoImport({ projectId: s.projectId, integrationId: s.integrationId, externalId: s.externalId, ...(s.ref ? { ref: s.ref } : {}) });
  pipe.currentVersion += 1;
  demoVersions[pipe.id]!.unshift({
    pipelineId: pipe.id,
    version: pipe.currentVersion,
    manifest: { ...structuredClone(manifest), pipeline: { externalId: pipe.externalId, displayName: pipe.name }, review: { status: "draft", requiresHumanApproval: true } },
    source: "assist",
    note: "Configuração proposta pela IA e revisada por uma pessoa",
    createdBy: "u-demo",
    createdAt: new Date().toISOString(),
  });
  s.status = "applied";
  s.appliedPipelineId = pipe.id;
  return structuredClone(s);
}

export function demoDiscardAssist(id: string): null {
  const s = demoAssistSessions.find((x) => x.id === id);
  if (s) s.status = "discarded";
  return null;
}
