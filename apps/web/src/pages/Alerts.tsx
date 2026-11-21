import { useEffect, useState } from "react";
import { useApp } from "../context.tsx";
import type { Alert, LinkedPipeline, NotificationRule, RuleCondition, RuleInput, RuleStatus, Severity } from "../data/types.ts";
import { Icon, IconButton } from "../icons.tsx";
import { confirmDialog, promptDialog } from "../dialogs.tsx";
import { Modal } from "../modal.tsx";
import { ago, dateTime, Failure, Loading, useAsync } from "../util.tsx";

// Avisos gerados por regras de evento e o editor de regras (RF-126–130). Exemplo de uso: depois de
// uma suíte smoke que passou, avisar que a versão pode seguir para homologação.

const SEVERITY: Record<Severity, { label: string; badge: string; icon: "alert" | "clock" | "check" }> = {
  critical: { label: "Crítico", badge: "critical", icon: "alert" },
  warning: { label: "Atenção", badge: "warning", icon: "alert" },
  info: { label: "Informativo", badge: "accent", icon: "check" },
};

const STATUS_LABEL: Record<RuleStatus, string> = {
  succeeded: "Sucesso",
  failed: "Falha",
  cancelled: "Cancelada",
  unknown: "Indefinida",
};

// ---------- Página de avisos ----------

export function Alerts() {
  const { data, version, refresh, notify, session, setPanel } = useApp();
  const result = useAsync(() => data.alerts(false), [data, version]);
  useEffect(() => setPanel(null), [setPanel]);
  const canResolve = Boolean(session.organization?.permissions.execute);
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  const open = result.value.filter((a) => !a.resolvedAt);
  const done = result.value.filter((a) => a.resolvedAt);

  const resolve = async (a: Alert) => {
    const note = await promptDialog({
      title: "Marcar como resolvido",
      message: <>O aviso <strong>{a.title}</strong> sai da lista de abertos e fica no histórico.</>,
      label: "O que foi feito? (opcional)",
      placeholder: "Ex.: versão liberada para homologação",
      confirmLabel: "Marcar como resolvido",
      optional: true,
      multiline: true,
    });
    if (note === null) return;
    try {
      await data.resolveAlert(a.id, note || undefined);
      notify("Aviso marcado como resolvido.");
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível resolver.", "error");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="icon-tile">
          <Icon name="bell" size={20} />
        </div>
        <div className="grow">
          <h1>Avisos</h1>
          <div className="sub">Gerados pelas regras de evento das pipelines. Ficam abertos até alguém marcar como resolvido.</div>
        </div>
      </div>
      {open.length === 0 ? (
        <div className="empty">Nenhum aviso aberto.</div>
      ) : (
        <div className="alert-list">
          {open.map((a) => (
            <AlertCard key={a.id} alert={a} onResolve={canResolve ? () => void resolve(a) : undefined} />
          ))}
        </div>
      )}
      {done.length ? (
        <section className="section">
          <h2>Resolvidos</h2>
          <div className="alert-list">
            {done.slice(0, 20).map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function AlertCard({ alert, onResolve }: { alert: Alert; onResolve?: (() => void) | undefined }) {
  const { open } = useApp();
  const s = SEVERITY[alert.severity];
  return (
    <article className={`card alert-card ${alert.resolvedAt ? "resolved" : s.badge}`}>
      <div className="alert-head">
        <span className={`badge ${alert.resolvedAt ? "neutral" : s.badge}`}>
          <Icon name={alert.resolvedAt ? "check" : s.icon} size={12} />
          {alert.resolvedAt ? "Resolvido" : s.label}
        </span>
        <strong className="grow">{alert.title}</strong>
        <span className="muted" title={dateTime(alert.createdAt)}>
          {ago(alert.createdAt)}
        </span>
      </div>
      <p className="alert-message">{alert.message}</p>
      <div className="alert-foot">
        <button className="link-btn" type="button" onClick={() => open({ kind: "pipeline", id: alert.pipelineId })}>
          {alert.pipelineName}
        </button>
        {alert.resolvedAt ? (
          <span className="muted">
            resolvido {ago(alert.resolvedAt)}
            {alert.resolutionNote ? ` · ${alert.resolutionNote}` : ""}
          </span>
        ) : onResolve ? (
          <IconButton icon="check" label="Marcar como resolvido" onClick={onResolve} />
        ) : null}
      </div>
    </article>
  );
}

// ---------- Regras de evento (gatilhos de aviso) ----------

/** Aba "Avisos" de uma pipeline: só as regras dela e as que valem para todas. */
export function PipelineRules({ pipelineId }: { pipelineId: string }) {
  return <RulesManager pipelineId={pipelineId} />;
}

/**
 * Lista e edita regras. Com `pipelineId`, recortada nessa pipeline; sem, a organização inteira
 * (Administração → Avisos e gatilhos), com filtro por pipeline.
 */
export function RulesManager({ pipelineId }: { pipelineId?: string }) {
  const { data, version, refresh, notify, session } = useApp();
  const result = useAsync(async () => ({ rules: await data.rules(pipelineId), pipelines: await data.adminPipelines() }), [data, pipelineId, version]);
  const [editing, setEditing] = useState<NotificationRule | "new" | null>(null);
  const [filter, setFilter] = useState<string>("");
  const canEdit = Boolean(session.organization?.permissions.configurePipelines);
  if (result.state === "loading") return <Loading />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { pipelines } = result.value;
  const nameOf = (id: string | null) => (id === null ? "Todas as pipelines" : (pipelines.find((p) => p.id === id)?.name ?? "pipeline removida"));
  const rules = result.value.rules.filter((r) => !filter || (filter === "*" ? r.pipelineId === null : r.pipelineId === filter));

  const toggleEnabled = async (r: NotificationRule) => {
    try {
      await data.saveRule(
        { name: r.name, enabled: !r.enabled, pipelineId: r.pipelineId, onStatus: r.onStatus, conditions: r.conditions, severity: r.severity, title: r.title, message: r.message },
        r.id,
      );
      notify(r.enabled ? "Regra desligada." : "Regra ligada.");
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível.", "error");
    }
  };

  const archive = async (r: NotificationRule) => {
    const ok = await confirmDialog({
      title: "Arquivar regra",
      message: <>A regra <strong>{r.name}</strong> para de gerar avisos. Os avisos já gerados continuam no histórico.</>,
      confirmLabel: "Arquivar",
      icon: "archive",
    });
    if (!ok) return;
    try {
      await data.archiveRule(r.id);
      notify("Regra arquivada.");
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível arquivar.", "error");
    }
  };

  return (
    <>
      <div className="rules-head">
        {!pipelineId ? (
          <select className="inline-select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar por pipeline">
            <option value="">Todas as regras</option>
            <option value="*">Só as que valem para todas as pipelines</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <p className="muted grow">
          Quando uma execução terminar com o resultado e os parâmetros escolhidos, o painel cria um aviso. Ex.: depois da suíte smoke, avisar que a versão
          pode seguir para homologação.
        </p>
        {canEdit ? (
          <button className="btn primary" type="button" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Nova regra
          </button>
        ) : null}
      </div>
      {rules.length === 0 ? (
        <div className="empty">{pipelineId ? "Nenhuma regra para esta pipeline." : "Nenhuma regra ainda."}</div>
      ) : (
        <div className="rule-list">
          {rules.map((r) => (
            <article key={r.id} className={`card rule-card${r.enabled ? "" : " disabled"}`}>
              <div className="alert-head">
                <span className={`badge ${SEVERITY[r.severity].badge}`}>{SEVERITY[r.severity].label}</span>
                <strong className="grow">{r.name}</strong>
                {!r.enabled ? <span className="muted">desligada</span> : null}
                {!pipelineId || r.pipelineId === null ? <span className="rule-scope">{nameOf(r.pipelineId)}</span> : null}
              </div>
              <p className="rule-when">
                <span className="muted">Quando terminar com </span>
                {r.onStatus.map((s) => STATUS_LABEL[s]).join(" ou ")}
                {r.conditions.map((c) => (
                  <span key={c.parameter}>
                    <span className="muted"> e </span>
                    <span className="mono">{c.parameter}</span>
                    <span className="muted"> for </span>
                    {c.in.map(String).join(" ou ")}
                  </span>
                ))}
              </p>
              <p className="rule-then">
                <span className="muted">Aviso: </span>
                <strong>{r.title}</strong> — {r.message}
              </p>
              {r.channels.includes("email") ? (
                <p className="rule-then">
                  <Icon name="mail" size={13} /> <span className="muted">Também por e-mail para </span>
                  {r.recipients.join(", ")}
                </p>
              ) : null}
              {canEdit ? (
                <div className="alert-foot rule-actions">
                  <IconButton icon="power" label={r.enabled ? "Desligar regra" : "Ligar regra"} onClick={() => void toggleEnabled(r)} />
                  <IconButton icon="pencil" label="Editar regra" onClick={() => setEditing(r)} />
                  <IconButton icon="archive" label="Arquivar regra" onClick={() => void archive(r)} />
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {editing ? (
        <RuleDialog
          {...(pipelineId ? { scopedPipelineId: pipelineId } : {})}
          pipelines={pipelines}
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function RuleDialog({
  scopedPipelineId,
  pipelines,
  rule,
  onClose,
  onSaved,
}: {
  scopedPipelineId?: string;
  pipelines: LinkedPipeline[];
  rule: NotificationRule | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, notify } = useApp();
  // null = vale para todas as pipelines da organização.
  const [pipelineId, setPipelineId] = useState<string | null>(rule ? rule.pipelineId : (scopedPipelineId ?? pipelines[0]?.id ?? null));
  // Parâmetros sugeridos nas condições: os da pipeline escolhida (para "todas", digita-se o nome).
  const specs = pipelines.find((p) => p.id === pipelineId)?.externalParameters ?? [];
  const [name, setName] = useState(rule?.name ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [onStatus, setOnStatus] = useState<RuleStatus[]>(rule?.onStatus ?? ["succeeded"]);
  const [conditions, setConditions] = useState<RuleCondition[]>(rule?.conditions ?? []);
  const [severity, setSeverity] = useState<Severity>(rule?.severity ?? "warning");
  const [title, setTitle] = useState(rule?.title ?? "");
  const [message, setMessage] = useState(rule?.message ?? "");
  const [byEmail, setByEmail] = useState(rule?.channels.includes("email") ?? false);
  const [recipients, setRecipients] = useState((rule?.recipients ?? []).join(", "));
  const emailStatus = useAsync(() => data.emailStatus(), [data]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const optionsOf = (name: string): string[] | null => {
    const s = specs.find((x) => x.name === name);
    if (!s) return null;
    if (s.type === "enum") return s.options;
    if (s.type === "boolean") return ["true", "false"];
    return null;
  };
  const toValue = (name: string, raw: string): string | number | boolean => {
    const s = specs.find((x) => x.name === name);
    if (s?.type === "boolean") return raw === "true";
    if (s?.type === "number" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
    return raw;
  };
  const setCondition = (i: number, c: RuleCondition) => setConditions((cur) => cur.map((x, j) => (j === i ? c : x)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: RuleInput = {
      name,
      enabled,
      pipelineId,
      onStatus,
      conditions: conditions.filter((c) => c.parameter && c.in.length),
      severity,
      title,
      message,
      channels: byEmail ? ["panel", "email"] : ["panel"],
      recipients: byEmail
        ? recipients
            .split(/[,;\s]+/)
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
    };
    try {
      await data.saveRule(input, rule?.id);
      notify(rule ? "Regra atualizada." : "Regra criada. Vale para as próximas execuções que terminarem.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={rule ? "Editar regra" : "Nova regra de aviso"}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn primary" type="submit" form="rule-form" disabled={busy || !onStatus.length}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Salvar
          </button>
        </>
      }
    >
      <form id="rule-form" className="execute-form" onSubmit={submit}>
        <div className="grid two">
          <div className="field">
            <label htmlFor="rule-name">Nome da regra</label>
            <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Liberar versão depois do smoke" required />
          </div>
          <div className="field">
            <label htmlFor="rule-pipeline">Pipeline</label>
            <select id="rule-pipeline" value={pipelineId ?? "*"} onChange={(e) => setPipelineId(e.target.value === "*" ? null : e.target.value)}>
              <option value="*">Todas as pipelines</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="params rule-when-box">
          <legend>Quando a execução terminar com</legend>
          {(Object.keys(STATUS_LABEL) as RuleStatus[]).map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={onStatus.includes(s)}
                onChange={(e) => setOnStatus((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </fieldset>

        <fieldset className="params rule-conditions">
          <legend>E os parâmetros usados forem</legend>
          {conditions.length === 0 ? <p className="muted">Sem condição: vale para qualquer execução com o resultado acima.</p> : null}
          {conditions.map((c, i) => {
            const opts = optionsOf(c.parameter);
            return (
              <div key={i} className="condition-row">
                <span className="condition-param">
                  <input
                    list={`rule-params-${i}`}
                    value={c.parameter}
                    placeholder="Parâmetro"
                    aria-label="Parâmetro"
                    onChange={(e) => setCondition(i, { parameter: e.target.value.trim(), in: [] })}
                  />
                  <datalist id={`rule-params-${i}`}>
                    {specs.map((s) => (
                      <option key={s.name} value={s.name} label={s.label ?? s.name} />
                    ))}
                  </datalist>
                  {c.parameter && !specs.some((s) => s.name === c.parameter) ? (
                    <small className="muted">não está na branch padrão (existe em outra branch?)</small>
                  ) : null}
                </span>
                {opts ? (
                  <span className="condition-values">
                    {opts.map((o) => (
                      <label key={o} className="check">
                        <input
                          type="checkbox"
                          checked={c.in.map(String).includes(o)}
                          onChange={(e) =>
                            setCondition(i, {
                              ...c,
                              in: e.target.checked ? [...c.in, toValue(c.parameter, o)] : c.in.filter((v) => String(v) !== o),
                            })
                          }
                        />
                        {o}
                      </label>
                    ))}
                  </span>
                ) : (
                  <input
                    aria-label="Valores, separados por vírgula"
                    placeholder="valores, separados por vírgula"
                    value={c.in.map(String).join(", ")}
                    onChange={(e) =>
                      setCondition(i, {
                        ...c,
                        in: e.target.value
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean)
                          .map((v) => toValue(c.parameter, v)),
                      })
                    }
                  />
                )}
                <IconButton icon="trash" label="Remover condição" danger onClick={() => setConditions((cur) => cur.filter((_, j) => j !== i))} />
              </div>
            );
          })}
          <button className="link-btn" type="button" onClick={() => setConditions((cur) => [...cur, { parameter: "", in: [] }])}>
            + adicionar condição
          </button>
        </fieldset>

        <div className="grid two">
          <div className="field">
            <label htmlFor="rule-title">Título do aviso</label>
            <input id="rule-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Liberar versão para homologação" required />
          </div>
          <div className="field">
            <label htmlFor="rule-sev">Gravidade</label>
            <select id="rule-sev" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              <option value="info">Informativo</option>
              <option value="warning">Atenção</option>
              <option value="critical">Crítico</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rule-msg">Mensagem</label>
          <textarea id="rule-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} required />
          <small>
            Pode usar <span className="mono">{"{pipeline}"}</span>, <span className="mono">{"{versao}"}</span>, <span className="mono">{"{branch}"}</span>,{" "}
            <span className="mono">{"{resultado}"}</span>, <span className="mono">{"{execucao}"}</span> e <span className="mono">{"{param:nome}"}</span>.
          </small>
        </div>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Regra ligada
        </label>
        <fieldset className="params">
          <legend>Onde avisar</legend>
          <label className="check">
            <input type="checkbox" checked disabled />
            No painel (sempre)
          </label>
          <label className="check">
            <input type="checkbox" checked={byEmail} onChange={(e) => setByEmail(e.target.checked)} />
            Também por e-mail, com o resumo da execução e o link para o painel
          </label>
          {byEmail ? (
            <div className="field">
              <label htmlFor="rule-recipients">Destinatários</label>
              <input
                id="rule-recipients"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="equipe@empresa.com, lider@empresa.com"
                required
              />
              <small>Até 20 e-mails, separados por vírgula.</small>
            </div>
          ) : null}
          {byEmail && emailStatus.state === "ready" && !emailStatus.value.enabled ? (
            <p className="warning-text small-print">
              O envio de e-mails não está configurado nesta instalação: a regra fica salva, mas o aviso sai só no painel até configurarem o SMTP.
            </p>
          ) : null}
        </fieldset>
        {error ? (
          <div className="notice warning" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
