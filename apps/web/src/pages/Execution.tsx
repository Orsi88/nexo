import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.tsx";
import { ApiError } from "../data/errors.ts";
import type { ExecutionDetail, ExecutionPreview, ExternalRef, ParameterSpec, PipelineDetail, Run, SystemUnderTest, SystemVersion } from "../data/types.ts";
import { Icon, IconButton } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { StatusBadge } from "../charts.tsx";
import { ago, branch, Failure, Loading, useAsync } from "../util.tsx";
import { ResultsSection } from "./Results.tsx";
import { ShareDialog } from "./Share.tsx";

// Telas do incremento 3: pedir execução com confirmação (RF-044), ações sobre execuções
// (cancelar, reexecutar) e a versão do sistema em teste. Toda regra é do servidor: a prévia mostra
// o que ele decidiria, e o pedido é decidido de novo por ele.

type Value = string | number | boolean;

const OUTCOME: Record<ExecutionPreview["decision"]["outcome"], { label: string; tone: string; icon: "play" | "clock" | "ban" | "alert"; action: string }> = {
  dispatch: { label: "Vai rodar agora", tone: "good", icon: "play", action: "Executar agora" },
  queue: { label: "Vai esperar na fila", tone: "warning", icon: "clock", action: "Entrar na fila" },
  reject: { label: "Vai ser recusada", tone: "critical", icon: "ban", action: "Pedir mesmo assim" },
  blocked: { label: "Não dá para executar assim", tone: "critical", icon: "alert", action: "Executar" },
};

/** Chave nova por pedido: clique duplo ou nova tentativa não viram duas execuções (RF-057). */
function newKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function ExecuteDialog({ detail, onClose, onDone }: { detail: PipelineDetail; onClose: () => void; onDone: (run: Run) => void }) {
  const { data, notify } = useApp();
  const pipelineId = detail.pipeline.id;
  const profiles = useAsync(() => data.profiles(pipelineId), [data, pipelineId]);
  const [profileId, setProfileId] = useState("");
  const [ref, setRef] = useState("");
  const [values, setValues] = useState<Record<string, Value>>({});
  const [preview, setPreview] = useState<ExecutionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const key = useRef(newKey());
  const [refs, setRefs] = useState<ExternalRef[]>([]);
  // Os campos são os parâmetros que valem para a branch escolhida (vêm da prévia); antes da
  // primeira prévia, os do manifesto.
  const specs = preview?.parameterSpecs ?? detail.manifest.manifest.parameters;

  const profile = profiles.state === "ready" ? profiles.value.find((p) => p.id === profileId) : undefined;
  // O que vale em cada campo: o digitado, senão o do perfil, senão o padrão do manifesto.
  const shown = (name: string): Value | undefined => values[name] ?? profile?.parameters[name] ?? specs.find((s) => s.name === name)?.default;

  // Escolhida na lista, a ref vai completa (uma tag não é refs/heads/...); digitada, vai como está.
  const chosenRef = useMemo(() => {
    const typed = ref.trim();
    return refs.find((r) => r.name === typed)?.ref ?? typed;
  }, [ref, refs]);

  const input = useMemo(
    () => ({
      pipelineId,
      ...(profileId ? { profileId } : {}),
      ...(chosenRef ? { ref: chosenRef } : {}),
      parameters: values,
    }),
    [pipelineId, profileId, chosenRef, values],
  );

  // Sugestões de branches e tags enquanto digita (o provedor filtra pelo trecho).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      data
        .listRefs(pipelineId, ref.trim() || undefined)
        .then((list) => alive && setRefs(list))
        .catch(() => alive && setRefs([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [data, pipelineId, ref]);

  // Trocou para uma branch sem algum parâmetro: o valor digitado para ele sai do pedido.
  useEffect(() => {
    if (!preview) return;
    const names = new Set(preview.parameterSpecs.map((s) => s.name));
    setValues((cur) => (Object.keys(cur).every((k) => names.has(k)) ? cur : Object.fromEntries(Object.entries(cur).filter(([k]) => names.has(k)))));
  }, [preview]);

  // Prévia automática a cada mudança, com um respiro para não chamar a cada tecla.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      data
        .previewExecution(input)
        .then((p) => alive && (setPreview(p), setPreviewError(null)))
        .catch((e: unknown) => alive && setPreviewError(e instanceof Error ? e.message : "Não foi possível prever."));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [data, input]);

  // Mudou o pedido: é outro pedido, com outra chave.
  useEffect(() => {
    key.current = newKey();
    setDuplicateOf(null);
  }, [input]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const run = await data.requestExecution({ ...input, idempotencyKey: key.current, ...(duplicateOf ? { allowDuplicate: true } : {}) });
      notify(
        run.status === "queued"
          ? `Pedido na fila${run.queuePosition ? `, posição ${run.queuePosition}` : ""}.`
          : run.status === "rejected"
            ? `Pedido recusado: ${run.statusReason ?? "recurso ocupado"}.`
            : "Execução enviada ao provedor.",
      );
      onDone(run);
    } catch (err) {
      if (err instanceof ApiError && typeof err.details.duplicateOf === "string") setDuplicateOf(err.details.duplicateOf);
      else setPreviewError(err instanceof Error ? err.message : "Não foi possível pedir a execução.");
    } finally {
      setBusy(false);
    }
  };

  const outcome = preview ? OUTCOME[preview.decision.outcome] : null;
  const violationOf = (name: string) => preview?.violations.find((v) => v.parameter === name)?.message;

  return (
    <Modal
      title="Executar pipeline"
      subtitle={detail.pipeline.name}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button
            className="btn primary"
            type="submit"
            form="execute-form"
            disabled={busy || !preview || preview.decision.outcome === "blocked" || preview.providerCheck?.ok === false}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={14} />}
            {duplicateOf ? "Pedir outra igual" : (outcome?.action ?? "Executar")}
          </button>
        </>
      }
    >
      <form id="execute-form" onSubmit={submit} className="execute-form">
        <div className="grid two">
          <div className="field">
            <label htmlFor="ex-profile">Perfil</label>
            <select id="ex-profile" value={profileId} onChange={(e) => (setProfileId(e.target.value), setValues({}))}>
              <option value="">Sem perfil (padrões do manifesto)</option>
              {profiles.state === "ready"
                ? profiles.value.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                : null}
            </select>
            {profile?.description ? <small>{profile.description}</small> : null}
          </div>
          <div className="field">
            <label htmlFor="ex-ref">Branch ou tag</label>
            <input
              id="ex-ref"
              className="mono"
              list="ex-ref-options"
              autoComplete="off"
              value={ref}
              placeholder={branch(profile?.ref ?? detail.pipeline.parametersRef ?? detail.pipeline.defaultRef)}
              onChange={(e) => setRef(e.target.value)}
            />
            <datalist id="ex-ref-options">
              {refs.map((r) => (
                <option key={r.ref} value={r.name} label={r.kind === "tag" ? "tag" : "branch"} />
              ))}
            </datalist>
          </div>
        </div>

        {specs.length ? (
          <fieldset className="params">
            <legend>
              Parâmetros
              {preview?.parametersFrom === "branch" ? <span className="muted"> · lidos do YAML de {branch(preview.ref)}</span> : null}
            </legend>
            {specs.map((s) => {
              const id = `ex-p-${s.name}`;
              const v = shown(s.name);
              const problem = violationOf(s.name);
              const set = (value: Value) => setValues((cur) => ({ ...cur, [s.name]: value }));
              return (
                <div key={s.name} className={`field${problem ? " invalid" : ""}`}>
                  {s.type === "boolean" ? (
                    <label className="check">
                      <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} />
                      {s.label ?? s.name}
                    </label>
                  ) : (
                    <>
                      <label htmlFor={id}>
                        {s.label ?? s.name}
                        {s.required ? " *" : ""}
                      </label>
                      {s.type === "enum" ? (
                        <select id={id} value={String(v ?? "")} onChange={(e) => set(e.target.value)}>
                          {v === undefined ? <option value="">—</option> : null}
                          {s.options.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type={s.type === "number" ? "number" : "text"}
                          value={v === undefined ? "" : String(v)}
                          onChange={(e) => set(s.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
                        />
                      )}
                    </>
                  )}
                  {problem ? <small className="error-text">{problem}</small> : null}
                </div>
              );
            })}
          </fieldset>
        ) : null}

        <section className={`decision ${outcome?.tone ?? ""}`} aria-live="polite">
          {preview && outcome ? (
            <>
              <div className="decision-head">
                <Icon name={outcome.icon} size={16} />
                <strong>{outcome.label}</strong>
                {preview.ref ? <span className="mono muted">{branch(preview.ref)}</span> : null}
              </div>
              {preview.decision.reasons.length ? (
                <ul>
                  {preview.decision.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : (
                <p>Recursos livres. A execução vai direto para o provedor.</p>
              )}
              {preview.violations.filter((v) => !specs.some((s) => s.name === v.parameter)).map((v) => (
                <p key={v.parameter} className="error-text">
                  {v.parameter}: {v.message}
                </p>
              ))}
              <ProviderCheck check={preview.providerCheck} />
              {preview.systemVersion?.parts.length ? (
                <p className="muted">
                  Versão já conhecida: <SystemVersionText version={preview.systemVersion} /> (o resto vem do provedor durante a execução)
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">{previewError ?? "Calculando o que vai acontecer…"}</p>
          )}
          {preview && previewError ? <p className="error-text">{previewError}</p> : null}
          {duplicateOf ? (
            <p className="warning-text">Você acabou de pedir esta mesma execução. Clique de novo se quer mesmo outra igual.</p>
          ) : null}
        </section>
      </form>
    </Modal>
  );
}

/** O que o próprio provedor disse do pedido (validação sem executar). */
function ProviderCheck({ check }: { check: ExecutionPreview["providerCheck"] }) {
  if (!check) return null;
  if (check.ok === true) {
    return (
      <p className="provider-check ok">
        <Icon name="check" size={13} /> O provedor validou a branch e os parâmetros.
      </p>
    );
  }
  if (check.ok === null) {
    return <p className="provider-check muted">Não deu para validar com o provedor agora ({check.message}). A validação do painel continua valendo.</p>;
  }
  return (
    <div className="provider-check bad">
      <strong>O provedor recusaria este pedido:</strong>
      <ul>
        {check.problems.map((p) => (
          <li key={p} className="mono">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Ações sobre uma execução ----------

const ACTIVE = new Set(["queued", "dispatching", "running", "stale"]);

export function RunActions({ run, canCancel, canRerun }: { run: Run; canCancel: boolean; canRerun: boolean }) {
  const { data, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  if (!run.detailStatus) return null; // execução só de demonstração antiga, sem ações
  const act = async (fn: () => Promise<Run>, ok: (r: Run) => string) => {
    setBusy(true);
    try {
      notify(ok(await fn()));
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível.", "error");
    } finally {
      setBusy(false);
    }
  };
  const active = ACTIVE.has(run.detailStatus);
  return (
    <span className="row-actions">
      {active && canCancel ? (
        <IconButton
          icon="ban"
          danger
          disabled={busy}
          label={run.detailStatus === "queued" ? "Cancelar: tirar da fila" : "Cancelar: pedir o cancelamento ao provedor"}
          onClick={() => act(() => data.cancelExecution(run.id), (r) => (r.status === "cancelled" ? "Cancelada." : "Cancelamento pedido ao provedor."))}
        />
      ) : null}
      {!active && canRerun && run.trigger !== "external" ? (
        <IconButton
          icon="refresh"
          disabled={busy}
          label="Reexecutar com os mesmos parâmetros"
          onClick={() => act(() => data.rerunExecution(run.id), () => "Reexecução pedida.")}
        />
      ) : null}
    </span>
  );
}

// ---------- Versão do sistema em teste ----------

export function SystemVersionText({ version }: { version: SystemVersion }) {
  return (
    <span className="sut-version">
      {version.parts.map((p, i) => (
        <span key={p.key} title={p.label}>
          {i > 0 ? <span className="sep"> · </span> : null}
          <span className="mono">{p.value}</span>
        </span>
      ))}
    </span>
  );
}

/** Última versão testada, para o resumo da pipeline. */
export function SystemVersionCard({ sut, runs }: { sut: SystemUnderTest | undefined; runs: Run[] | null }) {
  const latest = runs?.find((r) => r.systemVersion && r.systemVersion.parts.length);
  const lastOk = runs?.find((r) => r.status === "succeeded" && r.systemVersion && r.systemVersion.parts.length);
  return (
    <section className="card sut-card">
      <div className="card-title">
        <Icon name="layers" size={15} />
        Sistema em teste
        {sut ? <span className="hint">{sut.name}</span> : null}
      </div>
      {!sut ? (
        <p className="muted">
          O manifesto não diz como achar a versão testada. Configure <span className="mono">systemUnderTest</span> no manifesto: de onde vem cada parte (número
          da execução, tag ou parâmetro).
        </p>
      ) : !latest ? (
        <p className="muted">Nenhuma execução trouxe a versão ainda.</p>
      ) : (
        <div className="sut-grid">
          <VersionBlock title="Última versão testada" run={latest} main />
          <div className="sut-divider" aria-hidden="true" />
          {lastOk ? (
            lastOk.id === latest.id ? (
              <div className="sut-block">
                <div className="sut-title">Última aprovada</div>
                <p className="muted sut-same">É a mesma: a última versão testada passou.</p>
              </div>
            ) : (
              <VersionBlock title="Última aprovada" run={lastOk} />
            )
          ) : (
            <div className="sut-block">
              <div className="sut-title">Última aprovada</div>
              <p className="muted sut-same">Nenhuma execução com versão passou ainda.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Uma versão com as partes rotuladas lado a lado e, embaixo, quando e com que resultado. */
function VersionBlock({ title, run, main }: { title: string; run: Run; main?: boolean }) {
  const v = run.systemVersion!;
  return (
    <div className={`sut-block${main ? " sut-primary" : ""}`}>
      <div className="sut-title">{title}</div>
      <div className="sut-parts">
        {v.parts.map((p) => (
          <div key={p.key} className="sut-part">
            <span className="sut-part-label">{p.label}</span>
            <span className="sut-part-value mono">{p.value}</span>
          </div>
        ))}
      </div>
      <div className="sut-meta">
        <StatusBadge status={run.status} />
        <span title={new Date(run.queuedAt).toLocaleString("pt-BR")}>{ago(run.queuedAt)}</span>
      </div>
    </div>
  );
}

/**
 * Como o manifesto lê a versão, numa linha curta. Partes da mesma origem viram uma só menção:
 * "Distribuição e pacote, da tag sistema-…".
 */
export function describeSut(sut: SystemUnderTest): string {
  const from = (p: SystemUnderTest["parts"][number]) =>
    p.source === "runNumber" ? "do número da execução" : p.source === "tag" ? `da tag ${p.tagPrefix ?? ""}…` : `do parâmetro ${p.parameter}`;
  const groups = new Map<string, string[]>();
  for (const p of sut.parts) groups.set(from(p), [...(groups.get(from(p)) ?? []), p.label.toLowerCase()]);
  const joinLabels = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(", ")} e ${l.at(-1)}` : l[0]!);
  const text = [...groups].map(([origin, labels]) => `${joinLabels(labels)}, ${origin}`).join("; ");
  return text[0]!.toUpperCase() + text.slice(1);
}

// ---------- Detalhe de uma execução ----------

const TRANSITION_LABEL: Record<string, string> = {
  queued: "Na fila",
  rejected: "Recusada",
  dispatching: "Enviando ao provedor",
  running: "Em execução",
  cancelling: "Cancelando",
  cancelled: "Cancelada",
  succeeded: "Sucesso",
  failed: "Falha",
  stale: "Sem notícia do provedor",
  unknown: "Indefinida",
};

/** Abre uma execução: linha do tempo, parâmetros usados, versão testada, recursos e logs. */
export function ExecutionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, version } = useApp();
  const result = useAsync(() => data.execution(id), [data, id, version]);
  const [sharing, setSharing] = useState(false);

  return (
    <Modal title="Execução" subtitle={result.state === "ready" ? result.value.pipeline.name : undefined} onClose={onClose} width={860}>
      {result.state === "loading" ? <Loading /> : null}
      {result.state === "error" ? <Failure error={result.error} /> : null}
      {result.state === "ready" ? <ExecutionBody detail={result.value} onShare={() => setSharing(true)} /> : null}
      {sharing ? <ShareDialog target={{ scope: "execution", executionId: id }} onClose={() => setSharing(false)} /> : null}
    </Modal>
  );
}

const FINAL_STATUSES = ["succeeded", "failed", "cancelled", "unknown", "rejected"];

function ExecutionBody({ detail, onShare }: { detail: ExecutionDetail; onShare: () => void }) {
  const { data, session } = useApp();
  const perms = session.organization?.permissions ?? {};
  const run = detail.execution;
  // Nomes legíveis, ordem e padrões dos parâmetros vêm da configuração da pipeline no Nexo.
  const pipeline = useAsync(() => data.pipeline(detail.pipeline.id), [data, detail.pipeline.id]);
  const specs = pipeline.state === "ready" ? pipeline.value.manifest.manifest.parameters : [];
  const finished = FINAL_STATUSES.includes(run.status) && run.detailStatus !== "stale";
  const params = orderedParams(run.parameters, specs);
  const changed = params.filter((p) => p.changed);
  const duration = durationText(run);

  const optional: Array<[string, React.ReactNode]> = [];
  if (run.systemVersion?.parts.length) optional.push(["Versão testada", <SystemVersionText version={run.systemVersion} />]);
  if (run.agentOrPool) optional.push(["Máquina / agente", run.agentOrPool]);
  if (detail.leases.length) optional.push(["Recursos reservados", detail.leases.map((l) => l.resourceName).join(", ")]);
  if (run.runTags.length) optional.push(["Tags no provedor", <span className="mono">{run.runTags.join(", ")}</span>]);

  return (
    <div className="execute-form exec-body">
      <div className="exec-head">
        <span className="mono exec-number">{run.number}</span>
        <StatusBadge status={run.status} />
        {duration ? <span className="muted exec-duration">{duration}</span> : null}
        <span className="grow" />
        <RunActions run={run} canCancel={Boolean(perms.cancel)} canRerun={Boolean(perms.execute)} />
        {perms.share ? <IconButton icon="share" label="Compartilhar este resultado" onClick={onShare} /> : null}
        {detail.pipeline.externalUrl ? (
          <a className="btn small" href={detail.pipeline.externalUrl} target="_blank" rel="noreferrer noopener">
            <Icon name="external" size={13} />
            {providerLabel(detail.pipeline.externalUrl)}
          </a>
        ) : null}
      </div>
      {run.statusReason ? <div className="notice accent">{run.statusReason}</div> : null}

      {params.length ? (
        <div className="exec-summary" aria-label="O que esta execução usou de diferente do padrão">
          {changed.length ? (
            changed.map((p) => (
              <span key={p.name} className="chip changed" title={p.name}>
                {p.label}: <strong>{p.display}</strong>
              </span>
            ))
          ) : (
            <span className="chip">Tudo no padrão da pipeline</span>
          )}
        </div>
      ) : null}

      <div className="props exec-props">
        <div className="prop">
          <div className="prop-label">Branch</div>
          <div className="prop-value mono">{branch(run.ref || null)}</div>
        </div>
        <div className="prop">
          <div className="prop-label">Origem</div>
          <div className="prop-value">
            {run.trigger === "external" ? "Fora do Nexo" : run.trigger === "schedule" ? "Agenda" : "Pelo Nexo"}
            {run.rerunOf ? " · reexecução" : ""}
          </div>
        </div>
        <div className="prop">
          <div className="prop-label">{run.startedAt ? "Início" : "Na fila desde"}</div>
          <div className="prop-value">{shortDateTime(run.startedAt ?? run.queuedAt)}</div>
        </div>
        {run.finishedAt ? (
          <div className="prop">
            <div className="prop-label">Fim</div>
            <div className="prop-value">{shortDateTime(run.finishedAt)}</div>
          </div>
        ) : null}
        {optional.map(([label, value]) => (
          <div className="prop" key={label}>
            <div className="prop-label">{label}</div>
            <div className="prop-value">{value}</div>
          </div>
        ))}
      </div>

      <ResultsSection executionId={run.id} cancelled={run.status === "cancelled"} finished={finished} />

      <section>
        <div className="sut-title">Linha do tempo</div>
        <ol className="timeline compact">
          {detail.transitions.map((t, i) => (
            <li key={i}>
              <span className="timeline-dot" />
              <span>
                <strong>{TRANSITION_LABEL[t.toStatus] ?? t.toStatus}</strong>
                <span className="muted"> · {shortDateTime(t.occurredAt, true)}</span>
                {t.reason ? <span className="timeline-reason">{t.reason}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <div className="sut-title">Parâmetros usados</div>
        {params.length ? (
          <dl className="param-list">
            {params.map((p) => (
              <div key={p.name} className={`param-row${p.changed ? " changed" : ""}`}>
                <dt title={p.name}>{p.label}</dt>
                <dd>
                  <span className={p.isBoolean ? `bool ${p.display === "Sim" ? "yes" : "no"}` : "mono"}>{p.display}</span>
                  {p.changed && p.defaultDisplay !== undefined ? <span className="muted param-default">padrão: {p.defaultDisplay}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="muted">Nenhum (padrões da pipeline).</p>
        )}
      </section>

      <LogsSection executionId={run.id} canRead={detail.pipeline.capabilities.read.logs} autoLoad={finished} failed={run.status === "failed"} />
    </div>
  );
}

interface ParamView {
  name: string;
  label: string;
  display: string;
  isBoolean: boolean;
  changed: boolean;
  defaultDisplay?: string;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === "true";
  return undefined;
}

function show(v: unknown, isBoolean: boolean): string {
  if (isBoolean) return asBool(v) ? "Sim" : "Não";
  return String(v);
}

/** Parâmetros na ordem da pipeline, com nome legível, Sim/Não e o que mudou do padrão. Os que a configuração não conhece vão no fim. */
function orderedParams(values: Record<string, string | number | boolean>, specs: ParameterSpec[]): ParamView[] {
  const known = specs.filter((s) => Object.hasOwn(values, s.name));
  const extra = Object.keys(values).filter((k) => !specs.some((s) => s.name === k)).sort();
  const views = known.map((s): ParamView => {
    const v = values[s.name];
    const isBoolean = s.type === "boolean" || asBool(v) !== undefined;
    const display = show(v, isBoolean);
    const defaultDisplay = s.default === undefined ? undefined : show(s.default, isBoolean);
    return { name: s.name, label: s.label || s.name, display, isBoolean, changed: defaultDisplay !== undefined && defaultDisplay !== display, ...(defaultDisplay !== undefined ? { defaultDisplay } : {}) };
  });
  for (const name of extra) {
    const v = values[name];
    const isBoolean = asBool(v) !== undefined;
    views.push({ name, label: name, display: show(v, isBoolean), isBoolean, changed: false });
  }
  return views;
}

function shortDateTime(iso: string, seconds = false): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: seconds ? "medium" : "short" });
}

/** "2h 06min", "12min", "45s". */
function durationText(run: Run): string | null {
  let ms: number | null = null;
  if (run.startedAt && run.finishedAt) ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  else if (run.durationMinutes !== null) ms = run.durationMinutes * 60_000;
  if (ms === null || !(ms >= 0)) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}min`;
}

function providerLabel(url: string): string {
  if (/visualstudio\.com|dev\.azure\.com/i.test(url)) return "Abrir no Azure";
  if (/github/i.test(url)) return "Abrir no GitHub";
  return "Abrir no provedor";
}

interface LogStage {
  name: string;
  text: string;
  problem: boolean;
}

/** Os logs chegam com "===== etapa =====" no começo de cada trecho: vira uma seção por etapa. */
function splitStages(text: string): LogStage[] {
  const parts = text.split(/^===== (.+) =====$/m);
  const stages: LogStage[] = [];
  if (parts[0]?.trim()) stages.push({ name: "Geral", text: parts[0], problem: false });
  for (let i = 1; i < parts.length; i += 2) stages.push({ name: parts[i]!, text: parts[i + 1] ?? "", problem: false });
  for (const s of stages) s.problem = /##\[error\]|\berror\b|falh|exit code [1-9]|\b[1-9]\d* failed\b|✘/i.test(s.text);
  return stages;
}

function LogsSection({ executionId, canRead, autoLoad, failed }: { executionId: string; canRead: boolean; autoLoad: boolean; failed: boolean }) {
  const { data, notify } = useApp();
  const [logs, setLogs] = useState<{ state: "idle" | "loading" | "ready" | "error"; text: string }>({ state: "idle", text: "" });

  const load = async () => {
    setLogs({ state: "loading", text: "" });
    try {
      setLogs({ state: "ready", text: await data.executionLogs(executionId) });
    } catch (err) {
      setLogs({ state: "error", text: err instanceof Error ? err.message : "Não foi possível ler os logs." });
    }
  };

  // Execução terminada: os logs não mudam mais, então já abrem lidos.
  useEffect(() => {
    if (canRead && autoLoad) void load();
  }, [executionId, canRead, autoLoad]);

  const stages = logs.state === "ready" ? splitStages(logs.text) : [];
  // Abre a etapa com problema; numa falha sem pista, a última (onde a execução parou).
  const firstProblem = stages.findIndex((s) => s.problem);
  const openIndex = firstProblem >= 0 ? firstProblem : failed ? stages.length - 1 : -1;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logs.text);
      notify("Logs copiados.");
    } catch {
      notify("Não deu para copiar automaticamente.", "error");
    }
  };

  return (
    <section>
      <div className="exec-logs-head">
        <span className="sut-title" style={{ margin: 0 }}>
          Logs
        </span>
        <span className="grow" />
        {logs.state === "ready" && logs.text ? (
          <button className="btn small" type="button" onClick={() => void copy()}>
            <Icon name="copy" size={13} />
            Copiar
          </button>
        ) : null}
        {canRead ? (
          <button className="btn small" type="button" onClick={() => void load()} disabled={logs.state === "loading"}>
            {logs.state === "loading" ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
            {logs.state === "idle" ? "Ler do provedor" : "Ler de novo"}
          </button>
        ) : (
          <span className="muted">o provedor desta pipeline não oferece logs</span>
        )}
      </div>
      {logs.state === "loading" ? <p className="muted">Lendo os logs do provedor…</p> : null}
      {logs.state === "ready" && !logs.text ? <p className="muted">O provedor não devolveu logs para esta execução.</p> : null}
      {stages.length ? (
        <div className="log-stages">
          {stages.map((s, i) => (
            <details key={`${s.name}-${i}`} className={`log-stage${s.problem ? " problem" : ""}`} open={i === openIndex}>
              <summary>
                {s.problem ? <Icon name="alert" size={13} /> : <Icon name="check" size={13} />}
                <span>{s.name}</span>
              </summary>
              <pre className="exec-logs">{s.text.trim() || "(vazio)"}</pre>
            </details>
          ))}
        </div>
      ) : null}
      {logs.state === "error" ? <p className="warning-text">{logs.text}</p> : null}
    </section>
  );
}
