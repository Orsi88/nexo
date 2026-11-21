import { describe, expect, it } from "vitest";
import { k6SummaryProcessor, k6ToRecord, type PerformanceRecord } from "../src/index.ts";

// Amostras no formato documentado do k6 (P-008: confirmar com a saída real da pipeline).

const HANDLE_SUMMARY = {
  root_group: { name: "", path: "", groups: [], checks: [] },
  options: { summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"] },
  state: { isStdOutTTY: false, testRunDurationMs: 60123.4 },
  metrics: {
    http_req_duration: {
      type: "trend",
      contains: "time",
      values: { avg: 120.5, min: 30, med: 100, max: 900, "p(90)": 200, "p(95)": 310.2, "p(99)": 700 },
      thresholds: { "p(95)<300": { ok: false } },
    },
    http_req_failed: { type: "rate", contains: "default", values: { rate: 0.012, passes: 12, fails: 988 }, thresholds: { "rate<0.05": { ok: true } } },
    http_reqs: { type: "counter", contains: "default", values: { count: 1000, rate: 16.6 } },
    iterations: { type: "counter", contains: "default", values: { count: 500, rate: 8.3 } },
    vus_max: { type: "gauge", contains: "default", values: { value: 20, min: 20, max: 20 } },
    checks: { type: "rate", contains: "default", values: { rate: 0.99, passes: 990, fails: 10 } },
  },
};

const SUMMARY_EXPORT = {
  root_group: { name: "", path: "", id: "d41d8cd98f00b204e9800998ecf8427e", groups: {}, checks: {} },
  metrics: {
    http_req_duration: { avg: 80, min: 10, med: 70, max: 400, "p(90)": 150, "p(95)": 180, thresholds: { "p(95)<500": false } },
    http_req_failed: { passes: 0, fails: 300, value: 0, thresholds: { "rate<0.01": false } },
    http_reqs: { count: 300, rate: 10 },
    vus: { value: 5, min: 1, max: 5 },
  },
};

const stream = (value: unknown) => new Blob([JSON.stringify(value)]).stream();
const head = (value: unknown) => new TextEncoder().encode(JSON.stringify(value).slice(0, 4096));
const ctx = { organizationId: "o", executionId: "e", artifactId: "a", correlationId: "c" };

describe("k6ToRecord", () => {
  it("lê o resumo do handleSummary com unidades, janela e thresholds", () => {
    const r = k6ToRecord(HANDLE_SUMMARY) as PerformanceRecord;
    expect(r.format).toBe("handle-summary");
    expect(r.durationMs).toBe(60123.4);
    expect(r.latency).toEqual({ avg: 120.5, med: 100, p90: 200, p95: 310.2, p99: 700, max: 900 });
    expect(r.httpReqs).toBe(1000);
    expect(r.httpReqRate).toBe(16.6);
    expect(r.httpReqFailedRate).toBe(0.012);
    expect(r.vusMax).toBe(20);
    expect(r.iterations).toBe(500);
    expect(r.checksRate).toBe(0.99);
    expect(r.thresholds).toEqual([
      { metric: "http_req_duration", expression: "p(95)<300", ok: false },
      { metric: "http_req_failed", expression: "rate<0.05", ok: true },
    ]);
    expect(r.metrics.find((m) => m.name === "http_req_duration")?.contains).toBe("time");
  });

  it("lê o --summary-export, onde o threshold diz se falhou", () => {
    const r = k6ToRecord(SUMMARY_EXPORT) as PerformanceRecord;
    expect(r.format).toBe("summary-export");
    expect(r.durationMs).toBeUndefined();
    expect(r.latency.p95).toBe(180);
    expect(r.latency.p99).toBeUndefined(); // percentil não informado fica ausente, não vira zero
    expect(r.httpReqFailedRate).toBe(0);
    expect(r.thresholds.every((t) => t.ok)).toBe(true);
    const duration = r.metrics.find((m) => m.name === "http_req_duration")!;
    expect(duration.type).toBe("trend");
    expect(duration.contains).toBe("time");
    expect(r.metrics.find((m) => m.name === "http_req_failed")?.type).toBe("rate");
  });

  it("recusa o que não é resumo do k6", () => {
    expect(k6ToRecord({ foo: 1 })).toEqual({ problem: expect.stringContaining("metrics") });
    expect(k6ToRecord({ metrics: {} })).toEqual({ problem: expect.stringContaining("nenhuma métrica") });
  });
});

describe("k6SummaryProcessor", () => {
  it("reconhece os dois formatos e não confunde com o JSON do Playwright", () => {
    expect(k6SummaryProcessor.detect({ name: "summary.json" }, head(HANDLE_SUMMARY)).matches).toBe(true);
    expect(k6SummaryProcessor.detect({ name: "export.json" }, head(SUMMARY_EXPORT)).matches).toBe(true);
    expect(k6SummaryProcessor.detect({ name: "results.json" }, head({ config: {}, suites: [], metrics: { http_req_duration: 1 } })).matches).toBe(false);
    expect(k6SummaryProcessor.detect({ name: "summary.xml" }, head(HANDLE_SUMMARY)).matches).toBe(false);
  });

  it("processa e devolve um registro de desempenho", async () => {
    const out = await k6SummaryProcessor.process(stream(HANDLE_SUMMARY), ctx);
    expect(out.status).toBe("processed");
    expect(out.records).toHaveLength(1);
  });

  it("JSON quebrado vira falha com motivo, sem inventar números", async () => {
    const out = await k6SummaryProcessor.process(new Blob(["{ metrics"]).stream(), ctx);
    expect(out.status).toBe("failed");
    expect(out.records).toEqual([]);
  });
});
