import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.tsx";
import { ApiError } from "../data/errors.ts";
import type { AppliedChange, ChangeMode, DefinitionPreview, DiffLine, ExternalRepository, Integration, PipelineDetail, PipelineTemplate, Project } from "../data/types.ts";
import { Icon, IconButton } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { Failure, Loading, useAsync } from "../util.tsx";

// Incremento 4: o arquivo da pipeline. Ver o YAML, editar, revisar a diferença e gravar por
// commit direto ou por PR (escolha de quem grava; PR não é obrigatório). Criar pipeline nova
// a partir de um modelo, em passos, sem depender de IA.

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Não foi possível.");
const problemsOf = (e: unknown): string[] => (e instanceof ApiError && Array.isArray(e.details.problems) ? (e.details.problems as string[]) : []);

const MODE_TEXT: Record<ChangeMode, { title: string; help: string }> = {
  commit: { title: "Commit direto", help: "Grava agora na branch. A próxima execução já usa o arquivo novo." },
  "pull-request": { title: "Pull request", help: "Cria uma branch com a mudança e abre um PR para alguém revisar. Só vale depois do merge." },
};

export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return <p className="muted">Nada mudou.</p>;
  return (
    <div className="diff" role="table" aria-label="Diferença do arquivo">
      {lines.map((l, i) =>
        l.kind === "skip" ? (
          <div key={i} className="diff-skip" role="row">
            ⋯ {l.text}
          </div>
        ) : (
          <div key={i} className={`diff-line diff-${l.kind}`} role="row">
            <span className="diff-num">{l.oldLine ?? ""}</span>
            <span className="diff-num">{l.newLine ?? ""}</span>
            <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "remove" ? "−" : " "}</span>
            <code>{l.text || " "}</code>
          </div>
        ),
      )}
    </div>
  );
}

function ModePicker({ modes, value, onChange }: { modes: ChangeMode[]; value: ChangeMode; onChange: (m: ChangeMode) => void }) {
  return (
    <div className="mode-picker" role="radiogroup" aria-label="Como gravar">
      {modes.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} className="mode-option" onClick={() => onChange(m)}>
          <span className="mode-radio" />
          <span>
            <strong>{MODE_TEXT[m].title}</strong>
            <small>{MODE_TEXT[m].help}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function ChangeDone({ change }: { change: AppliedChange }) {
  return (
    <div className="notice accent" role="status">
      <Icon name="check" />
      <div>
        {change.mode === "pull-request" ? (
          <>
            <strong>PR aberto.</strong> A mudança vale depois do merge{change.branch ? ` (branch ${change.branch})` : ""}.
          </>
        ) : (
          <>
            <strong>Gravado na branch {change.branch ?? ""}.</strong> A próxima execução já usa o arquivo novo.
          </>
        )}{" "}
        {change.url ? (
          <a href={change.url} target="_blank" rel="noreferrer noopener">
            {change.mode === "pull-request" ? "Abrir o PR" : "Ver o commit"}
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Revisão da mudança: diferença, problemas, como gravar e a descrição. */
function ReviewDialog({
  pipelineId,
  content,
  revision,
  modes,
  onClose,
  onApplied,
}: {
  pipelineId: string;
  content: string;
  revision: string;
  modes: ChangeMode[];
  onClose: () => void;
  onApplied: (change: AppliedChange) => void;
}) {
  const { data, refresh } = useApp();
  const preview = useAsync<DefinitionPreview>(() => data.previewDefinition(pipelineId, content), [data, pipelineId, content]);
  const [mode, setMode] = useState<ChangeMode>(modes.includes("commit") ? "commit" : modes[0]!);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; problems: string[] } | null>(null);
  const blocked = preview.state !== "ready" || !preview.value.diff.changed || preview.value.problems.length > 0;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await data.applyDefinition(pipelineId, { content, expectedRevision: revision, mode, ...(message.trim() ? { message: message.trim() } : {}) });
      refresh();
      onApplied(done.change);
    } catch (e) {
      setError({ text: errorMessage(e), problems: problemsOf(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Revisar a mudança"
      subtitle="Confira o que muda no arquivo antes de gravar"
      width={860}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Voltar a editar
          </button>
          <button type="button" className="btn primary" onClick={() => void apply()} disabled={blocked || busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {mode === "pull-request" ? "Abrir pull request" : "Gravar"}
          </button>
        </>
      }
    >
      {preview.state === "loading" ? <Loading /> : null}
      {preview.state === "error" ? <Failure error={preview.error} /> : null}
      {preview.state === "ready" ? (
        <div className="review">
          <div className="review-stats">
            <span className="diff-added">+{preview.value.diff.added}</span>
            <span className="diff-removed">−{preview.value.diff.removed}</span>
            <span className="muted">linhas</span>
          </div>
          {preview.value.problems.length ? (
            <div className="notice warning">
              <Icon name="alert" />
              <div>
                <strong>O YAML tem problemas e não pode ser gravado:</strong>
                <ul className="plain-list">
                  {preview.value.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <DiffView lines={preview.value.diff.lines} />
          {modes.length ? (
            <>
              <div className="sut-title">Como gravar</div>
              <ModePicker modes={modes} value={mode} onChange={setMode} />
            </>
          ) : null}
          <div className="field">
            <label htmlFor="change-message">Descrição da mudança {mode === "pull-request" ? "(vira o título do PR)" : "(vira a mensagem do commit)"}</label>
            <textarea id="change-message" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ex.: Troca o agente para a máquina de testes" />
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="notice warning" role="alert">
          <Icon name="alert" />
          <div>
            {error.text}
            {error.problems.length ? (
              <ul className="plain-list">
                {error.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** Aba "Arquivo" da pipeline. */
export function PipelineFile({ detail }: { detail: PipelineDetail }) {
  const { data, session, notify } = useApp();
  const id = detail.pipeline.id;
  const [reload, setReload] = useState(0);
  const file = useAsync(() => data.definition(id), [data, id, reload]);
  const [draft, setDraft] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState<AppliedChange | null>(null);
  const canEdit = Boolean(session.organization?.permissions.configurePipelines);

  if (file.state === "loading") return <Loading />;
  if (file.state === "error") return <Failure error={file.error} />;
  const f = file.value;
  const editing = draft !== null;
  const lines = (draft ?? f.content).split("\n").length;

  return (
    <div className="file-view">
      {done ? <ChangeDone change={done} /> : null}
      <div className="file-head">
        <Icon name="file" size={15} />
        <span className="mono">{f.path ?? "arquivo da pipeline"}</span>
        <span className="muted">· revisão {f.revision.slice(0, 10)}</span>
        <span className="grow" />
        {!canEdit ? (
          <span className="muted">só leitura para o seu papel</span>
        ) : !f.modes.length ? (
          <span className="muted">este provedor não permite gravar pela plataforma</span>
        ) : editing ? (
          <>
            <button type="button" className="btn ghost small" onClick={() => setDraft(null)}>
              Descartar
            </button>
            <button type="button" className="btn primary small" onClick={() => setReviewing(true)} disabled={draft === f.content}>
              Revisar mudança
            </button>
          </>
        ) : (
          <IconButton
            icon="pencil"
            label="Editar o arquivo"
            onClick={() => {
              setDone(null);
              setDraft(f.content);
            }}
          />
        )}
      </div>
      {editing ? (
        <textarea
          className="code-editor"
          spellCheck={false}
          value={draft}
          rows={Math.min(40, Math.max(12, lines + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Tab recua com espaços (YAML não aceita tabulação).
            if (e.key !== "Tab") return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${el.value.slice(0, a)}  ${el.value.slice(b)}`;
            setDraft(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }}
          aria-label="Conteúdo do arquivo"
        />
      ) : (
        <pre className="code-view">
          {f.content.split("\n").map((l, i) => (
            <span key={i} className="code-line">
              <span className="code-num">{i + 1}</span>
              {l || " "}
            </span>
          ))}
        </pre>
      )}
      {reviewing && draft !== null ? (
        <ReviewDialog
          pipelineId={id}
          content={draft}
          revision={f.revision}
          modes={f.modes}
          onClose={() => setReviewing(false)}
          onApplied={(change) => {
            // A tela da pipeline recarrega depois de gravar; o aviso flutuante garante que a confirmação aparece.
            notify(change.mode === "pull-request" ? "PR aberto. A mudança vale depois do merge." : `Arquivo gravado na branch ${change.branch ?? ""}.`);
            setReviewing(false);
            setDraft(null);
            setDone(change);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------- Nova pipeline a partir de um modelo ----------

type Step = 1 | 2 | 3 | 4;
const STEPS = ["Modelo", "Onde", "Como roda", "Revisão"];

export function NewPipelineWizard({ defaultProjectId, onClose }: { defaultProjectId?: string; onClose: () => void }) {
  const { data, refresh, notify, open } = useApp();
  const base = useAsync(
    async () => ({
      templates: await data.pipelineTemplates(),
      integrations: (await data.integrations()).filter((i) => !i.archivedAt && (i.kind === "azure-devops" || i.kind === "github")),
      projects: (await data.projects()).filter((p) => !p.archivedAt),
    }),
    [data],
  );
  const [step, setStep] = useState<Step>(1);
  const [template, setTemplate] = useState<PipelineTemplate | null>(null);
  const [integrationId, setIntegrationId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [branch, setBranch] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<ChangeMode>("commit");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; problems: string[] } | null>(null);
  const [created, setCreated] = useState<AppliedChange | null>(null);

  const integrations: Integration[] = base.state === "ready" ? base.value.integrations : [];
  const projects: Project[] = base.state === "ready" ? base.value.projects : [];
  useEffect(() => {
    if (!integrationId && integrations[0]) setIntegrationId(integrations[0].id);
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [integrations, projects, integrationId, projectId]);

  const repos = useAsync<ExternalRepository[]>(() => (integrationId ? data.repositories(integrationId) : Promise.resolve([])), [data, integrationId]);
  const repoList = useMemo(() => (repos.state === "ready" ? repos.value : []), [repos]);
  const repo = repoList.find((r) => r.id === repositoryId);
  useEffect(() => {
    if (repo && !branch) setBranch(repo.defaultBranch ?? "main");
  }, [repo, branch]);

  const pickTemplate = (t: PipelineTemplate) => {
    setTemplate(t);
    setValues(Object.fromEntries(t.fields.map((f) => [f.key, f.default])));
    setStep(2);
  };

  const render = async () => {
    if (!template) return;
    setBusy(true);
    setError(null);
    try {
      const r = await data.renderTemplate({ integrationId, templateId: template.id, name, values });
      setContent(r.content);
      setPath(r.path);
      setStep(4);
    } catch (e) {
      setError({ text: errorMessage(e), problems: problemsOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await data.createPipeline({ projectId, integrationId, repositoryId, branch, path, name, content, mode, ...(message.trim() ? { message: message.trim() } : {}) });
      refresh();
      if (r.pipeline) {
        notify(`"${r.pipeline.pipeline.name}" criada no provedor e vinculada ao projeto.`);
        onClose();
        open({ kind: "pipeline", id: r.pipeline.pipeline.id });
      } else setCreated(r.change);
    } catch (e) {
      setError({ text: errorMessage(e), problems: problemsOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const canNext =
    (step === 2 && integrationId && repositoryId && branch.trim() && projectId && name.trim()) ||
    (step === 3 && template?.fields.every((f) => !f.required || String(values[f.key] ?? "").trim()));

  return (
    <Modal
      title="Nova pipeline"
      subtitle="Monte a pipeline em passos; o arquivo aparece para você revisar antes de criar"
      width={760}
      onClose={onClose}
      footer={
        created ? (
          <>
            <span className="grow" />
            <button type="button" className="btn primary" onClick={onClose}>
              Fechar
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            {step > 1 ? (
              <button type="button" className="btn ghost" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
                Voltar
              </button>
            ) : null}
            {step === 2 ? (
              <button type="button" className="btn primary" disabled={!canNext} onClick={() => setStep(3)}>
                Continuar
              </button>
            ) : null}
            {step === 3 ? (
              <button type="button" className="btn primary" disabled={!canNext || busy} onClick={() => void render()}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                Montar o arquivo
              </button>
            ) : null}
            {step === 4 ? (
              <button type="button" className="btn primary" disabled={busy || !content.trim() || !path.trim()} onClick={() => void create()}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {mode === "pull-request" ? "Abrir pull request" : "Criar pipeline"}
              </button>
            ) : null}
          </>
        )
      }
    >
      <ol className="stepper">
        {STEPS.map((label, i) => (
          <li key={label} data-state={i + 1 < step ? "done" : i + 1 === step ? "current" : "todo"}>
            <span className="step-num">{i + 1 < step ? <Icon name="check" size={12} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {base.state === "loading" ? <Loading /> : null}
      {base.state === "error" ? <Failure error={base.error} /> : null}

      {created ? (
        <ChangeDone change={created} />
      ) : base.state === "ready" && integrations.length === 0 ? (
        <div className="empty">Para criar pipelines, cadastre antes uma integração com o Azure DevOps ou o GitHub (Administração → Integrações).</div>
      ) : base.state === "ready" ? (
        <>
          {step === 1 ? (
            <div className="template-grid">
              {base.value.templates.map((t) => (
                <button key={t.id} type="button" className="template-card" onClick={() => pickTemplate(t)}>
                  <strong>{t.name}</strong>
                  <span>{t.description}</span>
                  <small>Relatório: {t.report}</small>
                </button>
              ))}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="np-name">Nome da pipeline</label>
                <input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Testes E2E do portal" maxLength={120} />
              </div>
              <div className="field">
                <label htmlFor="np-project">Projeto no Nexo</label>
                <select id="np-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="np-integration">Integração</label>
                <select
                  id="np-integration"
                  value={integrationId}
                  onChange={(e) => {
                    setIntegrationId(e.target.value);
                    setRepositoryId("");
                    setBranch("");
                  }}
                >
                  {integrations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.kind === "github" ? "GitHub" : "Azure DevOps"})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="np-repo">Repositório</label>
                <select
                  id="np-repo"
                  value={repositoryId}
                  onChange={(e) => {
                    setRepositoryId(e.target.value);
                    setBranch("");
                  }}
                  disabled={repos.state !== "ready"}
                >
                  <option value="">{repos.state === "loading" ? "Carregando…" : "Escolha o repositório"}</option>
                  {repoList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.scope} / {r.name}
                    </option>
                  ))}
                </select>
                {repos.state === "error" ? <small className="warning-text">{repos.error.message}</small> : null}
              </div>
              <div className="field">
                <label htmlFor="np-branch">Branch</label>
                <input id="np-branch" className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
                <small>Onde o arquivo da pipeline vai ficar.</small>
              </div>
            </div>
          ) : null}

          {step === 3 && template ? (
            <div className="form-grid">
              {template.fields.map((f) =>
                f.kind === "boolean" ? (
                  <label key={f.key} className="check-field">
                    <input type="checkbox" checked={values[f.key] === true} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />
                    <span>
                      <strong>{f.label}</strong>
                      {f.help ? <small>{f.help}</small> : null}
                    </span>
                  </label>
                ) : (
                  <div key={f.key} className="field">
                    <label htmlFor={`np-${f.key}`}>{f.label}</label>
                    {f.kind === "select" ? (
                      <select id={`np-${f.key}`} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`np-${f.key}`}
                        className={f.key.toLowerCase().includes("command") || f.key === "script" || f.key === "schedule" ? "mono" : undefined}
                        value={String(values[f.key] ?? "")}
                        placeholder={f.placeholder}
                        onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                      />
                    )}
                    {f.help ? <small>{f.help}</small> : null}
                  </div>
                ),
              )}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="review">
              <div className="field">
                <label htmlFor="np-path">Caminho do arquivo no repositório</label>
                <input id="np-path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="np-content">Arquivo (pode ajustar antes de criar)</label>
                <textarea id="np-content" className="code-editor" spellCheck={false} rows={18} value={content} onChange={(e) => setContent(e.target.value)} />
              </div>
              <div className="sut-title">Como gravar</div>
              <ModePicker modes={["commit", "pull-request"]} value={mode} onChange={setMode} />
              {mode === "pull-request" ? (
                <p className="muted">Pelo PR, a pipeline passa a existir depois do merge. Aí é só vinculá-la ao projeto em Vincular pipeline.</p>
              ) : null}
              <div className="field">
                <label htmlFor="np-message">Descrição (opcional)</label>
                <input id="np-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Cria a pipeline ${name}`} />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="notice warning" role="alert">
              <Icon name="alert" />
              <div>
                {error.text}
                {error.problems.length ? (
                  <ul className="plain-list">
                    {error.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
