import { headText, type PerformanceMetric, type PerformanceRecord as BaseRecord, type PerformanceThreshold, type ProcessorOutput, type ReportProcessor } from "@painel/processor-sdk";

// Categoria "performance" (§20): as métricas do k6 nunca entram na taxa de aprovação de testes
// (RN-045). Lê os dois resumos JSON que o k6 produz no fim do teste (ADR-013, P-008):
//
// 1. handleSummary (`export function handleSummary(data) { return { "summary.json": JSON.stringify(data) } }`):
//    { metrics: { http_req_duration: { type, contains, values: { avg, "p(95)" ... }, thresholds: { "p(95)<500": { ok } } } }, state, root_group }
// 2. --summary-export=arquivo.json (formato antigo, sem "values"):
//    { metrics: { http_req_duration: { avg, "p(95)" ..., thresholds: { "p(95)<500": false } } }, root_group }
//    Aqui o valor do threshold é "falhou?": false = atendido.
//
// Percentis e taxas guardam a unidade (ms, proporção, por segundo) e a janela do teste (§20.2).

const MAX_BYTES = 50 * 1024 * 1024;

export type K6MetricType = PerformanceMetric["type"];
export type K6Metric = PerformanceMetric;
export type K6Threshold = PerformanceThreshold;

/** Resultado normalizado; "format" diz de qual dos dois resumos veio. */
export interface PerformanceRecord extends BaseRecord {
  format: "handle-summary" | "summary-export";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const TIME_METRICS = /(_duration|_time|_blocked|_connecting|_receiving|_sending|_waiting|_tls_handshaking)$/;

/** Formato antigo não diz o tipo: deduz pelas chaves (trend tem avg; rate tem passes/fails). */
function inferType(values: Record<string, unknown>): K6MetricType {
  if ("avg" in values || "med" in values || Object.keys(values).some((k) => k.startsWith("p("))) return "trend";
  if ("passes" in values || "fails" in values) return "rate";
  if ("count" in values) return "counter";
  return "gauge";
}

function cleanValues(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = num(v);
    if (n !== undefined && k.length <= 40) out[k] = n;
  }
  return out;
}

/** Converte qualquer um dos dois formatos em métricas e thresholds normalizados. */
export function k6ToRecord(summary: unknown): PerformanceRecord | { problem: string } {
  if (!summary || typeof summary !== "object") return { problem: "o arquivo não é um objeto JSON" };
  const root = summary as { metrics?: unknown; state?: { testRunDurationMs?: unknown } };
  if (!root.metrics || typeof root.metrics !== "object" || Array.isArray(root.metrics)) return { problem: "o JSON não tem o bloco \"metrics\" do k6" };
  const entries = Object.entries(root.metrics as Record<string, unknown>).filter(([, v]) => v && typeof v === "object") as Array<[string, Record<string, unknown>]>;
  if (!entries.length) return { problem: "o resumo do k6 não tem nenhuma métrica" };
  const modern = entries.some(([, m]) => m.values && typeof m.values === "object");

  const metrics: K6Metric[] = [];
  const thresholds: K6Threshold[] = [];
  for (const [name, m] of entries.slice(0, 500)) {
    if (name.length > 200) continue;
    let type: K6MetricType;
    let values: Record<string, number>;
    let contains: K6Metric["contains"];
    if (modern) {
      const raw = (m.values && typeof m.values === "object" ? m.values : {}) as Record<string, unknown>;
      type = ["trend", "rate", "counter", "gauge"].includes(m.type as string) ? (m.type as K6MetricType) : inferType(raw);
      contains = m.contains === "time" || m.contains === "data" ? m.contains : "default";
      values = cleanValues(raw);
    } else {
      const raw: Record<string, unknown> = { ...m };
      delete raw.thresholds;
      type = inferType(raw);
      // O formato antigo também não diz a unidade: as métricas de tempo do k6 têm nomes conhecidos.
      contains = type === "trend" && TIME_METRICS.test(name) ? "time" : name.startsWith("data_") ? "data" : "default";
      values = cleanValues(raw);
      // Rate no formato antigo vem como "value"; padroniza em "rate".
      if (type === "rate" && values.rate === undefined && values.value !== undefined) values.rate = values.value;
    }
    metrics.push({ name, type, contains, values });

    const t = m.thresholds;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      for (const [expression, v] of Object.entries(t as Record<string, unknown>)) {
        if (expression.length > 300) continue;
        // Moderno: { ok: boolean }. Antigo: boolean que significa "falhou".
        const ok = modern ? (v as { ok?: unknown })?.ok === true : v === false;
        thresholds.push({ metric: name, expression, ok });
      }
    }
  }

  const byName = new Map(metrics.map((m) => [m.name, m]));
  const duration = byName.get("http_req_duration")?.values ?? {};
  const record: PerformanceRecord = {
    format: modern ? "handle-summary" : "summary-export",
    latency: {},
    metrics,
    thresholds,
  };
  const set = <K extends keyof PerformanceRecord>(key: K, value: PerformanceRecord[K] | undefined) => {
    if (value !== undefined) record[key] = value;
  };
  set("durationMs", num(root.state?.testRunDurationMs));
  set("vusMax", byName.get("vus_max")?.values.max ?? byName.get("vus_max")?.values.value);
  set("iterations", byName.get("iterations")?.values.count);
  set("httpReqs", byName.get("http_reqs")?.values.count);
  set("httpReqRate", byName.get("http_reqs")?.values.rate);
  set("httpReqFailedRate", byName.get("http_req_failed")?.values.rate);
  set("checksRate", byName.get("checks")?.values.rate);
  const lat: PerformanceRecord["latency"] = {};
  for (const [key, source] of [
    ["avg", "avg"],
    ["med", "med"],
    ["p90", "p(90)"],
    ["p95", "p(95)"],
    ["p99", "p(99)"],
    ["max", "max"],
  ] as const) {
    const v = num(duration[source]);
    if (v !== undefined) lat[key] = v;
  }
  record.latency = lat;
  return record;
}

async function readAll(input: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new RangeError("resumo grande demais (limite de 50 MB)");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export const k6SummaryProcessor: ReportProcessor = {
  id: "k6-summary@1",
  category: "performance",
  detect(artifact, head) {
    const text = headText(head);
    const isJson = artifact.name.endsWith(".json") || artifact.contentType === "application/json";
    // O Playwright também tem "metrics"? Não: ele tem "config" e "suites". Evita a confusão.
    const matches =
      isJson &&
      text.startsWith("{") &&
      text.includes('"metrics"') &&
      /"(root_group|http_req_duration|iterations|vus|checks|data_received)"/.test(text) &&
      !(text.includes('"suites"') && text.includes('"config"'));
    return { matches, confidence: matches ? 0.8 : 0 };
  },
  async process(input): Promise<ProcessorOutput> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readAll(input));
    } catch (error) {
      return { status: "failed", reason: `JSON do k6 inválido: ${error instanceof Error ? error.message.slice(0, 200) : "erro"}`, records: [] };
    }
    const record = k6ToRecord(parsed);
    if ("problem" in record) return { status: "unsupported", reason: record.problem, records: [] };
    if (!record.metrics.some((m) => m.name.startsWith("http_") || m.name === "iterations")) {
      return { status: "partial", reason: "o resumo não tem métricas HTTP nem de iterações", records: [record] };
    }
    return { status: "processed", records: [record] };
  },
};
