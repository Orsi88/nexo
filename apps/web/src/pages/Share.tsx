import { useEffect, useState } from "react";
import { StatusBadge } from "../charts.tsx";
import { useApp } from "../context.tsx";
import type { ExecutionStatus, PublicView, RunStatus, ShareInput, ShareLink, ShareOptions, TestStatus } from "../data/types.ts";
import { ApiError } from "../data/errors.ts";
import { demoViewFromToken } from "../data/demo.ts";
import { Icon, IconButton } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { confirmDialog } from "../dialogs.tsx";
import { copyText, CopyField, dateTime, Failure, Loading, useAsync } from "../util.tsx";
import { FAILURE_LABEL, passRate } from "./Results.tsx";
import { ms, pct } from "./Performance.tsx";

// Compartilhamento (incremento 7, FLX-004, 22.2): a janela que cria o link mostrando antes
// exatamente o que o visitante verá, a lista de links com revogação e a página pública.

const TO_RUN: Record<ExecutionStatus, RunStatus> = {
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

const TEST_LABEL: Record<TestStatus, string> = { failed: "falhou", flaky: "instável", skipped: "pulado", passed: "passou" };

/** O relatório como o visitante vê. Usado na prévia e na página pública: a mesma tela nos dois. */
export function PublicReport({ view }: { view: PublicView }) {
  const e = view.execution;
  const [showAll, setShowAll] = useState(false);
  const failing = e ? e.tests.filter((t) => t.status === "failed" || t.status === "flaky") : [];
  const listed = e ? (showAll ? e.tests : failing) : [];
  return (
    <div className="public-report">
      <header className="public-head">
        <div className="muted small-print">{view.organizationName}</div>
        <h2>{view.title}</h2>
        <div className="muted small-print">
          {view.pipelineName} · somente leitura · válido até {dateTime(view.expiresAt)}
        </div>
      </header>

      {e ? (
        <section className="card">
          <div className="exec-head">
            <span className="mono exec-number">{e.number}</span>
            <StatusBadge status={TO_RUN[e.status]} />
            {e.failureKind !== "none" ? <span className={`results-kind kind-${e.failureKind}`}>{FAILURE_LABEL[e.failureKind]}</span> : null}
          </div>
          <div className="props exec-props">
            <Fact label="Início">{e.startedAt ? dateTime(e.startedAt) : dateTime(e.requestedAt)}</Fact>
            <Fact label="Fim">{e.finishedAt ? dateTime(e.finishedAt) : "—"}</Fact>
            {e.branch ? <Fact label="Branch">{e.branch}</Fact> : null}
            {e.systemVersion ? <Fact label="Versão testada">{e.systemVersion}</Fact> : null}
          </div>
          {e.summary ? (
            <div className="public-summary">
              <strong className="results-rate-value">{passRate(e.summary) === null ? "—" : pct(passRate(e.summary))}</strong>
              <span className="muted">aprovação</span>
              <span>
                {e.summary.passed} passaram · {e.summary.failed} falharam · {e.summary.flaky} instáveis · {e.summary.skipped} pulados
              </span>
            </div>
          ) : e.performance.length ? null : (
            <p className="muted">{e.reportStatus === "missing" ? "Esta execução não publicou relatório de testes." : "Sem resultados de testes."}</p>
          )}
          {e.performance.map((p, i) => (
            <div key={i} className="perf-block">
              <div className="perf-stats">
                <Fact label="p95">{ms(p.latency.p95)}</Fact>
                <Fact label="p99">{ms(p.latency.p99)}</Fact>
                <Fact label="Erros HTTP">{pct(p.httpReqFailedRate)}</Fact>
                <Fact label="Requisições">{p.httpReqs === null ? "—" : p.httpReqs.toLocaleString("pt-BR")}</Fact>
              </div>
              <ul className="threshold-list">
                {p.thresholds.map((t, j) => (
                  <li key={j} className={t.ok ? "ok" : "failed"}>
                    <Icon name={t.ok ? "check" : "x"} size={13} />
                    <span>{t.ok ? "Atendido" : "Não atendido"}</span>
                    <span className="mono">{t.metric}</span>
                    <span className="mono muted">{t.expression}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {e.parameters ? (
            <table className="list compact">
              <tbody>
                {Object.entries(e.parameters).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td>{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {e.tests.length ? (
            <>
              <div className="exec-logs-head">
                <span className="sut-title" style={{ margin: 0 }}>
                  {showAll ? `Todos os testes (${e.tests.length})` : `Falhas e instáveis (${failing.length})`}
                </span>
                <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Só as falhas" : "Ver todos"}
                </button>
              </div>
              <ul className="test-list">
                {listed.map((t, i) => (
                  <li key={i} className={`test-row test-${t.status}`}>
                    <div className="test-line" style={{ cursor: "default" }}>
                      <span className={`test-dot test-dot-${t.status}`} title={TEST_LABEL[t.status]} />
                      <span className="test-name">
                        <span>{t.name}</span>
                        <span className="muted test-where">{[t.suite, t.file, t.project].filter(Boolean).join(" · ")}</span>
                        {t.errorMessage ? <span className="test-error-line">{t.errorMessage}</span> : null}
                      </span>
                    </div>
                    {t.errorDetails ? (
                      <div className="test-error">
                        <pre>{t.errorDetails}</pre>
                      </div>
                    ) : null}
                  </li>
                ))}
                {!listed.length ? <li className="muted" style={{ padding: 10 }}>Nenhuma falha.</li> : null}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {view.pipeline ? (
        <section className="card flush">
          <div className="card-title padded">
            Execuções dos últimos {view.pipeline.periodDays} dias
            <span className="hint">{view.pipeline.runs.length} execuções</span>
          </div>
          {view.pipeline.runs.length ? (
            <table className="list">
              <thead>
                <tr>
                  <th>Execução</th>
                  <th>Resultado</th>
                  <th>Quando</th>
                  <th>Testes / desempenho</th>
                </tr>
              </thead>
              <tbody>
                {view.pipeline.runs.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.number}</td>
                    <td className="nowrap">
                      <StatusBadge status={TO_RUN[r.status]} />
                    </td>
                    <td className="nowrap">{dateTime(r.requestedAt)}</td>
                    <td className="nowrap">
                      {r.tests
                        ? `${r.tests.passed + r.tests.flaky}/${r.tests.total - r.tests.skipped}${r.tests.failed ? ` · ${r.tests.failed} falharam` : ""}`
                        : r.performance
                          ? `p95 ${ms(r.performance.latencyP95)}${r.performance.thresholdsFailed ? ` · ${r.performance.thresholdsFailed} limite ✕` : ""}`
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted padded">Nenhuma execução no período.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

// ---------- Janela de compartilhar ----------

export function ShareDialog({ target, onClose }: { target: { scope: "execution"; executionId: string } | { scope: "pipeline"; pipelineId: string }; onClose: () => void }) {
  const { data, notify, refresh } = useApp();
  const settings = useAsync(() => data.orgSettings(), [data]);
  const [access, setAccess] = useState<"public" | "members">("public");
  const [days, setDays] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState<ShareOptions>({ parameters: false, errorDetails: false, branch: true, systemVersion: true, periodDays: 30 });
  const [created, setCreated] = useState<{ url: string; link: ShareLink } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = settings.state === "ready" ? settings.value.sharing : null;
  const effectiveAccess = policy && !policy.allowPublic ? "members" : access;
  const input: ShareInput = {
    ...target,
    access: effectiveAccess,
    days: days ?? policy?.defaultDays ?? 7,
    ...(title.trim() ? { title: title.trim() } : {}),
    options,
  };
  const key = JSON.stringify(input);
  const [preview, setPreview] = useState<{ key: string; view?: PublicView; error?: string } | null>(null);
  useEffect(() => {
    if (!policy || created) return;
    let alive = true;
    const t = setTimeout(() => {
      data.previewShareLink(JSON.parse(key) as ShareInput).then(
        (view) => alive && setPreview({ key, view }),
        (err: unknown) => alive && setPreview({ key, error: err instanceof Error ? err.message : "Não deu para gerar a prévia." }),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [data, key, policy, created]);

  const toggle = (k: keyof ShareOptions) => setOptions((o) => ({ ...o, [k]: !o[k] }));
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await data.createShareLink(input);
      setCreated(made);
      refresh();
      // Já copia: quase sempre é o próximo passo de quem cria o link.
      if (await copyText(made.url)) notify("Link criado e copiado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o link.");
    } finally {
      setBusy(false);
    }
  };

  const extras: Array<{ key: keyof ShareOptions; label: string; hint?: string }> = [
    { key: "parameters", label: "Parâmetros usados", hint: "nomes sensíveis (senha, token, chave) ficam ocultos" },
    { key: "errorDetails", label: "Detalhe técnico dos erros", hint: "a pilha completa; a primeira linha do erro aparece sempre" },
    { key: "branch", label: "Branch" },
    { key: "systemVersion", label: "Versão do sistema em teste" },
  ];

  return (
    <Modal
      title={created ? "Link criado" : target.scope === "execution" ? "Compartilhar resultado" : "Compartilhar painel da pipeline"}
      onClose={onClose}
      width={created ? 560 : 1080}
      {...(created
        ? {}
        : {
            footer: (
              <>
                {error ? (
                  <span className="warning-text grow" role="alert">
                    {error}
                  </span>
                ) : (
                  <span className="grow" />
                )}
                <button className="btn primary" type="button" onClick={() => void create()} disabled={busy || !policy}>
                  <Icon name="link" size={14} />
                  Criar link
                </button>
              </>
            ),
          })}
    >
      {settings.state === "loading" ? <Loading /> : null}
      {settings.state === "error" ? <Failure error={settings.error} /> : null}
      {created ? (
        <div className="execute-form">
          <p>
            {created.link.access === "public" ? "Qualquer pessoa com este link vê o relatório, sem entrar." : "Só quem entra no Nexo e é membro desta organização consegue abrir."} Vale até{" "}
            {dateTime(created.link.expiresAt)} e pode ser revogado a qualquer momento.
          </p>
          <CopyField value={created.url} onCopied={(ok) => notify(ok ? "Link copiado." : "Não deu para copiar automaticamente: selecione o link e copie.", ok ? "success" : "error")} />
          <p className="muted small-print">O link só aparece agora: o Nexo guarda apenas uma impressão dele. Se perder, crie outro.</p>
        </div>
      ) : policy ? (
        <div className="share-layout">
          <div className="share-form">
            <div className="share-section">
              <div className="share-label">Quem pode abrir</div>
              <div className="choice-cards" role="radiogroup" aria-label="Quem pode abrir">
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveAccess === "public"}
                  className="choice-card"
                  disabled={!policy.allowPublic}
                  onClick={() => setAccess("public")}
                  title={policy.allowPublic ? undefined : "Esta organização desligou links públicos"}
                >
                  <Icon name="link" size={16} />
                  <strong>Qualquer pessoa</strong>
                  <span>com o link, sem entrar</span>
                </button>
                <button type="button" role="radio" aria-checked={effectiveAccess === "members"} className="choice-card" onClick={() => setAccess("members")}>
                  <Icon name="users" size={16} />
                  <strong>Só membros</strong>
                  <span>precisa entrar no Nexo</span>
                </button>
              </div>
            </div>

            <div className="share-section share-row">
              <div className="field grow">
                <label htmlFor="share-title">Título</label>
                <input id="share-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="opcional" />
              </div>
              <div className="field">
                <label htmlFor="share-days">Validade</label>
                <div className="unit-input">
                  <input
                    id="share-days"
                    type="number"
                    min={1}
                    max={policy.maxDays}
                    value={days ?? policy.defaultDays}
                    onChange={(e) => setDays(Math.min(policy.maxDays, Math.max(1, Number(e.target.value) || 1)))}
                    title={`Máximo desta organização: ${policy.maxDays} dias`}
                  />
                  <span>dias</span>
                </div>
              </div>
            </div>

            {target.scope === "pipeline" ? (
              <div className="share-section">
                <div className="field">
                  <label htmlFor="share-period">Período mostrado</label>
                  <div className="unit-input">
                    <input id="share-period" type="number" min={1} max={90} value={options.periodDays} onChange={(e) => setOptions((o) => ({ ...o, periodDays: Math.min(90, Math.max(1, Number(e.target.value) || 1)) }))} />
                    <span>dias</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="share-section">
                <div className="share-label">Mostrar também</div>
                <div className="toggle-list">
                  {extras.map((x) => (
                    <label key={x.key} className="toggle-row">
                      <input type="checkbox" checked={options[x.key] as boolean} onChange={() => toggle(x.key)} />
                      <span>
                        {x.label}
                        {x.hint ? <small>{x.hint}</small> : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <p className="share-note">
              <Icon name="key" size={13} />
              Tokens, senhas, chaves e e-mails nos textos são mascarados antes de publicar. Logs e arquivos nunca aparecem.
            </p>
          </div>

          <div className="share-preview">
            <div className="share-preview-label">
              <Icon name="eye" size={14} />
              Prévia: exatamente o que o visitante vai ver
            </div>
            {preview?.view ? (
              <>
                <PublicReport view={preview.view} />
                <p className="share-omitted">
                  <strong>Não aparece:</strong> {preview.view.omitted.join(" · ")}.
                </p>
              </>
            ) : preview?.error ? (
              <div className="notice warning">{preview.error}</div>
            ) : (
              <Loading />
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ---------- Lista de links ----------

const STATUS_TEXT: Record<ShareLink["status"], { label: string; badge: string }> = {
  active: { label: "Ativo", badge: "good" },
  expired: { label: "Expirado", badge: "neutral" },
  revoked: { label: "Revogado", badge: "neutral" },
};

export function ShareLinksList({ pipelineId }: { pipelineId?: string }) {
  const { data, version, refresh, notify, session } = useApp();
  const canShare = Boolean(session.organization?.permissions.share);
  const result = useAsync(() => (canShare ? data.shareLinks(pipelineId ? { pipelineId } : {}) : Promise.resolve([])), [data, version, pipelineId, canShare]);
  if (!canShare) return <div className="empty">Seu papel não permite compartilhar relatórios.</div>;
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  const revoke = async (l: ShareLink) => {
    const ok = await confirmDialog({ title: "Revogar link", message: <>Quem tiver o link <strong>{l.title}</strong> perde o acesso na hora. Não dá para desfazer.</>, confirmLabel: "Revogar", danger: true });
    if (!ok) return;
    try {
      await data.revokeShareLink(l.id);
      notify("Link revogado.");
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível revogar.", "error");
    }
  };
  if (!result.value.length) return <div className="empty">Nenhum link criado. Compartilhe pela janela de uma execução ou pelo painel de uma pipeline.</div>;
  return (
    <section className="card flush">
      <table className="list">
        <thead>
          <tr>
            <th>Link</th>
            {!pipelineId ? <th>Pipeline</th> : null}
            <th>Acesso</th>
            <th>Situação</th>
            <th>Validade</th>
            <th className="right">Aberturas</th>
            <th className="right" aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {result.value.map((l) => (
            <tr key={l.id}>
              <td>
                <strong>{l.title}</strong>
                <div className="secondary">{l.scope === "execution" ? "resultado de uma execução" : `painel · ${l.options.periodDays} dias`}</div>
              </td>
              {!pipelineId ? <td className="nowrap">{l.pipelineName}</td> : null}
              <td className="nowrap">{l.access === "public" ? "Público" : "Só membros"}</td>
              <td>
                <span className={`badge ${STATUS_TEXT[l.status].badge}`}>{STATUS_TEXT[l.status].label}</span>
              </td>
              <td className="nowrap">{dateTime(l.expiresAt)}</td>
              <td className="right num" title={l.lastViewedAt ? `Última abertura: ${dateTime(l.lastViewedAt)}` : "Nunca aberto"}>
                {l.viewCount}
              </td>
              <td className="right">{l.status === "active" ? <IconButton icon="ban" label="Revogar link" danger onClick={() => void revoke(l)} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- Página pública ----------

/** Lê o token do endereço (/compartilhado#<token>) e limpa o histórico; undefined se não for essa página. */
export function shareTokenFromLocation(): string | undefined {
  if (location.pathname !== "/compartilhado") return undefined;
  const token = location.hash.replace(/^#/, "");
  history.replaceState(null, "", "/compartilhado");
  return token;
}

const PENDING_KEY = "painel.pendingShare";

/** Guarda o link (só nesta aba) para voltar a ele depois de entrar. */
function rememberPendingShare(token: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, token);
  } catch {
    /* sem armazenamento: a pessoa abre o link de novo depois de entrar */
  }
}

/** Devolve e apaga o link guardado antes de entrar. */
export function takePendingShare(): string | undefined {
  try {
    const token = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return token && /^[A-Za-z0-9_.-]{20,4000}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function PublicSharePage({ token }: { token: string }) {
  const [state, setState] = useState<{ view?: PublicView; error?: string; login?: boolean }>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      if (token.startsWith("demo.")) return demoViewFromToken(token);
      const res = await fetch("/api/public/share", { headers: { accept: "application/json", "x-share-token": token }, credentials: "same-origin" });
      const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
      if (!res.ok) throw new ApiError(res.status, body?.error ?? "internal", body?.message ?? "Não foi possível abrir o link.");
      return body as PublicView;
    })().then(
      (view) => alive && setState({ view }),
      (err: unknown) => alive && setState({ error: err instanceof Error ? err.message : "Não foi possível abrir o link.", login: err instanceof ApiError && err.status === 401 }),
    );
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div className="public-page">
      <div className="public-brand">
        <img className="login-logo" src="/logo.png" alt="" />
        <span className="entry-name">Nexo</span>
        <span className="muted small-print">relatório compartilhado · somente leitura</span>
      </div>
      {state.view ? (
        <PublicReport view={state.view} />
      ) : state.error ? (
        <div className="card entry-card">
          <p>{state.error}</p>
          {state.login ? (
            <a className="btn primary" href="/" onClick={() => rememberPendingShare(token)}>
              Entrar
            </a>
          ) : null}
        </div>
      ) : (
        <Loading />
      )}
    </div>
  );
}
