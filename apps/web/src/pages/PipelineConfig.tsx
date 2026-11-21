import { useMemo, useState } from "react";
import { useApp } from "../context.tsx";
import type { ExecutionProfile, ParameterSpec, PipelineDetail, PipelineManifest, SystemUnderTest, ValidationRule, VersionPart } from "../data/types.ts";
import { Icon, IconButton } from "../icons.tsx";
import { confirmDialog } from "../dialogs.tsx";
import { Modal } from "../modal.tsx";
import { branch, Failure, Loading, SettingLine, Switch, useAsync } from "../util.tsx";

// Aba "Configuração" da pipeline: edita o manifesto sem JSON (recursos exigidos, regras entre
// parâmetros, versão do sistema em teste, revisão) e os perfis de execução. Cada "Salvar" cria
// uma versão nova do manifesto (nada é sobrescrito, RN-042); se outra pessoa salvou antes, o
// servidor recusa em vez de perder a edição dela.

type Value = string | number | boolean;

/** Converte o texto digitado no tipo do parâmetro (ou mantém texto). */
function coerce(spec: ParameterSpec | undefined, raw: string): Value {
  if (spec?.type === "boolean") return raw.trim().toLowerCase() === "true";
  if (spec?.type === "number" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw.trim();
}

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "regra";

const keyOf = (label: string) => {
  const parts = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const k = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p)).join("");
  return /^[a-z]/.test(k) ? k.slice(0, 40) : `parte${k}`.slice(0, 40);
};

/** Mesma leitura do servidor (extractSystemVersion), para a prévia ao vivo do padrão. */
function previewVersion(sut: SystemUnderTest, sample: { runNumber: string; tags: string[]; parameters: Record<string, string> }) {
  const clean = (v: string) => v.trim().replace(/^['"`]+|['"`]+$/g, "").trim();
  return sut.parts.map((p) => {
    let raw: string | undefined;
    if (p.source === "runNumber") raw = sample.runNumber || undefined;
    else if (p.source === "parameter") raw = p.parameter ? sample.parameters[p.parameter] : undefined;
    else {
      const tag = sample.tags.find((t) => t.startsWith(p.tagPrefix ?? ""));
      raw = tag === undefined ? undefined : tag.slice((p.tagPrefix ?? "").length);
    }
    let value = raw === undefined ? undefined : clean(raw);
    if (value && p.pattern) {
      try {
        const m = new RegExp(p.pattern).exec(value);
        value = m ? clean(m.groups?.value ?? m[0]) : undefined;
      } catch {
        value = undefined;
      }
    }
    return { label: p.label, value };
  });
}

export function PipelineConfig({ detail }: { detail: PipelineDetail }) {
  const { session } = useApp();
  const canEdit = Boolean(session.organization?.permissions.configurePipelines);
  return (
    <div className="admin-stack">
      <ManifestEditor detail={detail} canEdit={canEdit} />
      <ProfilesSection detail={detail} canEdit={canEdit} />
    </div>
  );
}

// ---------- Manifesto ----------

function ManifestEditor({ detail, canEdit }: { detail: PipelineDetail; canEdit: boolean }) {
  const { data, refresh, notify } = useApp();
  const original = detail.manifest.manifest;
  const [m, setM] = useState<PipelineManifest>(() => structuredClone(original));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const resources = useAsync(() => data.resources(), [data]);
  const dirty = JSON.stringify(m) !== JSON.stringify(original);
  const params = m.parameters;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await data.saveManifest(detail.pipeline.id, m, detail.manifest.version, note.trim() || undefined);
      notify(`Configuração salva (manifesto v${detail.manifest.version + 1}).`);
      setNote("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };

  const exclusive = new Set(m.executionResources.filter((r) => r.exclusive).map((r) => r.ref.toLowerCase()));
  const toggleResource = (ref: string, on: boolean) =>
    setM((cur) => ({
      ...cur,
      executionResources: on
        ? [...cur.executionResources.filter((r) => r.ref.toLowerCase() !== ref.toLowerCase()), { ref, exclusive: true }]
        : cur.executionResources.filter((r) => r.ref.toLowerCase() !== ref.toLowerCase()),
    }));
  const catalog = resources.state === "ready" ? resources.value.filter((r) => !r.archivedAt) : [];
  const unknownRefs = m.executionResources.filter((r) => !catalog.some((c) => c.ref.toLowerCase() === r.ref.toLowerCase()));

  return (
    <>
      <section className="card settings-card">
        <div className="card-title">
          <Icon name="layers" size={15} />
          Recursos exclusivos
        </div>
        <p className="settings-intro">Enquanto esta pipeline roda, ninguém mais usa o recurso marcado: os outros pedidos esperam na fila ou são recusados.</p>
        {resources.state === "loading" ? <Loading /> : null}
        {resources.state === "ready" && catalog.length === 0 ? (
          <SettingLine title="Nenhum recurso cadastrado" description="Cadastre em Administração → Recursos (ex.: a máquina de testes).">
            <span />
          </SettingLine>
        ) : null}
        {catalog.map((r) => (
          <SettingLine key={r.id} title={r.name} description={<span className="mono">{r.ref}</span>}>
            <Switch label={`Usar ${r.name}`} disabled={!canEdit} checked={exclusive.has(r.ref.toLowerCase())} onChange={(v) => toggleResource(r.ref, v)} />
          </SettingLine>
        ))}
        {unknownRefs.map((r) => (
          <SettingLine key={r.ref} title={<span className="mono">{r.ref}</span>} description={<span className="warning-text">Não está cadastrado: a execução fica bloqueada até cadastrar ou tirar.</span>}>
            {canEdit ? <IconButton icon="trash" label={`Tirar ${r.ref}`} danger onClick={() => toggleResource(r.ref, false)} /> : <span />}
          </SettingLine>
        ))}
      </section>

      <section className="card settings-card">
        <div className="card-title">
          <Icon name="check" size={15} />
          Regras entre parâmetros
          <span className="grow" />
          {canEdit && params.length >= 1 ? (
            <button className="btn small" type="button" onClick={() => setAddingRule(true)}>
              <Icon name="plus" size={13} />
              Nova regra
            </button>
          ) : null}
        </div>
        <p className="settings-intro">O Nexo bloqueia o pedido que quebrar uma regra e mostra a mensagem. Só valem parâmetros que o manifesto declara.</p>
        {m.validationRules.length === 0 ? (
          <SettingLine title="Nenhuma regra" description="Ex.: a suíte smoke só roda no Chromium.">
            <span />
          </SettingLine>
        ) : null}
        {m.validationRules.map((r) => (
          <div key={r.id} className="setting-line">
            <div>
              <strong>{r.message}</strong>
              <p className="rule-condition">
                <span className="muted">quando</span> <code>{r.when.parameter}</code> = <code>{String(r.when.equals)}</code> <span className="muted">→</span>{" "}
                <code>{r.then.parameter}</code> <span className="muted">precisa ser</span> <code>{r.then.in.map(String).join(" ou ")}</code>
              </p>
            </div>
            <div className="setting-control">
              {canEdit ? (
                <IconButton
                  icon="trash"
                  label="Remover regra"
                  danger
                  onClick={() => setM((cur) => ({ ...cur, validationRules: cur.validationRules.filter((x) => x.id !== r.id) }))}
                />
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <SystemUnderTestSection value={m.systemUnderTest} params={params} canEdit={canEdit} onChange={(sut) => setM((cur) => withSut(cur, sut))} />

      <section className="card settings-card">
        <div className="card-title">
          <Icon name="file" size={15} />
          Revisão
        </div>
        <SettingLine
          title={m.review.status === "approved" ? "Aprovada" : "Rascunho"}
          description={m.review.status === "approved" ? "Uma pessoa revisou esta configuração." : "Ainda em ajuste. Ligue quando alguém tiver revisado a configuração."}
        >
          <Switch
            label="Configuração aprovada"
            disabled={!canEdit}
            checked={m.review.status === "approved"}
            onChange={(v) => setM((cur) => ({ ...cur, review: { ...cur.review, status: v ? "approved" : "draft" } }))}
          />
        </SettingLine>
      </section>

      {/* Só aparece com mudança pendente: flutua no rodapé da área visível, como um aviso de "não salvo". */}
      {canEdit && dirty ? (
        <div className="config-save" role="region" aria-label="Mudanças não salvas">
          <span className="config-save-label">Mudanças não salvas</span>
          <input placeholder="O que mudou? (opcional, fica no histórico)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" type="button" disabled={!dirty || busy} onClick={() => setM(structuredClone(original))}>
            Descartar
          </button>
          <button className="btn primary" type="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Salvar configuração
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="notice warning" role="alert">
          {error}
        </div>
      ) : null}
      {addingRule ? (
        <RuleDialog
          params={params}
          existing={m.validationRules.map((r) => r.id)}
          onClose={() => setAddingRule(false)}
          onAdd={(rule) => {
            setM((cur) => ({ ...cur, validationRules: [...cur.validationRules, rule] }));
            setAddingRule(false);
          }}
        />
      ) : null}
    </>
  );
}

function withSut(m: PipelineManifest, sut: SystemUnderTest | undefined): PipelineManifest {
  const next: PipelineManifest = { ...m };
  if (sut) next.systemUnderTest = sut;
  else delete next.systemUnderTest;
  return next;
}

function ValueInput({ spec, value, onChange, id }: { spec: ParameterSpec | undefined; value: string; onChange: (v: string) => void; id: string }) {
  if (spec?.type === "boolean") {
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">verdadeiro (marcado)</option>
        <option value="false">falso (desmarcado)</option>
      </select>
    );
  }
  if (spec?.type === "enum") {
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {spec.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  return <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function RuleDialog({
  params,
  existing,
  onClose,
  onAdd,
}: {
  params: ParameterSpec[];
  existing: string[];
  onClose: () => void;
  onAdd: (rule: ValidationRule) => void;
}) {
  const [whenParam, setWhenParam] = useState(params[0]?.name ?? "");
  const [whenValue, setWhenValue] = useState("true");
  const [thenParam, setThenParam] = useState(params[1]?.name ?? params[0]?.name ?? "");
  const [thenValues, setThenValues] = useState<string[]>([]);
  const [thenText, setThenText] = useState("");
  const [message, setMessage] = useState("");
  const whenSpec = params.find((p) => p.name === whenParam);
  const thenSpec = params.find((p) => p.name === thenParam);
  const thenOptions = thenSpec?.type === "enum" ? thenSpec.options : thenSpec?.type === "boolean" ? ["true", "false"] : null;
  const values = thenOptions ? thenValues : thenText.split(",").map((v) => v.trim()).filter(Boolean);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let id = slug(message || `${whenParam}-${thenParam}`);
    for (let i = 2; existing.includes(id); i++) id = `${slug(message)}-${i}`;
    onAdd({
      id,
      message: message.trim(),
      when: { parameter: whenParam, equals: coerce(whenSpec, whenValue) },
      then: { parameter: thenParam, in: values.map((v) => coerce(thenSpec, v)) },
    });
  };

  return (
    <Modal
      title="Nova regra entre parâmetros"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn primary" type="submit" form="vrule-form" disabled={!values.length || !message.trim()}>
            Adicionar
          </button>
        </>
      }
    >
      <form id="vrule-form" className="execute-form" onSubmit={submit}>
        <div className="grid two">
          <div className="field">
            <label htmlFor="vr-when">Quando o parâmetro</label>
            <select id="vr-when" value={whenParam} onChange={(e) => (setWhenParam(e.target.value), setWhenValue(params.find((p) => p.name === e.target.value)?.type === "boolean" ? "true" : ""))}>
              {params.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label ?? p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vr-when-v">for igual a</label>
            <ValueInput id="vr-when-v" spec={whenSpec} value={whenValue} onChange={setWhenValue} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="vr-then">então o parâmetro</label>
          <select id="vr-then" value={thenParam} onChange={(e) => (setThenParam(e.target.value), setThenValues([]), setThenText(""))}>
            {params.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label ?? p.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="params">
          <legend>precisa ser um destes valores</legend>
          {thenOptions ? (
            thenOptions.map((o) => (
              <label key={o} className="check">
                <input
                  type="checkbox"
                  checked={thenValues.includes(o)}
                  onChange={(e) => setThenValues((cur) => (e.target.checked ? [...cur, o] : cur.filter((x) => x !== o)))}
                />
                {thenSpec?.type === "boolean" ? (o === "true" ? "verdadeiro (marcado)" : "falso (desmarcado)") : o}
              </label>
            ))
          ) : (
            <input placeholder="valores, separados por vírgula" value={thenText} onChange={(e) => setThenText(e.target.value)} />
          )}
        </fieldset>
        <div className="field">
          <label htmlFor="vr-msg">Mensagem para quem pedir errado</label>
          <input id="vr-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ex.: Smoke só no Chromium" required />
        </div>
      </form>
    </Modal>
  );
}

// ---------- Versão do sistema em teste ----------

function SystemUnderTestSection({
  value,
  params,
  canEdit,
  onChange,
}: {
  value: SystemUnderTest | undefined;
  params: ParameterSpec[];
  canEdit: boolean;
  onChange: (sut: SystemUnderTest | undefined) => void;
}) {
  const [sampleTag, setSampleTag] = useState("");
  const [sampleNumber, setSampleNumber] = useState("");
  const preview = useMemo(
    () => (value ? previewVersion(value, { runNumber: sampleNumber, tags: sampleTag ? [sampleTag] : [], parameters: {} }) : []),
    [value, sampleTag, sampleNumber],
  );
  const setPart = (i: number, patch: Partial<VersionPart>) =>
    value && onChange({ ...value, parts: value.parts.map((p, j) => (j === i ? cleanPart({ ...p, ...patch }) : p)) });

  return (
    <section className="card">
      <div className="card-title">
        <Icon name="layers" size={15} />
        Versão do sistema em teste
        <span className="hint">o que aparece como “versão testada” em cada execução</span>
      </div>
      {!value ? (
        <div className="admin-row" style={{ marginTop: 0 }}>
          <span className="muted grow">Não configurada: as execuções aparecem sem a versão testada.</span>
          {canEdit ? (
            <>
              <button
                className="btn small"
                type="button"
                onClick={() =>
                  onChange({
                    name: "Sistema em teste",
                    parts: [
                      { key: "distribuicao", label: "Distribuição", source: "tag", tagPrefix: "sistema-", pattern: "^(?<value>[^-]+)-" },
                      { key: "pacote", label: "Pacote", source: "tag", tagPrefix: "sistema-", pattern: "^[^-]+-(?<value>.+)$" },
                    ],
                  })
                }
              >
                Usar modelo: distribuição e pacote pela tag
              </button>
              <button className="btn small" type="button" onClick={() => onChange({ name: "Sistema em teste", parts: [{ key: "versao", label: "Versão", source: "runNumber" }] })}>
                Configurar do zero
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid two">
            <div className="field">
              <label htmlFor="sut-name">Nome do sistema</label>
              <input id="sut-name" disabled={!canEdit} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
            </div>
          </div>
          <table className="list sut-parts-table">
            <thead>
              <tr>
                <th>Parte</th>
                <th>De onde vem</th>
                <th>Prefixo / parâmetro</th>
                <th>Padrão (opcional)</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {value.parts.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input
                      disabled={!canEdit}
                      value={p.label}
                      aria-label="Nome da parte"
                      onChange={(e) => setPart(i, { label: e.target.value, key: keyOf(e.target.value) })}
                    />
                  </td>
                  <td>
                    <select disabled={!canEdit} value={p.source} aria-label="Origem" onChange={(e) => setPart(i, { source: e.target.value as VersionPart["source"] })}>
                      <option value="tag">tag da execução</option>
                      <option value="runNumber">número da execução</option>
                      <option value="parameter">parâmetro</option>
                    </select>
                  </td>
                  <td>
                    {p.source === "tag" ? (
                      <input disabled={!canEdit} className="mono" value={p.tagPrefix ?? ""} placeholder="sistema-" aria-label="Prefixo da tag" onChange={(e) => setPart(i, { tagPrefix: e.target.value })} />
                    ) : p.source === "parameter" ? (
                      <select disabled={!canEdit} value={p.parameter ?? ""} aria-label="Parâmetro" onChange={(e) => setPart(i, { parameter: e.target.value })}>
                        <option value="">escolha…</option>
                        {params.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.label ?? s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <input disabled={!canEdit} className="mono" value={p.pattern ?? ""} placeholder="(?<value>...)" aria-label="Padrão" onChange={(e) => setPart(i, { pattern: e.target.value })} />
                  </td>
                  <td className="right">
                    {canEdit ? (
                      <IconButton
                        icon="trash"
                        label="Remover parte"
                        danger
                        onClick={() => onChange(value.parts.length > 1 ? { ...value, parts: value.parts.filter((_, j) => j !== i) } : undefined)}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit ? (
            <button
              className="link-btn"
              type="button"
              onClick={() => onChange({ ...value, parts: [...value.parts, { key: `parte${value.parts.length + 1}`, label: `Parte ${value.parts.length + 1}`, source: "tag", tagPrefix: "" }] })}
            >
              + adicionar parte
            </button>
          ) : null}
          <div className="sut-test">
            <span className="muted">Testar com um exemplo:</span>
            <input className="mono" placeholder="tag, ex.: sistema-master-20250114.18" value={sampleTag} onChange={(e) => setSampleTag(e.target.value)} />
            <input className="mono" placeholder="número, ex.: 20250115.1-master-20250114.18" value={sampleNumber} onChange={(e) => setSampleNumber(e.target.value)} />
            {sampleTag || sampleNumber ? (
              <span>
                {preview.map((p) => (
                  <span key={p.label} className="sut-test-part">
                    {p.label}: {p.value ? <strong className="mono">{p.value}</strong> : <span className="warning-text">não achou</span>}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
          {canEdit ? (
            <button className="link-btn" type="button" onClick={() => onChange(undefined)}>
              Remover a configuração de versão
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Tira campos que não valem para a origem escolhida (o servidor recusa sobra). */
function cleanPart(p: VersionPart): VersionPart {
  const out: VersionPart = { key: p.key, label: p.label, source: p.source };
  if (p.source === "tag") out.tagPrefix = p.tagPrefix || undefined;
  if (p.source === "parameter" && p.parameter) out.parameter = p.parameter;
  if (p.pattern) out.pattern = p.pattern;
  if (out.tagPrefix === undefined) delete out.tagPrefix;
  return out;
}

// ---------- Perfis de execução ----------

function ProfilesSection({ detail, canEdit }: { detail: PipelineDetail; canEdit: boolean }) {
  const { data, version, refresh, notify } = useApp();
  const result = useAsync(() => data.profiles(detail.pipeline.id), [data, detail.pipeline.id, version]);
  const [editing, setEditing] = useState<ExecutionProfile | "new" | null>(null);
  return (
    <section className="card">
      <div className="card-title">
        <Icon name="play" size={15} />
        Perfis de execução
        <span className="hint">combinações prontas de branch e parâmetros para o botão Executar</span>
        <span className="grow" />
        {canEdit ? (
          <button className="btn small" type="button" onClick={() => setEditing("new")}>
            <Icon name="plus" size={13} />
            Novo perfil
          </button>
        ) : null}
      </div>
      {result.state === "loading" ? <Loading /> : null}
      {result.state === "error" ? <Failure error={result.error} /> : null}
      {result.state === "ready" && result.value.length === 0 ? <p className="muted">Nenhum perfil. Ex.: “Noturno completo”, “Só smoke”.</p> : null}
      {result.state === "ready"
        ? result.value.map((p) => (
            <div key={p.id} className="config-rule">
              <span className="grow">
                <strong>{p.name}</strong>
                {p.ref ? <span className="mono muted"> · {branch(p.ref)}</span> : null}
                {Object.keys(p.parameters).length ? (
                  <span className="muted">
                    {" "}
                    · {Object.entries(p.parameters)
                      .map(([k, v]) => `${k} = ${String(v)}`)
                      .join(", ")}
                  </span>
                ) : null}
                {p.description ? <span className="muted"> — {p.description}</span> : null}
              </span>
              {canEdit ? (
                <span className="row-actions">
                  <IconButton icon="pencil" label="Editar perfil" onClick={() => setEditing(p)} />
                  <IconButton
                    icon="trash"
                    label="Apagar perfil"
                    danger
                    onClick={async () => {
                      const ok = await confirmDialog({ title: "Apagar perfil", message: <>O perfil <strong>{p.name}</strong> some do botão Executar. Execuções já feitas com ele não mudam.</>, confirmLabel: "Apagar", danger: true });
                      if (!ok) return;
                      try {
                        await data.archiveProfile(p.id);
                        notify("Perfil apagado.");
                        refresh();
                      } catch (err) {
                        notify(err instanceof Error ? err.message : "Não foi possível.", "error");
                      }
                    }}
                  />
                </span>
              ) : null}
            </div>
          ))
        : null}
      {editing ? <ProfileDialog detail={detail} profile={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function ProfileDialog({ detail, profile, onClose }: { detail: PipelineDetail; profile: ExecutionProfile | undefined; onClose: () => void }) {
  const { data, refresh, notify } = useApp();
  const specs = detail.manifest.manifest.parameters;
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [ref, setRef] = useState(profile?.ref ? branch(profile.ref) : "");
  const [values, setValues] = useState<Record<string, Value>>(profile?.parameters ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = (s: ParameterSpec): Value | undefined => values[s.name] ?? s.default;

  return (
    <Modal
      title={profile ? "Editar perfil" : "Novo perfil de execução"}
      subtitle={detail.pipeline.name}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn primary" type="submit" form="profile-form" disabled={busy || !name.trim()}>
            Salvar
          </button>
        </>
      }
    >
      <form
        id="profile-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await data.saveProfile(
              detail.pipeline.id,
              { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), ...(ref.trim() ? { ref: ref.trim() } : {}), parameters: values },
              profile?.id,
            );
            notify(profile ? "Perfil atualizado." : "Perfil criado. Ele aparece no botão Executar.");
            refresh();
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível salvar.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid two">
          <div className="field">
            <label htmlFor="pf-name">Nome do perfil</label>
            <input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Noturno completo" required />
          </div>
          <div className="field">
            <label htmlFor="pf-ref">Branch (opcional)</label>
            <input id="pf-ref" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={branch(detail.pipeline.parametersRef)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pf-desc">Descrição (opcional)</label>
          <input id="pf-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <fieldset className="params">
          <legend>Parâmetros (só os que você mudar ficam no perfil)</legend>
          {specs.map((s) => {
            const v = shown(s);
            const set = (value: Value) => setValues((cur) => ({ ...cur, [s.name]: value }));
            const changed = values[s.name] !== undefined && values[s.name] !== s.default;
            return (
              <div key={s.name} className={`field${changed ? " changed" : ""}`}>
                {s.type === "boolean" ? (
                  <label className="check">
                    <input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} />
                    {s.label ?? s.name}
                  </label>
                ) : (
                  <>
                    <label htmlFor={`pf-${s.name}`}>{s.label ?? s.name}</label>
                    {s.type === "enum" ? (
                      <select id={`pf-${s.name}`} value={String(v ?? "")} onChange={(e) => set(e.target.value)}>
                        {s.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`pf-${s.name}`}
                        type={s.type === "number" ? "number" : "text"}
                        value={v === undefined ? "" : String(v)}
                        onChange={(e) => set(s.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
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
