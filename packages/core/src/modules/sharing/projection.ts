import type { FailureKind, ParameterValue, ReportStatus, SystemVersion } from "@painel/contracts";

// Projeção do que um visitante de link compartilhado vê (22.2, RN-046, RN-047, CA-036, CA-037;
// ADR-014). Só leitura de dados explicitamente publicados: nunca logs, artefatos brutos, endereços
// do provedor, ids internos, pessoas, integrações ou configuração. O que é opcional (parâmetros,
// detalhe de erro, branch, versão) só aparece se quem criou o link marcou, e mesmo assim passa pelo
// mascaramento de segredos e dados pessoais.

export interface ShareOptions {
  /** Valores dos parâmetros usados (nomes sensíveis ficam sempre ocultos). */
  parameters: boolean;
  /** Pilha/diff do erro dos testes que falharam (a primeira linha aparece sempre). */
  errorDetails: boolean;
  /** Branch em que rodou. */
  branch: boolean;
  /** Versão do sistema em teste. */
  systemVersion: boolean;
  /** Painel da pipeline: período em dias. */
  periodDays: number;
}

export const DEFAULT_SHARE_OPTIONS: ShareOptions = { parameters: false, errorDetails: false, branch: true, systemVersion: true, periodDays: 30 };

export function sanitizeShareOptions(input: unknown): ShareOptions {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const bool = (k: keyof ShareOptions) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (DEFAULT_SHARE_OPTIONS[k] as boolean));
  const days = Number(o.periodDays);
  return {
    parameters: bool("parameters"),
    errorDetails: bool("errorDetails"),
    branch: bool("branch"),
    systemVersion: bool("systemVersion"),
    periodDays: Number.isInteger(days) ? Math.min(90, Math.max(1, days)) : DEFAULT_SHARE_OPTIONS.periodDays,
  };
}

/** Nome de parâmetro que sugere segredo: o valor nunca é publicado, nem com "parâmetros" marcado. */
const SENSITIVE_NAME = /(pass(word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|chave|credential|credencial|auth|private|privad|pwd|cert|connection[_-]?string|conn[_-]?str|dsn|cookie|session)/i;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

const MASK = "•••";

const SCRUBBERS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Credencial embutida em URL: https://usuario:senha@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Cabeçalho ou atribuição de segredo: Authorization: Bearer x, password=x, "token": "x"
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${MASK}`],
  [/((?:pass(?:word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|authorization|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\s|•••)[^\s"',;&]+/gi, `$1${MASK}`],
  // Formatos conhecidos de chave: JWT, AWS, GitHub, Slack, Azure DevOps PAT em base64 longo.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Sequência longa sem espaço com cara de chave (40+ caracteres de base64/hex).
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],
  // E-mail é dado pessoal: some a parte antes do @.
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)\b/g, `${MASK}@$1`],
];

/** Mascara segredos e dados pessoais num texto que vai para fora (RN-047, RNF-033). */
export function scrubText(text: string): string;
export function scrubText(text: string | null | undefined): string | null;
export function scrubText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let out = text;
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep as string);
  return out;
}

/** Parâmetros publicáveis: nomes sensíveis ficam ocultos; valores de texto passam pelo mascaramento. */
export function publicParameters(params: Record<string, ParameterValue>): { values: Record<string, ParameterValue | "oculto">; hidden: string[] } {
  const values: Record<string, ParameterValue | "oculto"> = {};
  const hidden: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (isSensitiveName(k)) {
      values[k] = "oculto";
      hidden.push(k);
    } else {
      values[k] = typeof v === "string" ? scrubText(v) : v;
    }
  }
  return { values, hidden };
}

// ---------- Formas públicas ----------

export interface PublicTest {
  suite: string;
  name: string;
  file: string | null;
  project: string | null;
  status: "passed" | "failed" | "skipped" | "flaky";
  durationMs: number | null;
  attempts: number;
  errorMessage: string | null;
  errorDetails: string | null;
}

export interface PublicPerformance {
  durationMs: number | null;
  vusMax: number | null;
  httpReqs: number | null;
  httpReqRate: number | null;
  httpReqFailedRate: number | null;
  latency: { avg: number | null; med: number | null; p90: number | null; p95: number | null; p99: number | null; max: number | null };
  thresholds: Array<{ metric: string; expression: string; ok: boolean }>;
}

export interface PublicExecution {
  number: string;
  status: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  branch: string | null;
  systemVersion: string | null;
  parameters: Record<string, ParameterValue | "oculto"> | null;
  reportStatus: ReportStatus;
  failureKind: FailureKind;
  summary: { total: number; passed: number; failed: number; skipped: number; flaky: number; durationMs: number } | null;
  tests: PublicTest[];
  testsTruncated: boolean;
  performance: PublicPerformance[];
}

export interface PublicRun {
  number: string;
  status: string;
  requestedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  failureKind: FailureKind;
  tests: { total: number; passed: number; failed: number; skipped: number; flaky: number } | null;
  performance: { latencyP95: number | null; thresholdsFailed: number; thresholdsTotal: number } | null;
}

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
  /** O que ficou de fora de propósito, para a prévia mostrar sem ambiguidade (22.2). */
  omitted: string[];
}

export const ALWAYS_OMITTED = [
  "logs da execução",
  "arquivos e artefatos originais",
  "endereços do provedor e do repositório",
  "quem pediu a execução",
  "configuração da pipeline e integrações",
];

export function versionText(v: SystemVersion | null): string | null {
  if (!v || !v.parts.length) return null;
  return scrubText(`${v.system} ${v.parts.map((p) => p.value).join(" · ")}`);
}

export function branchName(ref: string | null): string | null {
  if (!ref) return null;
  return scrubText(ref.replace(/^refs\/(heads|tags)\//, ""));
}
