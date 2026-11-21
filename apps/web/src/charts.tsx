import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.tsx";
import type { Run, RunStatus } from "./data/types.ts";

// Gráficos em SVG no estilo dos painéis do Grafana: grade discreta, marcas finas, área com degradê,
// crosshair e tooltip. Regras do skill de dataviz: cores de status reservadas e sempre com ícone +
// rótulo; legenda para 2+ séries; um eixo só; tabela alternativa em todo gráfico.

export const STATUS_META: Record<RunStatus, { label: string; color: string; icon: IconName; badge: string }> = {
  succeeded: { label: "Sucesso", color: "var(--good)", icon: "check", badge: "good" },
  failed: { label: "Falha", color: "var(--critical)", icon: "x", badge: "critical" },
  cancelled: { label: "Cancelada", color: "var(--neutral)", icon: "ban", badge: "neutral" },
  running: { label: "Em execução", color: "var(--accent)", icon: "play", badge: "accent" },
  queued: { label: "Na fila", color: "var(--warning)", icon: "clock", badge: "warning" },
  rejected: { label: "Recusada", color: "var(--neutral)", icon: "ban", badge: "neutral" },
  unknown: { label: "Indefinida", color: "var(--neutral)", icon: "alert", badge: "neutral" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`badge ${m.badge}`}>
      <Icon name={m.icon} size={12} />
      {m.label}
    </span>
  );
}

/** Largura real do contêiner, medida antes de pintar e acompanhada a cada redimensionamento. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const dayLabel = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00Z").toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");

/** Agrupa execuções por dia (UTC) nos últimos `days` dias, incluindo dias vazios. */
export function byDay(runs: Run[], days: number) {
  const out: Array<{ day: string; runs: Run[] } & Record<RunStatus, number>> = [];
  const today = new Date();
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - d);
    out.push({ day: date.toISOString().slice(0, 10), runs: [], succeeded: 0, failed: 0, cancelled: 0, running: 0, queued: 0, rejected: 0, unknown: 0 });
  }
  const index = new Map(out.map((row, i) => [row.day, i]));
  for (const r of runs) {
    const i = index.get(r.queuedAt.slice(0, 10));
    if (i === undefined) continue;
    out[i]![r.status]++;
    out[i]!.runs.push(r);
  }
  return out;
}

interface FrameProps {
  title: string;
  hint?: string;
  legend?: Array<{ label: string; color: string }>;
  children: ReactNode;
  table: ReactNode;
}

function ChartFrame({ title, hint, legend, children, table }: FrameProps) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="card chart-card" aria-label={title}>
      <header className="card-title">
        <span>{title}</span>
        {hint ? <span className="hint">{hint}</span> : null}
        <span className="grow" />
        <button className="table-toggle" type="button" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable} title="Alternar gráfico e tabela">
          <Icon name={showTable ? "chart" : "table"} size={14} />
        </button>
      </header>
      {legend && !showTable ? (
        <div className="legend chart-legend">
          {legend.map((l) => (
            <span key={l.label}>
              <span className="sw" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      ) : null}
      {showTable ? <div className="chart-table">{table}</div> : children}
    </section>
  );
}

// ---------- Execuções por dia (barras empilhadas por resultado) ----------

const STACK: RunStatus[] = ["succeeded", "failed", "cancelled"];
const HEIGHT = 200;

export function RunsByDayChart({ runs, days = 30 }: { runs: Run[]; days?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => byDay(runs, days), [runs, days]);

  const pad = { top: 10, right: 4, bottom: 24, left: 26 };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = HEIGHT - pad.top - pad.bottom;
  const max = niceMax(Math.max(2, ...data.map((d) => d.succeeded + d.failed + d.cancelled)));
  const slot = innerW / data.length;
  const barW = Math.max(3, Math.min(14, slot * 0.62));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 70))));
  const hovered = hover !== null ? data[hover] : undefined;

  return (
    <ChartFrame
      title="Execuções por dia"
      hint={`${days} dias`}
      legend={STACK.map((s) => ({ label: STATUS_META[s].label, color: STATUS_META[s].color }))}
      table={
        <table className="list num">
          <thead>
            <tr>
              <th>Dia</th>
              {STACK.map((s) => (
                <th key={s} className="right">
                  {STATUS_META[s].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{dayLabel(d.day)}</td>
                {STACK.map((s) => (
                  <td key={s} className="right">
                    {d[s]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="chart" ref={ref} onMouseLeave={() => setHover(null)} style={{ minHeight: HEIGHT }}>
        {width > 0 ? (
          <svg viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" role="img" aria-label="Execuções por dia, empilhadas por resultado">
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 ? <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} /> : null}
                <text className="tick" x={pad.left - 8} y={y(t) + 3} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {hover !== null ? (
              <rect className="hover-band" x={pad.left + hover * slot} y={pad.top} width={slot} height={innerH} />
            ) : null}
            {data.map((d, i) => {
              const x = pad.left + i * slot + (slot - barW) / 2;
              let acc = 0;
              const segments = STACK.filter((s) => d[s] > 0);
              return (
                <g key={d.day} className="bar" data-dim={hover !== null && hover !== i ? "" : undefined}>
                  {segments.map((s, si) => {
                    const top = si === segments.length - 1;
                    const y0 = y(acc);
                    acc += d[s];
                    const y1 = y(acc);
                    // 2px de folga acima de cada segmento que tem outro por cima; só a ponta de cima é arredondada.
                    const yy = top ? y1 : y1 + 2;
                    const h = Math.max(1, y0 - yy);
                    const r = top ? Math.min(3, barW / 2, h) : 0;
                    return (
                      <path
                        key={s}
                        fill={STATUS_META[s].color}
                        d={`M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${yy + h} Z`}
                      />
                    );
                  })}
                  {i % labelEvery === 0 ? (
                    <text className="tick" x={x + barW / 2} y={HEIGHT - 6} textAnchor="middle">
                      {dayLabel(d.day)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <line className="axis" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
            {data.map((d, i) => (
              <rect key={d.day} x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>
        ) : null}
        {hovered && hover !== null ? (
          <Tooltip x={pad.left + hover * slot + slot / 2} width={width} title={dayLabel(hovered.day)}>
            {STACK.map((s) => (
              <div className="tt-row" key={s}>
                <span className="sw" style={{ background: STATUS_META[s].color }} />
                <span className="grow">{STATUS_META[s].label}</span>
                <strong className="num">{hovered[s]}</strong>
              </div>
            ))}
          </Tooltip>
        ) : null}
      </div>
    </ChartFrame>
  );
}

function Tooltip({ x, width, title, children }: { x: number; width: number; title: ReactNode; children: ReactNode }) {
  const flip = x > width - 190;
  return (
    <div className="tooltip" role="status" style={flip ? { right: width - x + 12, top: 8 } : { left: x + 12, top: 8 }}>
      <div className="tt-title">{title}</div>
      {children}
    </div>
  );
}

// ---------- Duração das execuções concluídas (linha com área) ----------

export function DurationChart({ runs }: { runs: Run[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = "g" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const points = useMemo(
    () =>
      runs
        .filter((r) => (r.status === "succeeded" || r.status === "failed") && r.durationMinutes !== null)
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
    [runs],
  );

  const pad = { top: 10, right: 8, bottom: 24, left: 34 };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = HEIGHT - pad.top - pad.bottom;
  const t0 = points.length ? Date.parse(points[0]!.queuedAt) : 0;
  const t1 = points.length ? Date.parse(points[points.length - 1]!.queuedAt) : 1;
  const max = niceMax(Math.max(60, ...points.map((p) => p.durationMinutes!)));
  const x = (iso: string) => pad.left + ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * innerW;
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.queuedAt).toFixed(1)},${y(p.durationMinutes!).toFixed(1)}`).join(" ");
  const area = points.length ? `${line} L${x(points[points.length - 1]!.queuedAt).toFixed(1)},${y(0)} L${x(points[0]!.queuedAt).toFixed(1)},${y(0)} Z` : "";
  const ticks = [0, max / 2, max];
  const hp = hover !== null ? points[hover] : undefined;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left + pad.left;
    let best = 0;
    let dist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(p.queuedAt) - mx);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <ChartFrame
      title="Duração"
      hint="minutos · concluídas"
      table={
        <table className="list num">
          <thead>
            <tr>
              <th>Execução</th>
              <th>Início</th>
              <th>Resultado</th>
              <th className="right">Minutos</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.number}</td>
                <td>{new Date(p.queuedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{STATUS_META[p.status].label}</td>
                <td className="right">{p.durationMinutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="chart" ref={ref} onMouseLeave={() => setHover(null)} style={{ minHeight: HEIGHT }}>
        {points.length === 0 ? (
          <div className="empty">Sem execuções concluídas no período.</div>
        ) : width > 0 ? (
          <svg viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" role="img" aria-label="Duração das execuções concluídas ao longo do tempo">
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 ? <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} /> : null}
                <text className="tick" x={pad.left - 8} y={y(t) + 3} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            <path d={area} fill={`url(#${gradient})`} />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
            <line className="axis" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
            {[0, 0.5, 1].map((f) => {
              const iso = new Date(t0 + (t1 - t0) * f).toISOString();
              return (
                <text key={f} className="tick" x={x(iso)} y={HEIGHT - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>
                  {dayLabel(iso)}
                </text>
              );
            })}
            {hp ? (
              <g>
                <line className="crosshair" x1={x(hp.queuedAt)} x2={x(hp.queuedAt)} y1={pad.top} y2={y(0)} />
                <circle cx={x(hp.queuedAt)} cy={y(hp.durationMinutes!)} r={4.5} fill={STATUS_META[hp.status].color} stroke="var(--chart-surface)" strokeWidth={2} />
              </g>
            ) : null}
            <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} />
          </svg>
        ) : null}
        {hp ? (
          <Tooltip x={x(hp.queuedAt)} width={width} title={`${hp.number} · ${new Date(hp.queuedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`}>
            <div className="tt-row">
              <span className="grow">Duração</span>
              <strong className="num">{hp.durationMinutes} min</strong>
            </div>
            <div className="tt-row">
              <span className="grow">Resultado</span>
              <StatusBadge status={hp.status} />
            </div>
          </Tooltip>
        ) : null}
      </div>
    </ChartFrame>
  );
}

// ---------- Métrica por execução (uma série; marca as execuções com problema) ----------

export interface MetricPoint {
  key: string;
  /** Rótulo da execução (número). */
  label: string;
  at: string;
  value: number | null;
  /** Execução com problema (ex.: threshold não atendido): ponto com anel de status + texto no tooltip. */
  flagged?: string | undefined;
}

/**
 * Uma métrica ao longo das execuções, em ordem (não por tempo: execuções do mesmo dia ficam legíveis).
 * Uma série só, sem legenda (o título a nomeia); um eixo só. A linha de limite, quando existe, é
 * referência discreta, rotulada no próprio gráfico.
 */
export function MetricLineChart({
  title,
  hint,
  points,
  format,
  limit,
}: {
  title: string;
  hint?: string;
  points: MetricPoint[];
  format: (v: number) => string;
  limit?: { value: number; label: string } | undefined;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const known = points.filter((p) => p.value !== null);
  const pad = { top: 12, right: 10, bottom: 24, left: 46 };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = HEIGHT - pad.top - pad.bottom;
  const max = niceMax(Math.max(limit?.value ?? 0, ...known.map((p) => p.value!)) * 1.08);
  const x = (i: number) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  // Pontos sem valor quebram a linha em vez de cair para zero.
  let line = "";
  let started = false;
  points.forEach((p, i) => {
    if (p.value === null) {
      started = false;
      return;
    }
    line += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
    started = true;
  });
  const firstKnown = points.findIndex((p) => p.value !== null);
  const lastKnown = points.length - 1 - [...points].reverse().findIndex((p) => p.value !== null);
  const area = known.length > 1 && points.every((p) => p.value !== null) ? `${line} L${x(lastKnown).toFixed(1)},${y(0)} L${x(firstKnown).toFixed(1)},${y(0)} Z` : "";
  const ticks = [0, max / 2, max];
  const hp = hover !== null ? points[hover] : undefined;
  const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const i = points.length > 1 ? Math.round((mx / innerW) * (points.length - 1)) : 0;
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <ChartFrame
      title={title}
      {...(hint ? { hint } : {})}
      table={
        <table className="list num">
          <thead>
            <tr>
              <th>Execução</th>
              <th>Quando</th>
              <th className="right">{title}</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key}>
                <td className="mono">{p.label}</td>
                <td>{when(p.at)}</td>
                <td className="right">{p.value === null ? "—" : format(p.value)}</td>
                <td>{p.flagged ?? "ok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="chart" ref={ref} onMouseLeave={() => setHover(null)} style={{ minHeight: HEIGHT }}>
        {known.length === 0 ? (
          <div className="empty">Sem dados no período.</div>
        ) : width > 0 ? (
          <svg viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" role="img" aria-label={`${title} por execução`}>
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 ? <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} /> : null}
                <text className="tick" x={pad.left - 8} y={y(t) + 3} textAnchor="end">
                  {format(t)}
                </text>
              </g>
            ))}
            {limit ? (
              <g>
                <line className="limit-line" x1={pad.left} x2={width - pad.right} y1={y(limit.value)} y2={y(limit.value)} />
                <text className="tick limit-label" x={width - pad.right} y={y(limit.value) - 5} textAnchor="end">
                  {limit.label}
                </text>
              </g>
            ) : null}
            {area ? <path d={area} fill={`url(#${gradient})`} /> : null}
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) =>
              p.value !== null && p.flagged ? (
                <circle key={p.key} cx={x(i)} cy={y(p.value)} r={4.5} fill="var(--critical)" stroke="var(--chart-surface)" strokeWidth={2} />
              ) : null,
            )}
            <line className="axis" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
            {points.length ? (
              <>
                <text className="tick" x={x(0)} y={HEIGHT - 6} textAnchor="start">
                  {dayLabel(points[0]!.at)}
                </text>
                <text className="tick" x={x(points.length - 1)} y={HEIGHT - 6} textAnchor="end">
                  {dayLabel(points[points.length - 1]!.at)}
                </text>
              </>
            ) : null}
            {hp && hp.value !== null ? (
              <g>
                <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={pad.top} y2={y(0)} />
                <circle cx={x(hover!)} cy={y(hp.value)} r={4.5} fill={hp.flagged ? "var(--critical)" : "var(--accent)"} stroke="var(--chart-surface)" strokeWidth={2} />
              </g>
            ) : null}
            <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} />
          </svg>
        ) : null}
        {hp ? (
          <Tooltip x={x(hover!)} width={width} title={`${hp.label} · ${when(hp.at)}`}>
            <div className="tt-row">
              <span className="grow">{title}</span>
              <strong className="num">{hp.value === null ? "—" : format(hp.value)}</strong>
            </div>
            {hp.flagged ? (
              <div className="tt-row">
                <Icon name="alert" size={12} />
                <span className="grow">{hp.flagged}</span>
              </div>
            ) : null}
          </Tooltip>
        ) : null}
      </div>
    </ChartFrame>
  );
}

// ---------- Minigráfico de fundo dos indicadores ----------

export function Sparkline({ values, color = "var(--accent)" }: { values: Array<number | null>; color?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradient = "s" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const h = 36;
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(1, ...known);
  const min = Math.min(0, ...known);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values
    .map((v, i) => (v === null ? null : ([i * step, h - 2 - ((v - min) / (max - min || 1)) * (h - 6)] as const)))
    .filter((p): p is readonly [number, number] => p !== null);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${pts[pts.length - 1]![0].toFixed(1)},${h} L${pts[0]![0].toFixed(1)},${h} Z` : "";
  return (
    <div className="sparkline" ref={ref} aria-hidden="true">
      {width > 0 && pts.length > 1 ? (
        <svg viewBox={`0 0 ${width} ${h}`} width="100%" preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradient})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
      ) : null}
    </div>
  );
}

// ---------- Faixa das últimas execuções (mais antiga à esquerda) ----------

export function RunStrip({ runs, count = 20 }: { runs: Run[]; count?: number }) {
  const recent = runs.slice(0, count).reverse();
  return (
    <div className="run-strip" role="list" aria-label={`Últimas ${recent.length} execuções`}>
      {recent.map((r) => (
        <span
          key={r.id}
          role="listitem"
          className="run-cell"
          style={{ background: STATUS_META[r.status].color }}
          title={`${r.number} · ${STATUS_META[r.status].label} · ${new Date(r.queuedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`}
          aria-label={`${r.number}: ${STATUS_META[r.status].label}`}
        />
      ))}
    </div>
  );
}

// ---------- Indicador (stat do Grafana) ----------

export function Stat({
  title,
  value,
  foot,
  tone,
  spark,
  sparkColor,
  children,
}: {
  title: string;
  value: ReactNode;
  foot?: ReactNode;
  tone?: "good" | "critical";
  spark?: Array<number | null>;
  sparkColor?: string;
  children?: ReactNode;
}) {
  return (
    <section className="card stat" aria-label={title}>
      <div className="stat-title">{title}</div>
      <div className="stat-value num" style={tone ? { color: `var(--${tone}-text)` } : undefined}>
        {value}
      </div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
      {children}
      {spark ? <Sparkline values={spark} {...(sparkColor ? { color: sparkColor } : {})} /> : null}
    </section>
  );
}
