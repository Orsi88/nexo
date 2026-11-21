import { cloneElement, useEffect, useMemo, useState } from "react";
import { useApp } from "../context.tsx";
import { ApiError } from "../data/errors.ts";
import type { DiscoveredPipeline, Integration, Project } from "../data/types.ts";
import { Icon } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { useAsync } from "../util.tsx";
import { AssistDialog } from "./Assist.tsx";

// Formulários do incremento 2: nova integração e vincular pipeline. Toda regra (credencial testada,
// nome único, vínculo repetido) é do servidor; aqui só guiamos e mostramos a resposta dele.

/** Campo com rótulo próprio e ajuda ligada por aria-describedby (o rótulo não carrega o texto de ajuda). */
function Field({ id, label, help, children, style }: { id: string; label: string; help?: React.ReactNode; children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>; style?: React.CSSProperties }) {
  const child = cloneElement(children, { id, ...(help ? { "aria-describedby": `${id}-help` } : {}) });
  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{label}</label>
      {child}
      {help ? <small id={`${id}-help`}>{help}</small> : null}
    </div>
  );
}

function errorText(e: unknown): { message: string; missing: string[] } {
  if (e instanceof ApiError) {
    const missing = Array.isArray(e.details.missingPermissions) ? (e.details.missingPermissions as string[]) : [];
    return { message: e.message, missing };
  }
  return { message: e instanceof Error ? e.message : "Algo deu errado.", missing: [] };
}

// ---------- Nova integração ----------

/** O que muda de um provedor para outro no formulário: nome sugerido, endereço e como criar o token. */
const PROVIDERS: Record<string, { label: string; name: string; endpoint: string; placeholder: string; endpointHelp: React.ReactNode; tokenLabel: string; tokenHelp: React.ReactNode }> = {
  "azure-devops": {
    label: "Azure DevOps",
    name: "Azure DevOps",
    endpoint: "https://dev.azure.com/",
    placeholder: "https://dev.azure.com/sua-organizacao",
    endpointHelp: <>O mesmo endereço que aparece no navegador ao abrir o Azure DevOps, até o nome da organização.</>,
    tokenLabel: "Personal Access Token (PAT)",
    tokenHelp: (
      <>
        No Azure DevOps: seu avatar → <strong>Personal access tokens</strong> → <strong>New Token</strong>. Marque <strong>Build (Read &amp; execute)</strong>,{" "}
        <strong>Code (Read)</strong> e <strong>Project and Team (Read)</strong>.
      </>
    ),
  },
  github: {
    label: "GitHub",
    name: "GitHub",
    endpoint: "https://github.com/",
    placeholder: "https://github.com/seu-usuario-ou-organizacao",
    endpointHelp: <>O endereço do seu usuário ou da organização no GitHub (sem o nome do repositório).</>,
    tokenLabel: "Token do GitHub (fine-grained)",
    tokenHelp: (
      <>
        No GitHub: foto → <strong>Settings</strong> → <strong>Developer settings</strong> → <strong>Fine-grained tokens</strong> →{" "}
        <strong>Generate new token</strong>. Escolha só os repositórios que o Nexo vai usar e dê <strong>Actions: Read and write</strong> e{" "}
        <strong>Contents: Read-only</strong> (Metadata entra sozinho).
      </>
    ),
  },
};

export function NewIntegrationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (i: Integration) => void }) {
  const { data, refresh, notify } = useApp();
  const kinds = useAsync(() => data.connectors(), [data]);
  const [kind, setKind] = useState("azure-devops");
  const p = PROVIDERS[kind] ?? PROVIDERS["azure-devops"]!;
  const [name, setName] = useState(p.name);
  const [endpoint, setEndpoint] = useState(p.endpoint);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; missing: string[] } | null>(null);
  const available = kinds.state === "ready" ? kinds.value.filter((k) => PROVIDERS[k]) : ["azure-devops"];

  const changeKind = (next: string) => {
    const n = PROVIDERS[next]!;
    // Troca o nome e o endereço sugeridos só se a pessoa ainda não tinha mudado.
    if (name === p.name) setName(n.name);
    if (endpoint === p.endpoint || !endpoint.trim()) setEndpoint(n.endpoint);
    setKind(next);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { integration } = await data.createIntegration({ kind, name, endpoint, credential });
      setCredential("");
      refresh();
      notify(`Integração "${integration.name}" conectada. O token foi testado e guardado cifrado.`);
      onCreated(integration);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nova integração"
      subtitle="Conecte o Nexo a um provedor de pipelines"
      onClose={onClose}
      footer={
        <>
          <span className="grow hint-text">
            <Icon name="key" size={13} /> O token é testado antes de ser guardado e nunca mais aparece.
          </span>
          <button type="submit" form="new-integration" className="btn primary" disabled={busy || !credential.trim() || !name.trim()}>
            {busy ? "Testando conexão…" : "Testar e salvar"}
          </button>
        </>
      }
    >
      <form id="new-integration" onSubmit={submit}>
        {data.mode === "demo" ? (
          <div className="notice accent">
            <Icon name="sparkles" />
            <div>Demonstração: nada é enviado ao provedor. Um token com menos de 20 caracteres simula a recusa.</div>
          </div>
        ) : null}
        <Field id="f-provedor" label="Provedor">
          <select value={kind} onChange={(e) => changeKind(e.target.value)}>
            {available.map((k) => (
              <option key={k} value={k}>
                {PROVIDERS[k]!.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="f-nome" label="Nome" help={<>É como os manifestos se referem a esta conexão.</>}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </Field>
        <Field id="f-endereco" label="Endereço" help={p.endpointHelp}>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={p.placeholder} required spellCheck={false} />
        </Field>
        <Field id="f-token" label={p.tokenLabel} help={p.tokenHelp}>
          <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} autoComplete="off" spellCheck={false} required />
        </Field>
        {error ? (
          <div className="notice warning" role="alert">
            <Icon name="alert" />
            <div>
              <strong>{error.message}</strong>
              {error.missing.length ? <div style={{ marginTop: 4 }}>Permissões que faltam no token: {error.missing.join(", ")}.</div> : null}
            </div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------- Vincular pipeline (assistente em 3 passos) ----------

type Step = 1 | 2 | 3;

export function LinkPipelineWizard({ defaultProjectId, onClose }: { defaultProjectId?: string; onClose: () => void }) {
  const { data, refresh, notify, open, version } = useApp();
  const base = useAsync(async () => ({ integrations: await data.integrations(), projects: await data.projects() }), [data, version]);
  const [step, setStep] = useState<Step>(1);
  const [integrationId, setIntegrationId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DiscoveredPipeline | null>(null);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingIntegration, setCreatingIntegration] = useState(false);
  // §19.1: os dois caminhos de configuração lado a lado; o manual nunca depende da IA.
  const [mode, setMode] = useState<"manual" | "assist">("manual");
  const [assisting, setAssisting] = useState(false);

  const integrations = useMemo(() => (base.state === "ready" ? base.value.integrations.filter((i) => !i.archivedAt) : []), [base]);
  const projects: Project[] = base.state === "ready" ? base.value.projects.filter((p) => !p.archivedAt) : [];

  useEffect(() => {
    if (!integrationId && integrations[0]) setIntegrationId(integrations[0].id);
  }, [integrations, integrationId]);
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Busca no provedor com atraso, para não chamar a cada tecla.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const discovery = useAsync(
    () => (integrationId ? data.discover(integrationId, { q: debounced }) : Promise.resolve({ items: [] as DiscoveredPipeline[] })),
    [data, integrationId, debounced, version],
  );

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "outro projeto";
  const already = picked && projectId ? picked.linkedProjectIds.includes(projectId) : false;

  const confirm = async () => {
    if (!picked || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await data.importPipeline({ projectId, integrationId, externalId: picked.externalId, ...(ref.trim() ? { ref: ref.trim() } : {}) });
      refresh();
      const n = detail.pipeline.externalParameters.length;
      notify(`"${detail.pipeline.name}" vinculada a ${projectName(projectId)}, com ${n} ${n === 1 ? "parâmetro lido" : "parâmetros lidos"}.`);
      onClose();
      open({ kind: "pipeline", id: detail.pipeline.id });
    } catch (err) {
      setError(errorText(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (assisting && picked) {
    return (
      <AssistDialog
        target={{ projectId, integrationId, externalId: picked.externalId, ...(ref.trim() ? { ref: ref.trim() } : {}), pipelineName: picked.name }}
        onClose={onClose}
        onApplied={(pipelineId) => {
          onClose();
          open({ kind: "pipeline", id: pipelineId });
        }}
      />
    );
  }

  if (creatingIntegration) {
    return (
      <NewIntegrationDialog
        onClose={() => setCreatingIntegration(false)}
        onCreated={(i) => {
          setCreatingIntegration(false);
          setIntegrationId(i.id);
        }}
      />
    );
  }

  const steps = ["Pipeline no provedor", "Projeto e branch", "Confirmar"];

  return (
    <Modal
      title="Vincular pipeline"
      subtitle="Traga uma pipeline do Azure DevOps para um projeto"
      width={680}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          {step > 1 ? (
            <button type="button" className="btn ghost" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
              Voltar
            </button>
          ) : null}
          {step < 3 ? (
            <button
              type="button"
              className="btn primary"
              disabled={(step === 1 && !picked) || (step === 2 && (!projectId || already))}
              onClick={() => setStep((s) => (s + 1) as Step)}
            >
              Continuar
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={mode === "assist" ? () => setAssisting(true) : confirm} disabled={busy}>
              {mode === "assist" ? (
                <>
                  <Icon name="sparkles" size={14} />
                  Continuar com IA
                </>
              ) : busy ? (
                "Lendo a pipeline no provedor…"
              ) : (
                "Vincular"
              )}
            </button>
          )}
        </>
      }
    >
      <ol className="stepper">
        {steps.map((label, i) => (
          <li key={label} data-state={i + 1 < step ? "done" : i + 1 === step ? "current" : "todo"}>
            <span className="step-num">{i + 1 < step ? <Icon name="check" size={12} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {base.state === "loading" ? <div className="skeleton" style={{ height: 180 }} /> : null}

      {base.state === "ready" && integrations.length === 0 ? (
        <div className="empty">
          <p style={{ margin: "0 0 12px" }}>Para descobrir pipelines, primeiro conecte o Azure DevOps.</p>
          <button type="button" className="btn primary" onClick={() => setCreatingIntegration(true)}>
            <Icon name="plus" size={15} />
            Nova integração
          </button>
        </div>
      ) : null}

      {base.state === "ready" && integrations.length > 0 && step === 1 ? (
        <>
          <div className="row-fields">
            <Field id="f-integra-o" label="Integração" style={{ flex: "0 0 220px" }}>
<select
                value={integrationId}
                onChange={(e) => {
                  setIntegrationId(e.target.value);
                  setPicked(null);
                }}
              >
                {integrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
</Field>
            <Field id="f-buscar-no-provedor" label="Buscar no provedor" style={{ flex: 1 }}>
<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nome da pipeline" />
</Field>
          </div>
          <div className="pick-list" role="listbox" aria-label="Pipelines encontradas">
            {discovery.state === "loading" ? <div className="skeleton" style={{ height: 160 }} /> : null}
            {discovery.state === "error" ? <div className="notice warning">{discovery.error.message}</div> : null}
            {discovery.state === "ready" && discovery.value.items.length === 0 ? <div className="empty">Nada encontrado com esse nome.</div> : null}
            {discovery.state === "ready"
              ? discovery.value.items.map((p) => (
                  <button
                    key={p.externalId}
                    type="button"
                    role="option"
                    aria-selected={picked?.externalId === p.externalId}
                    className="pick-row"
                    onClick={() => setPicked(p)}
                  >
                    <Icon name="pipeline" size={16} />
                    <span className="grow">
                      <strong>{p.name}</strong>
                      <span className="secondary">
                        {p.path ?? "—"} · <span className="mono">{p.externalId}</span>
                      </span>
                    </span>
                    {p.linkedProjectIds.length ? (
                      <span className="quiet" title={p.linkedProjectIds.map(projectName).join(", ")}>
                        já em {p.linkedProjectIds.length === 1 ? projectName(p.linkedProjectIds[0]!) : `${p.linkedProjectIds.length} projetos`}
                      </span>
                    ) : null}
                    {picked?.externalId === p.externalId ? <Icon name="check" size={16} /> : null}
                  </button>
                ))
              : null}
          </div>
        </>
      ) : null}

      {step === 2 && picked ? (
        <>
          <Field id="f-projeto" label="Projeto">
<select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
</Field>
          {already ? (
            <div className="notice warning" role="alert">
              <Icon name="alert" />
              <div>Esta pipeline já está vinculada a {projectName(projectId)}. Escolha outro projeto.</div>
            </div>
          ) : null}
          <Field id="f-branch-de-onde-ler-os-par-metros" label="Branch de onde ler os parâmetros" help={<>O YAML pode declarar parâmetros diferentes em cada branch. Use a branch em que a pipeline realmente roda (por exemplo, a
              branch da máquina de testes).</>}>
<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="vazio = branch padrão da pipeline" spellCheck={false} />
</Field>
        </>
      ) : null}

      {step === 3 && picked ? (
        <>
          <div className="props" style={{ marginBottom: 16 }}>
            <div className="prop">
              <div className="prop-label">Pipeline</div>
              <div className="prop-value">{picked.name}</div>
            </div>
            <div className="prop">
              <div className="prop-label">Projeto</div>
              <div className="prop-value">{projectName(projectId)}</div>
            </div>
            <div className="prop">
              <div className="prop-label">Branch dos parâmetros</div>
              <div className="prop-value mono">{ref.trim() || "padrão da pipeline"}</div>
            </div>
          </div>
          <div className="share-label" style={{ marginBottom: 8 }}>
            Como configurar
          </div>
          <div className="choice-cards" role="radiogroup" aria-label="Como configurar" style={{ marginBottom: 14 }}>
            <button type="button" role="radio" aria-checked={mode === "manual"} className="choice-card" onClick={() => setMode("manual")}>
              <Icon name="settings" size={16} />
              <strong>Manual</strong>
              <span>lê os parâmetros e você ajusta na aba Configuração</span>
            </button>
            <button type="button" role="radio" aria-checked={mode === "assist"} className="choice-card" onClick={() => setMode("assist")}>
              <Icon name="sparkles" size={16} />
              <strong>Assistido por IA</strong>
              <span>a IA lê o arquivo e propõe; você revisa antes de aplicar</span>
            </button>
          </div>
          <ul className="checklist">
            <li className="todo">
              <Icon name="refresh" size={14} />
              O painel lê a definição e os parâmetros no provedor agora.
            </li>
            <li className="todo">
              <Icon name="file" size={14} />
              {mode === "assist" ? "A IA propõe rótulos, regras, recursos e relatórios; nada é salvo sem você aplicar." : "Cria a versão 1 do manifesto, em rascunho, para você revisar."}
            </li>
          </ul>
          {error ? (
            <div className="notice warning" role="alert" style={{ marginTop: 14 }}>
              <Icon name="alert" />
              <div>{error}</div>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
