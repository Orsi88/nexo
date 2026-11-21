import { MetricLineChart, Stat } from "../charts.tsx";
import { useApp } from "../context.tsx";
import type { PerformancePoint, PerformanceResult, Run } from "../data/types.ts";
import { Icon } from "../icons.tsx";
import { Failure, Loading, useAsync } from "../util.tsx";

// Desempenho (incremento 6, §20): resumo do k6 por execução e a série histórica por pipeline.
// Fica sempre separado dos testes funcionais (RN-045): requisições HTTP não são testes, e a falha
// por limite de desempenho aparece como tal, não como falha de infraestrutura (CA-045).

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v >= 1000) return `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} s`;
  return `${Math.round(v).toLocaleString("pt-BR")} ms`;
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const p = v * 100;
  return `${p.toLocaleString("pt-BR", { maximumFractionDigits: p > 0 && p < 1 ? 2 : 1 })}%`;
}

const perSecond = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}/s`);

function windowText(durationMs: number | null): string {
  if (!durationMs) return "janela não informada";
  const s = Math.round(durationMs / 1000);
  return s >= 60 ? `em ${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim() : `em ${s} s`;
}

/** Compacto para tabelas de execuções: p95 e limites. */
export function PerfCount({ performance }: { performance: NonNullable<Run["performance"]> }) {
  const failed = performance.thresholdsFailed;
  return (
    <span className="test-count" title={`${performance.thresholdsTotal} limite(s) de desempenho, ${failed} não atendido(s)`}>
      <span className="num">p95 {ms(performance.latencyP95)}</span>
      {failed ? <span className="test-count-failed">{failed} limite ✕</span> : performance.thresholdsTotal ? <span className="muted">limites ok</span> : null}
    </span>
  );
}

/** Detalhe de desempenho de uma execução (um bloco por resumo k6). */
export function PerformanceSection({ items }: { items: PerformanceResult[] }) {
  if (!items.length) return null;
  return (
    <section className="results">
      <div className="exec-logs-head">
        <span className="sut-title" style={{ margin: 0 }}>
          Desempenho
        </span>
        <span className="muted small-print">k6 · não entra na contagem de testes</span>
      </div>
      {items.map((p) => (
        <div key={p.id} className="perf-block">
          <div className="perf-stats">
            <PerfStat label="p95" value={ms(p.latency.p95)} />
            <PerfStat label="p99" value={ms(p.latency.p99)} />
            <PerfStat label="Média" value={ms(p.latency.avg)} />
            <PerfStat label="Requisições" value={perSecond(p.httpReqRate)} foot={p.httpReqs !== null ? `${p.httpReqs.toLocaleString("pt-BR")} ${windowText(p.durationMs)}` : undefined} />
            <PerfStat label="Erros HTTP" value={pct(p.httpReqFailedRate)} />
            <PerfStat label="Usuários virtuais" value={p.vusMax !== null ? String(Math.round(p.vusMax)) : "—"} />
          </div>
          {p.thresholds.length ? (
            <ul className="threshold-list" aria-label="Limites de desempenho">
              {p.thresholds.map((t, i) => (
                <li key={i} className={t.ok ? "ok" : "failed"}>
                  <Icon name={t.ok ? "check" : "x"} size={13} />
                  <span>{t.ok ? "Atendido" : "Não atendido"}</span>
                  <span className="mono">{t.metric}</span>
                  <span className="mono muted">{t.expression}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small-print">O script do k6 não define limites (thresholds).</p>
          )}
          <p className="muted small-print">
            Latência de <span className="mono">http_req_duration</span> em ms; taxas sobre {p.httpReqs !== null ? `${p.httpReqs.toLocaleString("pt-BR")} requisições` : "as requisições"}{" "}
            {windowText(p.durationMs)}. Percentil ausente no resumo aparece como —, nunca como zero.
          </p>
        </div>
      ))}
    </section>
  );
}

function PerfStat({ label, value, foot }: { label: string; value: string; foot?: string | undefined }) {
  return (
    <div className="perf-stat">
      <span className="muted">{label}</span>
      <strong className="num">{value}</strong>
      {foot ? <span className="muted small-print">{foot}</span> : null}
    </div>
  );
}

/** Painel de desempenho da pipeline (RF-190, RF-193): só aparece se ela tem resumos de k6. */
export function PipelinePerformance({ pipelineId }: { pipelineId: string }) {
  const { data, version } = useApp();
  const result = useAsync(() => data.pipelinePerformance(pipelineId), [data, pipelineId, version]);
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  const series = result.value;
  if (!series.length) return null;
  return <PerformanceCharts series={series} />;
}

function PerformanceCharts({ series }: { series: PerformancePoint[] }) {
  const last = series[series.length - 1]!;
  const withThresholds = series.filter((p) => p.thresholdsTotal > 0);
  const okRuns = withThresholds.filter((p) => p.thresholdsFailed === 0).length;
  const toPoint = (p: PerformancePoint, value: number | null) => ({
    key: p.executionId,
    label: p.runNumber ?? "—",
    at: p.finishedAt ?? new Date().toISOString(),
    value,
    flagged: p.thresholdsFailed ? `${p.thresholdsFailed} limite(s) não atendido(s)` : undefined,
  });
  return (
    <div className="section">
      <h2>
        <Icon name="chart" size={14} />
        Desempenho
        <span className="hint">k6 · últimas {series.length} execuções com resumo</span>
      </h2>
      <div className="grid stats">
        <Stat title="p95 mais recente" value={ms(last.latencyP95)} foot={`p99 ${ms(last.latencyP99)}`} spark={series.map((p) => p.latencyP95)} />
        <Stat title="Erros HTTP (último)" value={pct(last.httpReqFailedRate)} spark={series.map((p) => p.httpReqFailedRate)} />
        <Stat title="Vazão (última)" value={perSecond(last.httpReqRate)} foot={last.vusMax !== null ? `${Math.round(last.vusMax)} usuários virtuais` : undefined} />
        <Stat
          title="Limites atendidos"
          value={withThresholds.length ? `${okRuns}/${withThresholds.length}` : "—"}
          foot={withThresholds.length ? "execuções com todos os limites ok" : "o script não define limites"}
          {...(withThresholds.length && okRuns < withThresholds.length ? { tone: "critical" as const } : {})}
        />
      </div>
      <div className="grid two" style={{ marginTop: 12 }}>
        <MetricLineChart title="Latência p95" hint="ms · http_req_duration" points={series.map((p) => toPoint(p, p.latencyP95))} format={ms} />
        <MetricLineChart title="Erros HTTP" hint="% de requisições que falharam" points={series.map((p) => toPoint(p, p.httpReqFailedRate))} format={pct} />
      </div>
    </div>
  );
}
