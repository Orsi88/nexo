import { useEffect, useMemo, useState } from "react";
import { LinkPipelineWizard } from "./Forms.tsx";
import { byDay, RunsByDayChart, RunStrip, Stat, StatusBadge, STATUS_META } from "../charts.tsx";
import { useApp } from "../context.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { ago, dateTime, Failure, minutes, PageSkeleton, useAsync } from "../util.tsx";
import type { AuditEvent, Integration, LinkedPipeline, Project, Run } from "../data/types.ts";

// Visão geral da ORGANIZAÇÃO: soma de todos os projetos e pipelines, o que precisa de atenção e
// a saúde de cada projeto. O detalhe de uma pipeline fica na página dela.

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Taxa de sucesso das concluídas (canceladas não contam). */
function successRate(runs: Run[]): number | null {
  const done = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
  return done.length ? Math.round((done.filter((r) => r.status === "succeeded").length / done.length) * 100) : null;
}

interface Attention {
  key: string;
  icon: IconName;
  tone: "critical" | "warning";
  title: string;
  detail: string;
  open?: () => void;
}

export function Overview() {
  const { data, session, open, setPanel, version } = useApp();
  const [linking, setLinking] = useState(false);
  const result = useAsync(
    async () => {
      const [runs, pipelines, projects, integrations, audit] = await Promise.all([
        data.runs(),
        data.pipelines(),
        data.projects(),
        data.integrations(),
        data.audit().catch(() => [] as AuditEvent[]), // a auditoria depende do papel
      ]);
      return { runs, pipelines, projects, integrations, audit };
    },
    [data, version],
  );

  useEffect(() => {
    setPanel(
      <>
        <div className="panel-section">
          <div className="panel-label">Organização</div>
          <div style={{ fontWeight: 600 }}>{session.organization?.name}</div>
          <div style={{ color: "var(--faint)", fontSize: "0.8rem" }}>{session.organization?.slug}</div>
        </div>
      </>,
    );
  }, [session, setPanel]);

  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { runs, pipelines, projects, integrations, audit } = result.value;
  const active = pipelines.filter((p) => !p.archivedAt);
  const attention = attentionItems(active, runs, integrations, (id) => open({ kind: "pipeline", id }), () => open({ kind: "integrations" }));

  return (
    <>
      <div className="page-head">
        <div className="icon-tile">
          <Icon name="home" size={20} />
        </div>
        <div className="grow">
          <h1>Visão geral</h1>
          <div className="sub">
            {session.organization?.name} · {projects.length} projeto{projects.length === 1 ? "" : "s"} · {active.length} pipeline
            {active.length === 1 ? "" : "s"}
          </div>
        </div>
        <button className="btn primary" type="button" onClick={() => setLinking(true)}>
          <Icon name="plus" size={15} />
          Vincular pipeline
        </button>
      </div>
      {linking ? <LinkPipelineWizard onClose={() => setLinking(false)} /> : null}

      <OrgStats runs={runs} pipelines={active} attention={attention.length} />

      <AttentionList items={attention} />

      <div className="section">
        <h2>
          <Icon name="folder" size={14} />
          Projetos
        </h2>
        <div className="grid two">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              pipelines={active.filter((p) => p.projectId === project.id)}
              runs={runs}
              onOpenProject={() => open({ kind: "pipelines", projectId: project.id })}
              onOpenPipeline={(id) => open({ kind: "pipeline", id })}
            />
          ))}
        </div>
      </div>

      {runs && runs.length ? (
        <div className="grid two section">
          <RunsByDayChart runs={runs} />
          <SuccessByPipeline pipelines={active} runs={runs} onOpen={(id) => open({ kind: "pipeline", id })} />
        </div>
      ) : null}

      {audit.length ? <RecentActivity events={audit.slice(0, 6)} pipelines={pipelines} /> : null}
    </>
  );
}

function OrgStats({ runs, pipelines, attention }: { runs: Run[] | null; pipelines: LinkedPipeline[]; attention: number }) {
  const s = useMemo(() => {
    const all = runs ?? [];
    const days = byDay(all, 14);
    const lastByPipeline = pipelines.map((p) => all.find((r) => r.pipelineId === p.id)).filter((r): r is Run => !!r);
    return {
      rate: successRate(all),
      total: all.length,
      perDay: Math.round((all.length / 30) * 10) / 10,
      failing: lastByPipeline.filter((r) => r.status === "failed").length,
      withRuns: lastByPipeline.length,
      sparkRate: days.map((d) => successRate(d.runs)),
      sparkCount: days.map((d) => d.runs.length),
    };
  }, [runs, pipelines]);
  const low = s.rate !== null && s.rate < 50;

  if (!runs) {
    return (
      <div className="notice">
        <Icon name="clock" />
        <div>Os números de execução chegam no incremento 3 (disparo, fila e cancelamento).</div>
      </div>
    );
  }
  return (
    <div className="grid stats">
      <Stat
        title="Taxa de sucesso geral"
        value={s.rate === null ? "—" : `${s.rate}%`}
        tone={low ? "critical" : "good"}
        foot="todas as pipelines · 30 dias"
        spark={s.sparkRate}
        sparkColor={low ? "var(--critical)" : "var(--good)"}
      />
      <Stat title="Execuções" value={s.total} foot={`${s.perDay} por dia, em média`} spark={s.sparkCount} sparkColor="var(--muted)" />
      <Stat
        title="Falhando agora"
        value={
          <>
            {s.failing}
            <span className="stat-of">/{s.withRuns}</span>
          </>
        }
        tone={s.failing ? "critical" : "good"}
        foot="pipelines com a última execução em falha"
      />
      <Stat
        title="Precisa de atenção"
        value={attention}
        {...(attention ? { tone: "critical" as const } : {})}
        foot={attention ? "itens na lista abaixo" : "nada pendente"}
      />
    </div>
  );
}

function attentionItems(
  pipelines: LinkedPipeline[],
  runs: Run[] | null,
  integrations: Integration[],
  openPipeline: (id: string) => void,
  openIntegrations: () => void,
): Attention[] {
  const items: Attention[] = [];
  for (const i of integrations.filter((x) => !x.archivedAt && x.status !== "ok")) {
    items.push({
      key: `int-${i.id}`,
      icon: "plug",
      tone: "critical",
      title: `Integração ${i.name} ${i.status === "failing" ? "falhando" : "não testada"}`,
      detail: i.lastCheck?.message ?? "As pipelines dela não sincronizam nem disparam.",
      open: openIntegrations,
    });
  }
  for (const p of pipelines) {
    const mine = runs?.filter((r) => r.pipelineId === p.id) ?? [];
    const last = mine[0];
    if (last?.status === "failed") {
      let streak = 0;
      for (const r of mine) {
        if (r.status === "failed") streak++;
        else if (r.status !== "cancelled") break;
      }
      items.push({
        key: `fail-${p.id}`,
        icon: "x",
        tone: "critical",
        title: `${p.name}: última execução falhou`,
        detail: `${streak > 1 ? `${streak} falhas seguidas · ` : ""}${ago(last.queuedAt)}`,
        open: () => openPipeline(p.id),
      });
    }
    if (p.syncState !== "synchronized") {
      items.push({
        key: `sync-${p.id}`,
        icon: "alert",
        tone: "warning",
        title: `${p.name}: dados não confirmados`,
        detail: p.syncProblem ?? `Última leitura ${ago(p.syncedAt)}.`,
        open: () => openPipeline(p.id),
      });
    }
  }
  return items;
}

function AttentionList({ items }: { items: Attention[] }) {
  return (
    <div className="section" style={{ marginTop: 24 }}>
      <h2>
        <Icon name="alert" size={14} />
        Precisa de atenção
      </h2>
      {items.length === 0 ? (
        <div className="card attention-ok">
          <Icon name="check" size={16} />
          Tudo em ordem: nenhuma pipeline falhando e todas as integrações respondendo.
        </div>
      ) : (
        <div className="card flush">
          {items.map((it) => (
            <button key={it.key} type="button" className="attention-row" onClick={it.open} disabled={!it.open}>
              <span className={`attention-icon ${it.tone}`}>
                <Icon name={it.icon} size={14} />
              </span>
              <span className="grow">
                <strong>{it.title}</strong>
                <span className="secondary">{it.detail}</span>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  pipelines,
  runs,
  onOpenProject,
  onOpenPipeline,
}: {
  project: Project;
  pipelines: LinkedPipeline[];
  runs: Run[] | null;
  onOpenProject: () => void;
  onOpenPipeline: (id: string) => void;
}) {
  const projectRuns = (runs ?? []).filter((r) => pipelines.some((p) => p.id === r.pipelineId));
  const rate = successRate(projectRuns);
  return (
    <section className="card project-card">
      <button type="button" className="project-head" onClick={onOpenProject}>
        <Icon name="folder" size={16} />
        <strong>{project.name}</strong>
        <span className="grow" />
        {rate !== null ? (
          <span className="num" style={{ color: rate < 50 ? "var(--critical-text)" : "var(--muted)" }} title="Taxa de sucesso do projeto, 30 dias">
            {rate}%
          </span>
        ) : null}
        <Icon name="chevron" size={14} />
      </button>
      {pipelines.length === 0 ? (
        <div className="secondary" style={{ padding: "6px 0" }}>
          Nenhuma pipeline vinculada.
        </div>
      ) : (
        <div className="project-pipes">
          {pipelines.map((p) => {
            const mine = projectRuns.filter((r) => r.pipelineId === p.id);
            return (
              <button key={p.id} type="button" className="project-pipe" onClick={() => onOpenPipeline(p.id)}>
                <span className="name">{p.name}</span>
                {mine.length ? <RunStrip runs={mine} count={14} /> : <span className="secondary">sem execuções</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Taxa de sucesso por pipeline, da pior para a melhor: onde está o problema. */
function SuccessByPipeline({ pipelines, runs, onOpen }: { pipelines: LinkedPipeline[]; runs: Run[]; onOpen: (id: string) => void }) {
  const rows = pipelines
    .map((p) => {
      const mine = runs.filter((r) => r.pipelineId === p.id);
      return {
        p,
        rate: successRate(mine),
        count: mine.length,
        med: median(mine.filter((r) => r.durationMinutes && r.status !== "cancelled").map((r) => r.durationMinutes!)),
      };
    })
    .filter((r): r is typeof r & { rate: number } => r.rate !== null)
    .sort((a, b) => a.rate - b.rate);
  const color = (rate: number) => (rate < 50 ? "var(--critical)" : rate < 80 ? "var(--warning)" : "var(--good)");
  return (
    <section className="card">
      <div className="card-title">
        <span>Taxa de sucesso por pipeline</span>
        <span className="hint">30 dias · pior primeiro</span>
      </div>
      <div className="legend chart-legend">
        <span>
          <span className="sw" style={{ background: "var(--critical)" }} />
          abaixo de 50%
        </span>
        <span>
          <span className="sw" style={{ background: "var(--warning)" }} />
          50–79%
        </span>
        <span>
          <span className="sw" style={{ background: "var(--good)" }} />
          80% ou mais
        </span>
      </div>
      <div className="rate-list">
        {rows.map(({ p, rate, count, med }) => (
          <button key={p.id} type="button" className="rate-row" onClick={() => onOpen(p.id)} title={`${count} execuções · duração mediana ${minutes(med)}`}>
            <span className="rate-name">{p.name}</span>
            <span className="rate-bar" aria-hidden="true">
              <span style={{ width: `${rate}%`, background: color(rate) }} />
            </span>
            <span className="rate-value num">{rate}%</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const ACTIVITY: Record<string, string> = {
  "integration.create": "Integração cadastrada",
  "integration.test": "Integração testada",
  "integration.credential.rotate": "Credencial trocada",
  "pipeline.import": "Pipeline vinculada",
  "pipeline.sync": "Pipeline sincronizada",
  "pipeline.manifest.save": "Manifesto salvo",
  "pipeline.manifest.import": "Manifesto importado",
  "member.invite": "Membro convidado",
};

function RecentActivity({ events, pipelines }: { events: AuditEvent[]; pipelines: LinkedPipeline[] }) {
  return (
    <div className="section">
      <h2>
        <Icon name="history" size={14} />
        Atividade recente
      </h2>
      <div className="card flush">
        {events.map((e) => {
          const target = e.targetType === "pipeline" ? pipelines.find((p) => p.id === e.targetId)?.name : undefined;
          return (
            <div key={e.id} className="activity-row">
              <span className={`activity-dot${e.outcome === "success" ? "" : " bad"}`} />
              <span className="grow">
                {ACTIVITY[e.action] ?? e.action}
                {target ? <strong> · {target}</strong> : null}
                {e.outcome !== "success" ? (
                  <span className="badge critical" style={{ marginLeft: 8 }}>
                    {e.outcome === "denied" ? "negado" : "falhou"}
                  </span>
                ) : null}
              </span>
              <span className="secondary" title={dateTime(e.occurredAt)}>
                {ago(e.occurredAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Usados em outras telas ----------

/** Os quatro indicadores de execução de UMA pipeline (30 dias), com minigráfico dos últimos 14 dias. */
export function RunStatTiles({ runs }: { runs: Run[] }) {
  const s = useMemo(() => {
    const days = byDay(runs, 14);
    const done = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
    return {
      total: runs.length,
      rate: successRate(runs),
      cancelled: runs.filter((r) => r.status === "cancelled").length,
      median: median(done.map((r) => r.durationMinutes ?? 0)),
      last: runs[0],
      sparkRate: days.map((d) => successRate(d.runs)),
      sparkCount: days.map((d) => d.runs.length),
      sparkDuration: days.map((d) => median(d.runs.filter((r) => r.status !== "cancelled" && r.durationMinutes).map((r) => r.durationMinutes!))),
    };
  }, [runs]);
  const low = s.rate !== null && s.rate < 50;
  return (
    <div className="grid stats">
      <Stat
        title="Taxa de sucesso"
        value={s.rate === null ? "—" : `${s.rate}%`}
        tone={low ? "critical" : "good"}
        foot="concluídas, sem contar canceladas"
        spark={s.sparkRate}
        sparkColor={low ? "var(--critical)" : "var(--good)"}
      />
      <Stat title="Execuções" value={s.total} foot={`${s.cancelled} canceladas · 30 dias`} spark={s.sparkCount} sparkColor="var(--muted)" />
      <Stat title="Duração mediana" value={minutes(s.median)} foot="das concluídas" spark={s.sparkDuration} />
      <Stat
        title="Última execução"
        value={s.last ? <StatusBadge status={s.last.status} /> : "—"}
        foot={s.last ? <span title={dateTime(s.last.queuedAt)}>{ago(s.last.queuedAt)}</span> : undefined}
      >
        <RunStrip runs={runs} count={24} />
      </Stat>
    </div>
  );
}

export function SyncBadge({ pipeline, compact }: { pipeline: LinkedPipeline; compact?: boolean }) {
  // Estado normal fica discreto; só o problema ganha selo colorido.
  // `compact` (tabelas): a coluna já diz "Sincronização", então mostra só o tempo.
  if (pipeline.syncState === "synchronized") {
    return (
      <span className="quiet" title={`Sincronizada em ${dateTime(pipeline.syncedAt)}`}>
        <Icon name="refresh" size={12} />
        {compact ? ago(pipeline.syncedAt) : `sincronizada ${ago(pipeline.syncedAt)}`}
      </span>
    );
  }
  return (
    <span className="badge warning" title={pipeline.syncProblem ?? undefined}>
      <Icon name="alert" size={12} />
      Não confirmada
    </span>
  );
}

/** Cor da última execução, para o pontinho na árvore lateral. */
export function lastRunColor(runs: Run[] | null, pipelineId: string): string | null {
  const last = runs?.find((r) => r.pipelineId === pipelineId);
  return last ? STATUS_META[last.status].color : null;
}
