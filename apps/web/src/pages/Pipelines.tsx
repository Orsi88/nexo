import { useEffect, useMemo, useState } from "react";
import { DurationChart, RunsByDayChart, RunStrip, StatusBadge } from "../charts.tsx";
import { useApp } from "../context.tsx";
import { Icon } from "../icons.tsx";
import { ShareDialog } from "./Share.tsx";
import { ago, branch, dateTime, Failure, Loading, minutes, PageSkeleton, Paged, SOURCE_LABEL, useAsync, usePaged } from "../util.tsx";
import type { Capabilities, LinkedPipeline, ParameterSpec, PipelineDetail, Run, ValidationRule } from "../data/types.ts";
import { LinkPipelineWizard } from "./Forms.tsx";
import { NewPipelineWizard, PipelineFile } from "./PipelineFile.tsx";
import { RunStatTiles, SyncBadge } from "./Overview.tsx";
import { ApiError } from "../data/errors.ts";
import { TestCount } from "./Results.tsx";
import { describeSut, ExecuteDialog, ExecutionDialog, RunActions, SystemVersionCard, SystemVersionText } from "./Execution.tsx";
import { PipelineRules } from "./Alerts.tsx";
import { PipelineConfig } from "./PipelineConfig.tsx";
import { PipelinePerformance } from "./Performance.tsx";

// ---------- Lista ----------

export function PipelineList({ projectId }: { projectId?: string }) {
  const { data, open, setPanel, version } = useApp();
  const [q, setQ] = useState("");
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const result = useAsync(
    async () => ({ pipelines: await data.pipelines(projectId), projects: await data.projects(), runs: await data.runs() }),
    [data, projectId, version],
  );
  const repos = useMemo(() => (result.state === "ready" ? repositoriesOf(result.value.pipelines) : []), [result]);

  useEffect(() => setPanel(null), [setPanel]);

  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { pipelines, projects, runs } = result.value;
  const project = projects.find((p) => p.id === projectId);
  const shown = pipelines.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div className="icon-tile">
          <Icon name={project ? "folder" : "pipeline"} size={20} />
        </div>
        <div className="grow">
          <div className="breadcrumb">{project ? "Projeto" : "Todas as pipelines"}</div>
          <h1>{project?.name ?? "Pipelines"}</h1>
          <div className="sub">
            {pipelines.length} pipeline{pipelines.length === 1 ? "" : "s"} · {repos.length} repositório{repos.length === 1 ? "" : "s"}
          </div>
        </div>
        <input className="search" placeholder="Buscar pipeline" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar pipeline" />
        <button className="btn" type="button" onClick={() => setLinking(true)} title="Trazer uma pipeline que já existe no provedor">
          <Icon name="external" size={15} />
          Vincular existente
        </button>
        <button className="btn primary" type="button" onClick={() => setCreating(true)} title="Criar a pipeline no provedor a partir de um modelo">
          <Icon name="plus" size={15} />
          Nova pipeline
        </button>
      </div>
      {linking ? <LinkPipelineWizard {...(projectId ? { defaultProjectId: projectId } : {})} onClose={() => setLinking(false)} /> : null}
      {creating ? <NewPipelineWizard {...(projectId ? { defaultProjectId: projectId } : {})} onClose={() => setCreating(false)} /> : null}
      {shown.length === 0 ? (
        <div className="empty">Nenhuma pipeline {q ? "encontrada" : "vinculada ainda"}.</div>
      ) : (
        <Paged items={shown}>
          {(page, pager) => (
            <div className="card flush">
              <table className="list">
                <thead>
                  <tr>
                    <th>Pipeline</th>
                    {!project ? <th>Projeto</th> : null}
                    <th>Últimas execuções</th>
                    <th title="Branch de onde os parâmetros foram lidos">Branch</th>
                    <th className="right">Parâmetros</th>
                    <th>Sincronização</th>
                    <th className="right">Manifesto</th>
                  </tr>
                </thead>
                <tbody>
                  {page.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => open({ kind: "pipeline", id: p.id })}>
                      <td>
                        <strong>{p.name}</strong>
                        <div className="secondary mono">{p.externalId}</div>
                      </td>
                      {!project ? <td className="nowrap">{projects.find((x) => x.id === p.projectId)?.name ?? "—"}</td> : null}
                      <td>
                        <RunsCell runs={runs} pipelineId={p.id} />
                      </td>
                      <td className="mono">{branch(p.parametersRef)}</td>
                      <td className="right num">{p.externalParameters.length}</td>
                      <td className="nowrap">
                        <SyncBadge pipeline={p} compact />
                      </td>
                      <td className="right num">v{p.currentVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pager}
            </div>
          )}
        </Paged>
      )}
      {project && repos.length ? (
        <div className="section">
          <h2>
            <Icon name="branch" size={14} />
            Repositórios do projeto
          </h2>
          <RepositoryLinks repos={repos} />
        </div>
      ) : null}
    </>
  );
}

function RunsCell({ runs, pipelineId }: { runs: Run[] | null; pipelineId: string }) {
  const mine = runs?.filter((r) => r.pipelineId === pipelineId) ?? [];
  return mine.length ? <RunStrip runs={mine} count={12} /> : <span style={{ color: "var(--faint)" }}>—</span>;
}

interface Repo {
  name: string;
  url: string;
  pipelines: string[];
}

/** Repositórios distintos das pipelines, com as pipelines que usam cada um. */
function repositoriesOf(pipelines: LinkedPipeline[]): Repo[] {
  const map = new Map<string, Repo>();
  for (const p of pipelines) {
    if (!p.repositoryUrl || !p.repositoryName) continue;
    const repo = map.get(p.repositoryUrl) ?? { name: p.repositoryName, url: p.repositoryUrl, pipelines: [] };
    repo.pipelines.push(p.name);
    map.set(p.repositoryUrl, repo);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function RepositoryLinks({ repos }: { repos: Repo[] }) {
  return (
    <div className="link-list">
      {repos.map((r) => (
        <a key={r.url} className="link-row" href={r.url} target="_blank" rel="noreferrer noopener" title={`Abrir ${r.name} no provedor`}>
          <Icon name="branch" size={16} />
          <span className="grow">
            <strong>{r.name}</strong>
            <div className="secondary">usado por {r.pipelines.join(", ")}</div>
          </span>
          <Icon name="external" size={14} />
        </a>
      ))}
    </div>
  );
}

// ---------- Detalhe ----------

type Sub = "summary" | "parameters" | "config" | "file" | "history" | "runs" | "rules";

export function PipelineView({ id }: { id: string }) {
  const { data, session, setPanel, version, refresh, notify } = useApp();
  const [sub, setSub] = useState<Sub>("summary");
  const [executing, setExecuting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      const updated = await data.syncPipeline(id);
      refresh();
      const n = updated.pipeline.externalParameters.length;
      notify(`Sincronizada: ${n} ${n === 1 ? "parâmetro lido" : "parâmetros lidos"} de ${branch(updated.pipeline.parametersRef)}.`);
    } catch (err) {
      refresh(); // a falha marca os dados como não confirmados; recarrega para mostrar
      notify(err instanceof ApiError ? err.message : "Não foi possível sincronizar.", "error");
    } finally {
      setSyncing(false);
    }
  };
  const result = useAsync(async () => ({ detail: await data.pipeline(id), runs: await data.runs(id) }), [data, id, version]);

  useEffect(() => {
    if (result.state === "ready") setPanel(<PipelinePanel detail={result.value.detail} />);
    else setPanel(null);
  }, [result, setPanel]);

  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { detail, runs } = result.value;
  const { pipeline } = detail;
  const errors = detail.problems.filter((p) => p.severity === "error").length;
  const draft = detail.manifest.manifest.review.status === "draft";
  const canExecute = Boolean(session.organization?.permissions.execute);
  const latestVersion = runs?.find((r) => r.systemVersion && r.systemVersion.parts.length)?.systemVersion;
  const executeBlocked = !pipeline.capabilities.write.triggerRun
    ? "O provedor desta pipeline não permite disparar pela plataforma"
    : pipeline.archivedAt
      ? "A pipeline está arquivada"
      : !canExecute
        ? "Seu papel não permite executar"
        : null;

  return (
    <>
      <section className="card hero">
        <div className="icon-tile">
          <Icon name="pipeline" size={20} />
        </div>
        <div className="grow">
          <div className="breadcrumb">
            {detail.integration.name}
            <Icon name="chevron" size={11} />
            {pipeline.externalPath ?? "—"}
          </div>
          <h1>{pipeline.name}</h1>
        </div>
        <div className="hero-actions">
          {pipeline.repositoryUrl ? (
            <a className="btn" href={pipeline.repositoryUrl} target="_blank" rel="noreferrer noopener" title={`Abrir o repositório ${pipeline.repositoryName ?? ""}`}>
              <Icon name="branch" size={15} />
              Repositório
            </a>
          ) : null}
          {session.organization?.permissions.share ? (
            // Mesmo botão dos vizinhos (mesma altura, fundo e borda), só com o ícone.
            <button type="button" className="btn btn-icon" title="Compartilhar o painel desta pipeline" aria-label="Compartilhar o painel desta pipeline" onClick={() => setSharing(true)}>
              <Icon name="share" size={15} />
            </button>
          ) : null}
          <button className="btn" type="button" onClick={sync} disabled={syncing} title="Ler de novo a definição e os parâmetros no provedor">
            <span className={syncing ? "spin" : undefined} style={{ display: "grid" }}>
              <Icon name="refresh" size={15} />
            </span>
            {syncing ? "Sincronizando…" : "Sincronizar"}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={executeBlocked !== null}
            title={executeBlocked ?? "Escolher parâmetros e ver o que vai acontecer antes de confirmar"}
            onClick={() => setExecuting(true)}
          >
            <Icon name="play" size={15} />
            Executar
          </button>
        </div>
        <div className="chips hero-chips">
          <span className="chip" title="Branch de onde os parâmetros foram lidos">
            <Icon name="branch" size={13} />
            <strong className="mono">{branch(pipeline.parametersRef)}</strong>
          </span>
          <span className="chip">
            <Icon name="file" size={13} />
            manifesto <strong>v{pipeline.currentVersion}</strong> {draft ? "· rascunho" : "· aprovado"}
          </span>
          <span className="chip">
            <Icon name="layers" size={13} />
            <strong>{pipeline.externalParameters.length}</strong> {pipeline.externalParameters.length === 1 ? "parâmetro" : "parâmetros"}
          </span>
          {latestVersion ? (
            <span className="chip sut-chip" title={`Versão de ${latestVersion.system} na execução mais recente que a trouxe`}>
              <Icon name="layers" size={13} />
              {latestVersion.system} <SystemVersionText version={latestVersion} />
            </span>
          ) : null}
          <SyncBadge pipeline={pipeline} />
        </div>
      </section>
      {sharing ? <ShareDialog target={{ scope: "pipeline", pipelineId: id }} onClose={() => setSharing(false)} /> : null}
      {executing ? (
        <ExecuteDialog
          detail={detail}
          onClose={() => setExecuting(false)}
          onDone={() => {
            setExecuting(false);
            setSub("runs");
            refresh();
          }}
        />
      ) : null}

      {pipeline.syncState !== "synchronized" ? (
        <div className="notice warning" role="status">
          <Icon name="alert" />
          <div>
            <strong>Dados não confirmados.</strong> A última sincronização falhou ({pipeline.syncProblem}). O que aparece aqui é o que foi lido{" "}
            {ago(pipeline.syncedAt)}.
          </div>
        </div>
      ) : null}

      <div className="subtabs" role="tablist">
        {(
          [
            ["summary", "Resumo"],
            ["parameters", `Parâmetros${errors ? ` · ${errors} problema${errors > 1 ? "s" : ""}` : ""}`],
            ["config", "Configuração"],
            ["file", "Arquivo"],
            ["history", "Histórico do manifesto"],
            ["runs", "Execuções"],
            ["rules", "Avisos"],
          ] as Array<[Sub, string]>
        ).map(([key, label]) => (
          <button key={key} className="subtab" role="tab" aria-selected={sub === key} type="button" onClick={() => setSub(key)}>
            {label}
          </button>
        ))}
      </div>

      {sub === "summary" ? <Summary detail={detail} runs={runs} /> : null}
      {sub === "parameters" ? <Parameters detail={detail} /> : null}
      {sub === "config" ? <PipelineConfig key={detail.manifest.version} detail={detail} /> : null}
      {sub === "file" ? <PipelineFile detail={detail} /> : null}
      {sub === "history" ? <History pipelineId={id} /> : null}
      {sub === "runs" ? <Runs pipelineId={id} /> : null}
      {sub === "rules" ? <PipelineRules pipelineId={id} /> : null}
    </>
  );
}

function Summary({ detail, runs }: { detail: PipelineDetail; runs: Run[] | null }) {
  const { pipeline, manifest } = detail;
  const m = manifest.manifest;
  const external = (href: string | null, label: string | null) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {label} <Icon name="external" size={12} />
      </a>
    ) : (
      (label ?? "—")
    );
  return (
    <>
      {runs && runs.length ? <RunStatTiles runs={runs} /> : null}

      <div className="section" style={{ marginTop: runs && runs.length ? 12 : 0 }}>
        <SystemVersionCard sut={m.systemUnderTest} runs={runs} />
      </div>

      <div className="grid two" style={{ marginTop: 12 }}>
        <section className="card">
          <div className="card-title">
            <Icon name="plug" size={15} />
            No provedor
          </div>
          <div className="props">
            <Prop label="Caminho">{pipeline.externalPath ?? "—"}</Prop>
            <Prop label="Repositório">{external(pipeline.repositoryUrl, pipeline.repositoryName)}</Prop>
            <Prop label="Branch padrão" mono>
              {branch(pipeline.defaultRef)}
            </Prop>
            <Prop label="Revisão da definição" mono>
              {pipeline.externalRevision ?? "—"}
            </Prop>
            <Prop label="Commit do YAML" mono>
              {pipeline.definitionRevision ?? "—"}
            </Prop>
            <Prop label="Pipeline">{external(pipeline.externalUrl, "abrir no provedor")}</Prop>
          </div>
        </section>
        <section className="card">
          <div className="card-title">
            <Icon name="file" size={15} />
            Na plataforma
          </div>
          <div className="props">
            <Prop label="Manifesto">
              v{manifest.version} · {SOURCE_LABEL[manifest.source]}
            </Prop>
            <Prop label="Salvo em">{dateTime(manifest.createdAt)}</Prop>
            <Prop label="Regras entre parâmetros">{m.validationRules.length || "nenhuma"}</Prop>
            <Prop label="Recursos">
              {m.executionResources.length ? m.executionResources.map((r) => `${r.ref}${r.exclusive ? " (exclusivo)" : ""}`).join(", ") : "nenhum"}
            </Prop>
            <Prop label="Relatórios">{m.reports.map((r) => r.type).join(", ") || "nenhum configurado"}</Prop>
            <Prop label="Versão em teste">{m.systemUnderTest ? describeSut(m.systemUnderTest) : "não configurada"}</Prop>
          </div>
        </section>
      </div>

      {runs && runs.length ? (
        <div className="grid two section" style={{ marginTop: 12 }}>
          <RunsByDayChart runs={runs} />
          <DurationChart runs={runs} />
        </div>
      ) : null}

      {runs?.some((r) => r.performance) ? <PipelinePerformance pipelineId={pipeline.id} /> : null}
    </>
  );
}

function Prop({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">{label}</div>
      <div className={`prop-value${mono ? " mono" : ""}`}>{children}</div>
    </div>
  );
}

const TYPE_LABEL: Record<ParameterSpec["type"], string> = { string: "texto", number: "número", boolean: "sim/não", enum: "lista" };

function defaultText(p: ParameterSpec): string {
  if (p.default === undefined) return "—";
  if (p.type === "boolean") return p.default ? "sim" : "não";
  return String(p.default);
}

function Parameters({ detail }: { detail: PipelineDetail }) {
  const params = detail.manifest.manifest.parameters;
  const problemsBy = useMemo(() => new Map(detail.problems.map((p) => [p.parameter, p])), [detail]);
  const extra = detail.problems.filter((p) => !params.some((x) => x.name === p.parameter));
  return (
    <>
      <Paged items={params}>
        {(page, pager) => (
          <div className="card flush">
            <table className="list">
              <thead>
                <tr>
                  <th>Parâmetro</th>
                  <th>Tipo</th>
                  <th>Padrão</th>
                  <th>Obrigatório</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {page.map((p) => {
                  const problem = problemsBy.get(p.name);
                  return (
                    <tr key={p.name}>
                      <td>
                        <strong>{p.label ?? p.name}</strong>
                        <div className="mono" style={{ color: "var(--faint)" }}>
                          {p.name}
                        </div>
                      </td>
                      <td>
                        {TYPE_LABEL[p.type]}
                        {p.type === "enum" ? <div style={{ color: "var(--faint)", fontSize: "0.78rem" }}>{p.options.join(" · ")}</div> : null}
                      </td>
                      <td className="mono">{defaultText(p)}</td>
                      <td>{p.required ? "sim" : "não"}</td>
                      <td>
                        {problem ? (
                          <span className={`badge ${problem.severity === "error" ? "critical" : ""}`} title={problem.message}>
                            <Icon name="alert" size={12} />
                            {problem.message}
                          </span>
                        ) : (
                          <span className="quiet">
                            <Icon name="check" size={12} />
                            ok
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pager}
          </div>
        )}
      </Paged>
      {extra.length ? (
        <div className="section">
          <h2>Só no provedor</h2>
          {extra.map((p) => (
            <div key={p.parameter} className={`notice ${p.severity === "error" ? "warning" : ""}`}>
              <Icon name={p.severity === "error" ? "alert" : "file"} />
              <div>
                <span className="mono">{p.parameter}</span>: {p.message}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {detail.manifest.manifest.validationRules.length ? (
        <div className="section">
          <h2>Regras entre parâmetros</h2>
          {detail.manifest.manifest.validationRules.map((r) => (
            <RuleLine key={r.id} rule={r} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function RuleLine({ rule }: { rule: ValidationRule }) {
  return (
    <div className="notice">
      <Icon name="branch" />
      <div>
        <strong>{rule.message}</strong>
        <div className="mono" style={{ color: "var(--muted)", marginTop: 2 }}>
          quando {rule.when.parameter} = {String(rule.when.equals)} → {rule.then.parameter} em [{rule.then.in.map(String).join(", ")}]
        </div>
      </div>
    </div>
  );
}

function History({ pipelineId }: { pipelineId: string }) {
  const { data, version } = useApp();
  const result = useAsync(() => data.versions(pipelineId), [data, pipelineId, version]);
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  return (
    <Paged items={result.value}>
      {(page, pager) => (
        <div className="card flush">
          <table className="list">
            <thead>
              <tr>
                <th>Versão</th>
                <th>Origem</th>
                <th>Nota</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {page.map((v, i) => (
                <tr key={v.version}>
                  <td className="num">
                    <strong>v{v.version}</strong> {i === 0 ? <span className="badge accent">atual</span> : null}
                  </td>
                  <td>{SOURCE_LABEL[v.source]}</td>
                  <td>{v.note ?? <span style={{ color: "var(--faint)" }}>—</span>}</td>
                  <td>{dateTime(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pager}
        </div>
      )}
    </Paged>
  );
}

function Runs({ pipelineId }: { pipelineId: string }) {
  const { data, version } = useApp();
  const result = useAsync(() => data.runs(pipelineId), [data, pipelineId, version]);
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  const runs = result.value;
  if (runs === null) return <div className="empty">Esta fonte de dados não tem execuções.</div>;
  if (runs.length === 0) return <div className="empty">Nenhuma execução registrada.</div>;
  return (
    <>
      <div className="grid two">
        <RunsByDayChart runs={runs} />
        <DurationChart runs={runs} />
      </div>
      <RunTable runs={runs} />
    </>
  );
}

const TRIGGER_LABEL: Record<Run["trigger"], string> = {
  schedule: "Agenda do provedor",
  platform: "Pela plataforma",
  manual: "Manual no provedor",
  external: "Fora da plataforma",
};

const DETAIL_LABEL: Partial<Record<NonNullable<Run["detailStatus"]>, string>> = {
  dispatching: "enviando ao provedor",
  cancelling: "cancelando",
  stale: "sem notícia do provedor",
};

function RunTable({ runs }: { runs: Run[] }) {
  const { session } = useApp();
  const { shown, pager } = usePaged(runs);
  const [opened, setOpened] = useState<string | null>(null);
  const perms = session.organization?.permissions ?? {};
  const withVersion = runs.some((r) => r.systemVersion && r.systemVersion.parts.length);
  const withActions = runs.some((r) => r.detailStatus);
  const withTests = runs.some((r) => r.tests || r.performance || r.reportStatus === "missing");
  const onlyPerformance = runs.some((r) => r.performance) && !runs.some((r) => r.tests);
  return (
    <div className="card flush section">
      <table className="list">
        <thead>
          <tr>
            <th>Execução</th>
            <th>Resultado</th>
            {withVersion ? <th>Versão testada</th> : null}
            {withTests ? <th>{onlyPerformance ? "Desempenho" : "Testes"}</th> : null}
            <th>Origem</th>
            <th>Início</th>
            <th className="right">Duração</th>
            {withActions ? <th className="right" aria-label="Ações" /> : null}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={r.detailStatus ? "clickable" : undefined} onClick={(e) => {
                // Clique nos botões da linha (cancelar, reexecutar) não abre o detalhe.
                if (r.detailStatus && !(e.target as HTMLElement).closest("button")) setOpened(r.id);
              }}>
              <td className="mono">{r.number}</td>
              <td>
                <StatusBadge status={r.status} />
                {r.detailStatus && DETAIL_LABEL[r.detailStatus] ? <span className="run-detail">{DETAIL_LABEL[r.detailStatus]}</span> : null}
                {r.status === "queued" && r.queuePosition ? <span className="run-detail">posição {r.queuePosition}</span> : null}
                {r.statusReason && (r.status === "rejected" || r.status === "unknown" || r.detailStatus === "stale") ? (
                  <div className="run-reason">{r.statusReason}</div>
                ) : null}
              </td>
              {withVersion ? (
                <td>{r.systemVersion && r.systemVersion.parts.length ? <SystemVersionText version={r.systemVersion} /> : <span className="muted">—</span>}</td>
              ) : null}
              {withTests ? (
                <td className="nowrap">
                  <TestCount tests={r.tests} reportStatus={r.reportStatus} cancelled={r.status === "cancelled"} performance={r.performance} />
                </td>
              ) : null}
              <td className="nowrap">
                {TRIGGER_LABEL[r.trigger]}
                {r.rerunOf ? <span className="run-detail">reexecução</span> : null}
              </td>
              <td className="nowrap">{dateTime(r.queuedAt)}</td>
              <td className="right num">{minutes(r.durationMinutes)}</td>
              {withActions ? (
                <td className="right">
                  <RunActions run={r} canCancel={Boolean(perms.cancel)} canRerun={Boolean(perms.execute)} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {pager}
      {opened ? <ExecutionDialog id={opened} onClose={() => setOpened(null)} /> : null}
    </div>
  );
}

const CAP_LABELS: Array<[string, (c: Capabilities) => boolean]> = [
  ["Ler parâmetros", (c) => c.read.parameters],
  ["Ler execuções", (c) => c.read.runs],
  ["Ler logs", (c) => c.read.logs],
  ["Baixar artefatos", (c) => c.read.artifacts],
  ["Disparar", (c) => c.write.triggerRun],
  ["Cancelar", (c) => c.write.cancelRun],
  ["Editar o YAML", (c) => c.write.definitionViaCommit || c.write.definitionViaPullRequest],
  ["Receber eventos", (c) => c.events.webhooks],
];

function PipelinePanel({ detail }: { detail: PipelineDetail }) {
  const { pipeline, integration } = detail;
  return (
    <>
      {integration.status !== "ok" ? (
        <div className="notice warning">
          <Icon name="alert" />
          <div>
            A integração <strong>{integration.name}</strong> {integration.status === "failing" ? "está falhando" : "ainda não foi testada"}. Sem
            ela, a pipeline não sincroniza nem dispara.
          </div>
        </div>
      ) : null}
      <div className="panel-section">
        <div className="panel-label">Capacidades do conector</div>
        <ul className="checklist">
          {CAP_LABELS.map(([label, has]) => {
            const ok = has(pipeline.capabilities);
            return (
              <li key={label} className={ok ? "done" : "off"}>
                <Icon name={ok ? "check" : "ban"} size={14} />
                <span>
                  {label}
                  {ok ? null : <span style={{ fontSize: "0.72rem" }}> · não suportado</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="panel-section">
        <div className="panel-label">Identificadores</div>
        <dl className="kv mono" style={{ fontSize: "0.76rem" }}>
          <dt>externo</dt>
          <dd>{pipeline.externalId}</dd>
          <dt>interno</dt>
          <dd title={pipeline.id}>{pipeline.id.slice(0, 8)}…</dd>
        </dl>
      </div>
    </>
  );
}
