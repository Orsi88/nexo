import { useEffect, useState } from "react";
import { useApp } from "../context.tsx";
import type { ExecutionResults, FailureKind, ReportStatus, Run, TestResult, TestStatus, TestSummary } from "../data/types.ts";
import { Failure, Loading, useAsync } from "../util.tsx";
import { PerfCount, PerformanceSection } from "./Performance.tsx";

// Resultados dos testes de uma execução (incremento 5): resumo, situação do relatório, tipo de
// falha e a lista de testes com o erro de cada falha. A ausência de relatório fica explícita
// (RN-012): nunca aparece como "0 testes".

const STATUS_LABEL: Record<TestStatus, string> = { failed: "Falharam", flaky: "Instáveis", skipped: "Pulados", passed: "Passaram" };
const ONE_LABEL: Record<TestStatus, string> = { failed: "falhou", flaky: "instável", skipped: "pulado", passed: "passou" };

export const FAILURE_LABEL: Record<FailureKind, string> = {
  none: "",
  test: "Falha nos testes",
  infrastructure: "Falha de infraestrutura (fora dos testes)",
  threshold: "Limite de desempenho não atingido",
  unknown: "Falha sem causa identificada",
};

const REPORT_NOTICE: Partial<Record<ReportStatus, { tone: "accent" | "warning"; text: string }>> = {
  pending: { tone: "accent", text: "Os relatórios ainda não foram lidos. Isso acontece alguns segundos depois que a execução termina." },
  missing: { tone: "warning", text: "Esta execução não publicou relatório de testes. Não dá para dizer quantos testes passaram." },
  invalid: { tone: "warning", text: "O relatório publicado não pôde ser lido. O arquivo original continua guardado." },
  partial: { tone: "warning", text: "Parte dos relatórios não pôde ser lida: os números abaixo podem estar incompletos." },
};

/** Taxa de aprovação: instável conta como aprovado (passou na nova tentativa); pulado não entra. */
export function passRate(s: TestSummary): number | null {
  const ran = s.total - s.skipped;
  return ran > 0 ? (s.passed + s.flaky) / ran : null;
}

const percent = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: v >= 0.995 && v < 1 ? 1 : 0 })}%`;

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Contagem compacta para tabelas: "207/214" e as falhas em destaque. */
export function TestCount({
  tests,
  reportStatus,
  cancelled,
  performance,
}: {
  tests: TestSummary | null | undefined;
  reportStatus?: ReportStatus | undefined;
  cancelled?: boolean;
  performance?: Run["performance"];
}) {
  if (!tests && performance) return <PerfCount performance={performance} />;
  if (!tests) {
    if (reportStatus === "missing" && !cancelled) return <span className="muted" title="A execução não publicou relatório de testes">sem relatório</span>;
    if (reportStatus === "invalid") return <span className="warning-text">relatório ilegível</span>;
    return <span className="muted">—</span>;
  }
  const rate = passRate(tests);
  return (
    <span className="test-count" title={`${tests.passed} passaram · ${tests.failed} falharam · ${tests.flaky} instáveis · ${tests.skipped} pulados`}>
      <span className="num">
        {tests.passed + tests.flaky}/{tests.total - tests.skipped}
      </span>
      {tests.failed ? <span className="test-count-failed">{tests.failed} ✕</span> : null}
      {rate !== null && !tests.failed ? <span className="muted">{percent(rate)}</span> : null}
    </span>
  );
}

function SummaryBar({ s }: { s: TestSummary }) {
  const ran = Math.max(1, s.total);
  const parts: Array<[TestStatus, number]> = [
    ["passed", s.passed],
    ["flaky", s.flaky],
    ["failed", s.failed],
    ["skipped", s.skipped],
  ];
  return (
    <div className="results-bar" role="img" aria-label={parts.map(([k, v]) => `${v} ${ONE_LABEL[k]}`).join(", ")}>
      {parts.map(([k, v]) => (v ? <span key={k} className={`results-bar-${k}`} style={{ flexGrow: v / ran }} /> : null))}
    </div>
  );
}

function TestRow({ t }: { t: TestResult }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(t.errorMessage || t.errorDetails);
  return (
    <li className={`test-row test-${t.status}`}>
      <button type="button" className="test-line" onClick={() => expandable && setOpen(!open)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
        <span className={`test-dot test-dot-${t.status}`} title={ONE_LABEL[t.status]} />
        <span className="test-name">
          <span>{t.name}</span>
          <span className="muted test-where">
            {[t.suite, t.file, t.project].filter(Boolean).join(" · ")}
            {t.attempts > 1 ? ` · ${t.attempts} tentativas` : ""}
          </span>
          {t.errorMessage && !open ? <span className="test-error-line">{t.errorMessage}</span> : null}
        </span>
        <span className="num muted">{t.status === "skipped" ? "—" : duration(t.durationMs)}</span>
      </button>
      {open ? (
        <div className="test-error">
          {t.errorDetails ? <pre>{t.errorDetails}</pre> : <p>{t.errorMessage}</p>}
          {t.attachments?.length ? (
            <p className="muted">
              Anexos no artefato: {t.attachments.map((a) => a.path ?? a.name).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ResultsSection({ executionId, finished, cancelled = false }: { executionId: string; finished: boolean; cancelled?: boolean }) {
  const { data, version } = useApp();
  const [status, setStatus] = useState<TestStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const result = useAsync<ExecutionResults>(
    () => data.executionResults(executionId, { ...(status !== "all" ? { status: [status] } : {}), ...(query ? { search: query } : {}) }),
    [data, executionId, version, status, query],
  );
  const [last, setLast] = useState<ExecutionResults>();
  useEffect(() => {
    if (result.state === "ready") setLast(result.value);
  }, [result]);

  if (!finished) {
    return (
      <section>
        <div className="sut-title">Testes</div>
        <p className="muted">Os resultados aparecem quando a execução terminar.</p>
      </section>
    );
  }
  if (result.state === "error") return <Failure error={result.error} />;
  // Enquanto o filtro recarrega, fica o último resultado (a busca não perde o foco).
  const r = result.state === "ready" ? result.value : last;
  if (!r) return <Loading />;
  const notice =
    cancelled && r.reportStatus === "missing"
      ? { tone: "accent" as const, text: "A execução foi cancelada antes de publicar relatório de testes." }
      : REPORT_NOTICE[r.reportStatus];
  const s = r.summary;
  const rate = s ? passRate(s) : null;
  // Só desempenho (k6): sem bloco de testes, que diria "0 testes" de algo que não tem testes.
  if (!s && r.performance.length) {
    return (
      <>
        {r.failureKind !== "none" ? <span className={`results-kind kind-${r.failureKind}`}>{FAILURE_LABEL[r.failureKind]}</span> : null}
        <PerformanceSection items={r.performance} />
      </>
    );
  }

  return (
    <>
    <PerformanceSection items={r.performance} />
    <section className="results">
      <div className="exec-logs-head">
        <span className="sut-title" style={{ margin: 0 }}>
          Testes
        </span>
        {r.failureKind !== "none" ? <span className={`results-kind kind-${r.failureKind}`}>{FAILURE_LABEL[r.failureKind]}</span> : null}
      </div>
      {notice ? <div className={`notice ${notice.tone}`}>{notice.text}</div> : null}
      {s ? (
        <>
          <div className="results-summary">
            <div className="results-rate">
              <span className="results-rate-value">{rate === null ? "—" : percent(rate)}</span>
              <span className="muted">aprovação</span>
            </div>
            <div className="results-counts">
              {(["failed", "flaky", "skipped", "passed"] as TestStatus[]).map((k) => {
                const n = s[k];
                return (
                  <button
                    key={k}
                    type="button"
                    className={`results-count count-${k}${status === k ? " active" : ""}`}
                    onClick={() => setStatus(status === k ? "all" : k)}
                    disabled={!n}
                    aria-pressed={status === k}
                  >
                    <strong className="num">{n}</strong>
                    <span>{STATUS_LABEL[k]}</span>
                  </button>
                );
              })}
            </div>
            <div className="results-total muted">
              {s.total} testes · {duration(s.durationMs)} somados
            </div>
          </div>
          <SummaryBar s={s} />
          <div className="results-filter">
            <input className="search" type="search" aria-label="Buscar teste" placeholder="Buscar teste, suíte ou arquivo" value={search} onChange={(e) => setSearch(e.target.value)} />
            {status !== "all" ? (
              <button type="button" className="btn small" onClick={() => setStatus("all")}>
                Mostrar todos
              </button>
            ) : null}
          </div>
          {r.tests.length ? (
            <ul className="test-list">
              {r.tests.map((t) => (
                <TestRow key={t.id} t={t} />
              ))}
            </ul>
          ) : (
            <p className="muted">Nenhum teste com esse filtro.</p>
          )}
          {r.tests.length >= 500 ? <p className="muted">Mostrando os primeiros 500. Use a busca para achar os demais.</p> : null}
        </>
      ) : null}
      {r.artifacts.length || r.reports.length ? (
        <details className="results-sources">
          <summary>De onde vieram estes números</summary>
          <ul>
            {r.artifacts.map((a) => (
              <li key={a.id}>
                Artefato <span className="mono">{a.name}</span>
                {a.sizeBytes !== null ? ` · ${(a.sizeBytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : ""}
                {a.status === "stored" ? " · guardado" : ` · não guardado${a.reason ? `: ${a.reason}` : ""}`}
              </li>
            ))}
            {r.reports.map((p) => (
              <li key={p.id}>
                Relatório <span className="mono">{p.filePath}</span> · {p.processorId} · {p.tests} testes
                {p.status !== "processed" ? ` · ${p.status}${p.reason ? `: ${p.reason}` : ""}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
    </>
  );
}
