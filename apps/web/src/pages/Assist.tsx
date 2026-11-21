import { useEffect, useState } from "react";
import { useApp } from "../context.tsx";
import type { AiProvider, AiProviderInput, AssistSession, McpServer, PipelineManifest } from "../data/types.ts";
import { Icon, IconButton } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { confirmDialog } from "../dialogs.tsx";
import { dateTime, Failure, Loading, PageSkeleton, SettingLine, Switch, useAsync } from "../util.tsx";

// Incremento 8 (§19.3–19.7): IA da própria organização + servidores MCP, e a sessão que propõe a
// configuração de uma pipeline. Tudo opcional: sem IA, o caminho manual faz tudo (RN-038).

const KIND_LABEL: Record<AiProvider["kind"], string> = { anthropic: "Anthropic (Claude)", "openai-compatible": "Compatível com OpenAI" };

// ---------- Administração: provedores e servidores MCP ----------

export function AiTab() {
  const { data, version, refresh, notify, session } = useApp();
  const canManage = Boolean(session.organization?.permissions.manageIntegrations);
  const result = useAsync(async () => ({ providers: await data.aiProviders(), servers: await data.mcpServers(), sessions: await data.assistSessions() }), [data, version]);
  const [adding, setAdding] = useState<"provider" | "mcp" | null>(null);
  const [busy, setBusy] = useState(false);
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { providers, servers, sessions } = result.value;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      notify(ok);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <p className="muted" style={{ margin: 0 }}>
        Opcional. Com uma IA configurada, o Nexo pode propor a configuração de uma pipeline lendo o arquivo dela. A IA só lê: quem revisa e aplica é uma pessoa,
        e o Nexo valida antes de salvar. Sem IA, tudo funciona pelo caminho manual.
      </p>

      <section className="card settings-card">
        <div className="card-title">
          <Icon name="bot" size={15} />
          Provedores de IA
          {canManage ? (
            <button className="btn small" type="button" onClick={() => setAdding("provider")}>
              <Icon name="plus" size={13} />
              Novo provedor
            </button>
          ) : null}
        </div>
        <p className="settings-intro">A chave fica cifrada no cofre da organização e nunca aparece em tela, log ou prompt.</p>
        {providers.length === 0 ? (
          <SettingLine title="Nenhum provedor" description="Cadastre a Anthropic (Claude) ou qualquer API compatível com OpenAI, inclusive um modelo local (Ollama, LM Studio).">
            <span />
          </SettingLine>
        ) : null}
        {providers.map((p) => (
          <SettingLine
            key={p.id}
            title={
              <>
                {p.name} <span className="muted small-print">· {KIND_LABEL[p.kind]}</span>
              </>
            }
            description={
              <>
                <span className="mono">{p.model}</span>
                {p.effort ? ` · esforço ${p.effort}` : ""}
                {p.endpoint ? <> · <span className="mono">{p.endpoint}</span></> : ""}
                {p.lastCheck ? <span className={p.lastCheck.ok ? "" : "warning-text"}> · {p.lastCheck.message}</span> : null}
              </>
            }
          >
            {canManage ? (
              <>
                <IconButton icon="refresh" label="Testar a conexão de novo" disabled={busy} onClick={() => void act(() => data.testAiProvider(p.id), "Teste feito.")} />
                <IconButton
                  icon="archive"
                  label="Arquivar provedor"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirmDialog({ title: "Arquivar provedor de IA", message: <>A IA <strong>{p.name}</strong> deixa de aparecer nas sessões. As configurações já aplicadas continuam valendo.</>, confirmLabel: "Arquivar", icon: "archive" });
                    if (ok) await act(() => data.archiveAiProvider(p.id), "Provedor arquivado.");
                  }}
                />
              </>
            ) : null}
          </SettingLine>
        ))}
      </section>

      <section className="card settings-card">
        <div className="card-title">
          <Icon name="plug" size={15} />
          Servidores MCP
          {canManage ? (
            <button className="btn small" type="button" onClick={() => setAdding("mcp")}>
              <Icon name="plus" size={13} />
              Novo servidor
            </button>
          ) : null}
        </div>
        <p className="settings-intro">
          Ferramentas extras que a IA pode consultar (documentação, catálogos). Cada ferramenta é de leitura ou de mutação; só as de leitura liberadas aqui
          chegam à IA. Mutação nunca é liberada.
        </p>
        {servers.length === 0 ? (
          <SettingLine title="Nenhum servidor" description="Conecte um servidor MCP pelo endereço HTTP dele.">
            <span />
          </SettingLine>
        ) : null}
        {servers.map((s) => (
          <McpServerBlock key={s.id} server={s} canManage={canManage} busy={busy} act={act} />
        ))}
      </section>

      {sessions.length ? (
        <section className="card flush">
          <div className="card-title padded">
            <Icon name="history" size={15} />
            Sessões assistidas
          </div>
          <table className="list">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Pipeline</th>
                <th>IA</th>
                <th>Situação</th>
                <th className="right">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="nowrap">{dateTime(s.createdAt)}</td>
                  <td>{s.pipelineName}</td>
                  <td className="nowrap">{s.providerName}</td>
                  <td>
                    <SessionBadge status={s.status} />
                  </td>
                  <td className="right num">{s.usage ? (s.usage.inputTokens + s.usage.outputTokens).toLocaleString("pt-BR") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {adding === "provider" ? <ProviderDialog onClose={() => setAdding(null)} /> : null}
      {adding === "mcp" ? <McpDialog onClose={() => setAdding(null)} /> : null}
    </div>
  );
}

function McpServerBlock({ server, canManage, busy, act }: { server: McpServer; canManage: boolean; busy: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { data } = useApp();
  const setTool = (name: string, patch: { kind?: "read" | "mutate"; authorized?: boolean }) => {
    const tools = server.tools.map((t) => {
      if (t.name !== name) return { name: t.name, kind: t.kind, authorized: t.authorized };
      const kind = patch.kind ?? t.kind;
      return { name: t.name, kind, authorized: kind === "read" ? (patch.authorized ?? t.authorized) : false };
    });
    void act(() => data.setMcpTools(server.id, tools), "Ferramentas atualizadas.");
  };
  return (
    <div className="mcp-block">
      <SettingLine
        title={server.name}
        description={
          <>
            <span className="mono">{server.url}</span>
            {server.serverInfo?.name ? ` · ${server.serverInfo.name}${server.serverInfo.version ? ` ${server.serverInfo.version}` : ""}` : ""}
            {server.lastCheck && !server.lastCheck.ok ? <span className="warning-text"> · {server.lastCheck.message}</span> : null}
          </>
        }
      >
        {canManage ? (
          <>
            <IconButton icon="refresh" label="Ler as ferramentas de novo" disabled={busy} onClick={() => void act(() => data.refreshMcpServer(server.id), "Ferramentas lidas de novo.")} />
            <IconButton
              icon="archive"
              label="Arquivar servidor"
              disabled={busy}
              onClick={async () => {
                const ok = await confirmDialog({ title: "Arquivar servidor MCP", message: <>As ferramentas de <strong>{server.name}</strong> deixam de estar disponíveis para a IA.</>, confirmLabel: "Arquivar", icon: "archive" });
                if (ok) await act(() => data.archiveMcpServer(server.id), "Servidor arquivado.");
              }}
            />
          </>
        ) : null}
      </SettingLine>
      <div className="mcp-tools">
        {server.tools.map((t) => (
          <div key={t.name} className="mcp-tool">
            <div className="grow">
              <span className="mono">{t.name}</span>
              {t.description ? <span className="muted small-print"> {t.description}</span> : null}
            </div>
            <select className="inline-select" aria-label={`Tipo de ${t.name}`} value={t.kind} disabled={!canManage || busy} onChange={(e) => setTool(t.name, { kind: e.target.value as "read" | "mutate" })}>
              <option value="read">leitura</option>
              <option value="mutate">mutação</option>
            </select>
            <Switch
              label={t.kind === "read" ? `Liberar ${t.name} para a IA` : "Mutação nunca é liberada para a IA"}
              checked={t.authorized}
              disabled={!canManage || busy || t.kind !== "read"}
              onChange={(v) => setTool(t.name, { authorized: v })}
            />
          </div>
        ))}
        {!server.tools.length ? <p className="muted small-print">O servidor não expõe ferramentas.</p> : null}
      </div>
    </div>
  );
}

function ProviderDialog({ onClose }: { onClose: () => void }) {
  const { data, refresh, notify } = useApp();
  const [kind, setKind] = useState<AiProvider["kind"]>("anthropic");
  const [name, setName] = useState("Claude");
  const [model, setModel] = useState("claude-opus-5-5");
  const [effort, setEffort] = useState<AiProvider["effort"]>("high");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickKind = (k: AiProvider["kind"]) => {
    setKind(k);
    if (k === "anthropic") {
      setName("Claude");
      setModel("claude-opus-5-5");
      setEffort("high");
      setEndpoint("");
    } else {
      setName("");
      setModel("");
      setEffort(null);
      setEndpoint("https://api.openai.com/v1");
    }
  };
  return (
    <Modal
      title="Novo provedor de IA"
      onClose={onClose}
      width={560}
      footer={
        <button className="btn primary" type="submit" form="ai-form" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          Testar e salvar
        </button>
      }
    >
      <form
        id="ai-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const input: AiProviderInput = { name: name.trim(), kind, model: model.trim(), ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}), ...(apiKey ? { apiKey } : {}), effort };
          try {
            await data.createAiProvider(input);
            notify("Provedor testado e salvo.");
            refresh();
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível salvar.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="choice-cards" role="radiogroup" aria-label="Tipo de provedor">
          <button type="button" role="radio" aria-checked={kind === "anthropic"} className="choice-card" onClick={() => pickKind("anthropic")}>
            <Icon name="bot" size={16} />
            <strong>Anthropic</strong>
            <span>Claude, pela API oficial</span>
          </button>
          <button type="button" role="radio" aria-checked={kind === "openai-compatible"} className="choice-card" onClick={() => pickKind("openai-compatible")}>
            <Icon name="plug" size={16} />
            <strong>Compatível com OpenAI</strong>
            <span>OpenAI, Ollama, LM Studio, OpenRouter…</span>
          </button>
        </div>
        <div className="grid two">
          <div className="field">
            <label htmlFor="ai-name">Nome</label>
            <input id="ai-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="ai-model">Modelo</label>
            <input id="ai-model" className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={kind === "anthropic" ? "claude-opus-5-5" : "ex.: gpt-5, llama3.1"} required />
          </div>
        </div>
        {kind === "openai-compatible" ? (
          <div className="field">
            <label htmlFor="ai-endpoint">Endereço da API</label>
            <input id="ai-endpoint" className="mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://ollama:11434/v1" required />
          </div>
        ) : null}
        <div className="grid two">
          <div className="field">
            <label htmlFor="ai-key">Chave da API{kind === "openai-compatible" ? " (se a API pedir)" : ""}</label>
            <input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={kind === "anthropic"} />
          </div>
          {kind === "anthropic" ? (
            <div className="field">
              <label htmlFor="ai-effort">Esforço de raciocínio</label>
              <select id="ai-effort" value={effort ?? ""} onChange={(e) => setEffort((e.target.value || null) as AiProvider["effort"])}>
                <option value="">padrão do modelo</option>
                <option value="low">baixo</option>
                <option value="medium">médio</option>
                <option value="high">alto</option>
                <option value="xhigh">muito alto</option>
              </select>
            </div>
          ) : null}
        </div>
        <p className="muted small-print">
          <Icon name="key" size={12} /> O Nexo testa a chave antes de salvar e guarda cifrada. O uso é cobrado pelo provedor, na conta de quem é a chave.
        </p>
        {error ? (
          <div className="notice warning" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function McpDialog({ onClose }: { onClose: () => void }) {
  const { data, refresh, notify } = useApp();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Novo servidor MCP"
      onClose={onClose}
      width={560}
      footer={
        <button className="btn primary" type="submit" form="mcp-form" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          Conectar e salvar
        </button>
      }
    >
      <form
        id="mcp-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await data.createMcpServer({ name: name.trim(), url: url.trim(), ...(authValue ? { authHeader: authHeader.trim() || "Authorization", authValue } : {}) });
            notify("Servidor conectado. Agora libere as ferramentas de leitura que a IA pode usar.");
            refresh();
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível conectar.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="mcp-name">Nome</label>
          <input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Documentação interna" required />
        </div>
        <div className="field">
          <label htmlFor="mcp-url">Endereço (HTTP)</label>
          <input id="mcp-url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.empresa.com/mcp" required />
        </div>
        <div className="grid two">
          <div className="field">
            <label htmlFor="mcp-header">Cabeçalho de autenticação</label>
            <input id="mcp-header" className="mono" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mcp-value">Valor (opcional)</label>
            <input id="mcp-value" type="password" autoComplete="off" value={authValue} onChange={(e) => setAuthValue(e.target.value)} placeholder="Bearer …" />
          </div>
        </div>
        <p className="muted small-print">Só o transporte HTTP é aceito: o Nexo não executa programas no servidor. Toda ferramenta nasce sem liberação.</p>
        {error ? (
          <div className="notice warning" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

const SESSION_STATUS: Record<AssistSession["status"], { label: string; badge: string }> = {
  queued: { label: "Na fila", badge: "warning" },
  running: { label: "A IA está lendo", badge: "accent" },
  proposed: { label: "Proposta pronta", badge: "good" },
  failed: { label: "Falhou", badge: "critical" },
  applied: { label: "Aplicada", badge: "neutral" },
  discarded: { label: "Descartada", badge: "neutral" },
};

function SessionBadge({ status }: { status: AssistSession["status"] }) {
  return <span className={`badge ${SESSION_STATUS[status].badge}`}>{SESSION_STATUS[status].label}</span>;
}

// ---------- Sessão assistida (FLX-008) ----------

export interface AssistTarget {
  projectId: string;
  integrationId: string;
  externalId: string;
  ref?: string;
  pipelineName: string;
}

/**
 * Pede a proposta à IA, mostra o que ela leu e o que propõe, deixa corrigir e aplicar.
 * Antes de pedir, mostra exatamente o que vai para o modelo (§19.5).
 */
export function AssistDialog({ target, onClose, onApplied }: { target: AssistTarget; onClose: () => void; onApplied: (pipelineId: string) => void }) {
  const { data, notify, refresh } = useApp();
  const config = useAsync(async () => ({ providers: await data.aiProviders(), servers: await data.mcpServers() }), [data]);
  const [providerId, setProviderId] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [session, setSession] = useState<AssistSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState<string | null>(null);

  useEffect(() => {
    if (config.state === "ready" && !providerId && config.value.providers[0]) setProviderId(config.value.providers[0].id);
  }, [config, providerId]);

  // Acompanha a sessão enquanto a IA trabalha.
  useEffect(() => {
    if (!session || (session.status !== "queued" && session.status !== "running")) return;
    const t = setTimeout(() => void data.assistSession(session.id).then(setSession, () => undefined), 1500);
    return () => clearTimeout(t);
  }, [data, session]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setSession(
        await data.startAssistSession({
          projectId: target.projectId,
          integrationId: target.integrationId,
          externalId: target.externalId,
          ...(target.ref ? { ref: target.ref } : {}),
          providerId,
          mcpTools: tools,
          acknowledged: ack,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível pedir a proposta.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!session) return;
    let manifest: PipelineManifest | undefined;
    if (edited !== null) {
      try {
        manifest = JSON.parse(edited) as PipelineManifest;
      } catch {
        setError("O manifesto editado não é um JSON válido.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await data.applyAssistSession(session.id, manifest ? { manifest } : {});
      notify(`Configuração aplicada em "${detail.pipeline.name}" (manifesto v${detail.manifest.version}, em rascunho para aprovar).`);
      refresh();
      onApplied(detail.pipeline.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível aplicar.");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (session) await data.discardAssistSession(session.id).catch(() => undefined);
    onClose();
  };

  const review = session?.review;
  const proposed = session?.status === "proposed";
  const readTools = config.state === "ready" ? config.value.servers.flatMap((s) => s.tools.filter((t) => t.authorized && t.kind === "read").map((t) => ({ ref: `${s.id}/${t.name}`, label: `${s.name} · ${t.name}`, description: t.description }))) : [];

  return (
    <Modal
      title="Configurar com IA"
      subtitle={target.pipelineName}
      onClose={onClose}
      width={proposed ? 880 : 620}
      footer={
        <>
          {error ? (
            <span className="warning-text grow" role="alert">
              {error}
            </span>
          ) : (
            <span className="grow" />
          )}
          {!session ? (
            <button className="btn primary" type="button" disabled={busy || !providerId || !ack} onClick={() => void start()}>
              <Icon name="sparkles" size={14} />
              Pedir proposta
            </button>
          ) : proposed ? (
            <>
              <IconButton icon="trash" label="Descartar a proposta" danger onClick={() => void discard()} />
              <button className="btn primary" type="button" disabled={busy || (!review?.manifest && edited === null)} onClick={() => void apply()}>
                <Icon name="check" size={14} />
                Aplicar configuração
              </button>
            </>
          ) : null}
        </>
      }
    >
      {config.state === "loading" ? <Loading /> : null}
      {config.state === "error" ? <Failure error={config.error} /> : null}
      {config.state === "ready" && !session ? (
        config.value.providers.length === 0 ? (
          <div className="empty">Nenhum provedor de IA configurado. Peça a quem administra para cadastrar em Administração → Inteligência artificial, ou use o caminho manual.</div>
        ) : (
          <div className="execute-form">
            <div className="field">
              <label htmlFor="as-provider">IA</label>
              <select id="as-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {config.value.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </select>
            </div>
            {readTools.length ? (
              <div className="share-section">
                <div className="share-label">Ferramentas MCP que a IA pode consultar</div>
                <div className="toggle-list">
                  {readTools.map((t) => (
                    <label key={t.ref} className="toggle-row">
                      <input type="checkbox" checked={tools.includes(t.ref)} onChange={(e) => setTools((cur) => (e.target.checked ? [...cur, t.ref] : cur.filter((x) => x !== t.ref)))} />
                      <span>
                        {t.label}
                        {t.description ? <small>{t.description}</small> : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="notice accent">
              <div>
                <strong>O que vai para o modelo:</strong> o arquivo e os parâmetros desta pipeline, a lista de branches, os nomes dos recursos cadastrados
                {tools.length ? " e o que as ferramentas MCP marcadas devolverem" : ""}. Credenciais nunca vão. A IA só lê: não grava, não executa, não aprova.
              </div>
            </div>
            <label className="toggle-row" style={{ padding: 0 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>Entendi o que será enviado ao provedor de IA</span>
            </label>
          </div>
        )
      ) : null}

      {session && (session.status === "queued" || session.status === "running") ? (
        <div className="assist-wait">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>A IA está lendo a pipeline…</strong>
            <p className="muted small-print">Costuma levar menos de um minuto. Pode fechar: a sessão continua e fica em Administração → Inteligência artificial.</p>
          </div>
        </div>
      ) : null}

      {session?.status === "failed" ? (
        <div className="notice warning" role="alert">
          <div>
            <strong>A sessão não terminou.</strong> {session.error}
          </div>
        </div>
      ) : null}

      {proposed && review ? (
        <div className="assist-review">
          {review.notes.summary ? <p className="assist-summary">{review.notes.summary}</p> : null}
          {review.problems.length ? (
            <div className="notice warning" role="alert">
              <div>
                <strong>A proposta não passou na validação</strong> e não pode ser aplicada como está:
                <ul>
                  {review.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                Corrija o manifesto abaixo ou descarte.
              </div>
            </div>
          ) : null}
          <div className="grid two">
            <ReviewList title="O que muda" items={review.changes} empty="Nada além do que a descoberta já tinha lido." />
            <ReviewList title="Precisa da sua atenção" items={[...review.warnings, ...review.notes.uncertainties]} empty="Nenhuma dúvida apontada." tone="warning" />
          </div>
          <ReviewList title="De onde a IA tirou isso" items={review.notes.sources} empty="A IA não citou fontes." />
          <details className="results-sources">
            <summary>
              O que a IA leu ({session.steps.length} {session.steps.length === 1 ? "consulta" : "consultas"}
              {session.usage ? `, ${(session.usage.inputTokens + session.usage.outputTokens).toLocaleString("pt-BR")} tokens` : ""})
            </summary>
            <ul>
              {session.steps.map((s, i) => (
                <li key={i}>
                  {s.ok ? "✓" : "✕"} {s.source} <span className="mono muted">{s.tool}</span>
                </li>
              ))}
            </ul>
          </details>
          <details className="results-sources" open={!review.manifest}>
            <summary>Corrigir o manifesto antes de aplicar</summary>
            <textarea
              className="code-editor"
              spellCheck={false}
              rows={16}
              value={edited ?? JSON.stringify(review.manifest ?? {}, null, 2)}
              onChange={(e) => setEdited(e.target.value)}
              aria-label="Manifesto proposto"
            />
          </details>
          <p className="muted small-print">Aplicar grava uma versão nova do manifesto, em rascunho. Aprovar continua sendo um passo seu, na aba Configuração.</p>
        </div>
      ) : null}
    </Modal>
  );
}

function ReviewList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone?: "warning" }) {
  return (
    <section className="assist-list">
      <div className="share-label">{title}</div>
      {items.length ? (
        <ul className={tone === "warning" ? "warning-list" : undefined}>
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small-print">{empty}</p>
      )}
    </section>
  );
}
