import { useEffect, useState } from "react";
import { useApp } from "../context.tsx";
import type { AccessPolicy, AccessToken, ExecResource, IssuedLink, Member, Operation, Project, Role, Workspace } from "../data/types.ts";
import { Icon, IconButton, type IconName } from "../icons.tsx";
import { Audit, Integrations } from "./Admin.tsx";
import { Modal } from "../modal.tsx";
import { confirmDialog } from "../dialogs.tsx";
import { RulesManager } from "./Alerts.tsx";
import { EmailTab, RetentionTab, SharingTab } from "./Distribution.tsx";
import { AiTab } from "./Assist.tsx";
import { CopyField, dateTime, Failure, initials, PageSkeleton, ROLE_LABEL, useAsync } from "../util.tsx";

// Administração da organização em uso (incremento 1 no backend): dados da organização, política de
// acesso (§6), workspaces e projetos, membros e convites e, para o administrador da instalação,
// novas organizações e links de redefinição de senha. Toda regra é do servidor; a tela só mostra o
// que o papel permite e repassa o que ele responde.

export type AdminSection =
  | "organization"
  | "structure"
  | "members"
  | "integrations"
  | "resources"
  | "rules"
  | "sharing"
  | "retention"
  | "email"
  | "ai"
  | "audit"
  | "instance"
  | "account";

const OPERATION_LABEL: Record<Operation, string> = {
  view: "Ver dashboards e relatórios",
  execute: "Executar pipelines",
  cancel: "Cancelar execuções",
  configurePipelines: "Configurar pipelines",
  manageIntegrations: "Gerenciar integrações",
  createProjects: "Criar workspaces e projetos",
  manageUsers: "Gerenciar usuários",
  share: "Compartilhar relatórios",
  viewAudit: "Consultar auditoria",
};

function useAction() {
  const { refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok: string | ((v: T) => string)): Promise<T | undefined> => {
    setBusy(true);
    try {
      const v = await fn();
      notify(typeof ok === "string" ? ok : ok(v));
      refresh();
      return v;
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível.", "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

const SECTIONS: Array<{ group: string; items: Array<[AdminSection, string, IconName]> }> = [
  {
    group: "Organização",
    items: [
      ["organization", "Geral e acesso", "settings"],
      ["structure", "Workspaces e projetos", "folder"],
      ["members", "Membros", "users"],
    ],
  },
  {
    group: "Conexões",
    items: [
      ["integrations", "Integrações", "plug"],
      ["resources", "Recursos", "layers"],
      ["ai", "Inteligência artificial", "bot"],
    ],
  },
  { group: "Automação", items: [["rules", "Avisos e gatilhos", "bell"]] },
  {
    group: "Distribuição",
    items: [
      ["sharing", "Links compartilhados", "share"],
      ["email", "E-mail", "mail"],
      ["retention", "Retenção", "clock"],
    ],
  },
  { group: "Registros", items: [["audit", "Auditoria", "audit"]] },
  { group: "Sistema", items: [["instance", "Instalação", "key"]] },
  { group: "Você", items: [["account", "Minha conta", "users"]] },
];

/**
 * Administração em tela própria, no padrão de editores como o Obsidian: seções à esquerda e conteúdo à direita, sem
 * a árvore de pipelines nem o painel de propriedades. Fecha no X ou com Esc.
 */
export function AdminScreen({
  section,
  onSection,
  onClose,
  onLogout,
}: {
  section: AdminSection;
  onSection: (s: AdminSection) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const { session } = useApp();
  const perms = session.organization?.permissions ?? {};
  const visible = (key: AdminSection) => (key === "instance" ? session.user.isInstanceAdmin : key === "audit" ? Boolean(perms.viewAudit) : true);
  const current = visible(section) ? section : "organization";
  const label = SECTIONS.flatMap((g) => g.items).find(([k]) => k === current)?.[1] ?? "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Com um diálogo aberto por cima, o Esc fecha só o diálogo.
      if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="admin-screen" role="dialog" aria-modal="true" aria-label="Administração">
      <nav className="admin-nav" aria-label="Seções da administração">
        <div className="admin-nav-head">
          <div className="admin-nav-title">Administração</div>
          <div className="admin-nav-sub">{session.organization?.name ?? "Sem organização"}</div>
        </div>
        {SECTIONS.map((g) => {
          const items = g.items.filter(([k]) => visible(k));
          if (!items.length) return null;
          return (
            <div key={g.group} className="admin-nav-group">
              <div className="admin-nav-label">{g.group}</div>
              {items.map(([key, text, icon]) => (
                <button key={key} type="button" className="admin-nav-item" aria-current={current === key ? "page" : undefined} onClick={() => onSection(key)}>
                  <Icon name={icon} size={15} />
                  {text}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <section className="admin-content">
        <header className="admin-content-head">
          <h1>{label}</h1>
          <button type="button" className="admin-close" onClick={onClose} aria-label="Fechar a administração" title="Fechar (Esc)">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="admin-content-body">
          {current === "organization" ? <OrganizationTab /> : null}
          {current === "structure" ? <StructureTab canEdit={Boolean(perms.createProjects)} /> : null}
          {current === "members" ? <MembersTab canManage={Boolean(perms.manageUsers)} /> : null}
          {current === "integrations" ? <Integrations /> : null}
          {current === "resources" ? <ResourcesTab canEdit={Boolean(perms.configurePipelines)} /> : null}
          {current === "rules" ? <RulesManager /> : null}
          {current === "ai" ? <AiTab /> : null}
          {current === "sharing" ? <SharingTab /> : null}
          {current === "email" ? <EmailTab /> : null}
          {current === "retention" ? <RetentionTab /> : null}
          {current === "audit" ? <Audit /> : null}
          {current === "instance" ? <InstanceTab /> : null}
          {current === "account" ? <AccountTab onLogout={onLogout} /> : null}
        </div>
      </section>
    </div>
  );
}

function AccountTab({ onLogout }: { onLogout: () => void }) {
  const { session, data } = useApp();
  return (
    <div className="admin-stack">
      <section className="card">
        <div className="account-head">
          <span className="avatar large">{initials(session.user.displayName) || "?"}</span>
          <div>
            <strong>{session.user.displayName}</strong>
            <div className="secondary">{session.user.email}</div>
            <div className="secondary">
              {session.organization?.name ?? "Sem organização"} · {session.organization ? ROLE_LABEL[session.organization.role] : "—"}
              {session.user.isInstanceAdmin ? " · administra a instalação" : ""}
            </div>
          </div>
        </div>
      </section>
      <AccessTokensCard />
      <section className="card">
        <div className="setting-row">
          <div>
            <strong>{data.mode === "demo" ? "Sair da demonstração" : "Sair"}</strong>
            <div className="secondary">{data.mode === "demo" ? "Volta para a tela de entrada." : "Encerra a sessão neste navegador."}</div>
          </div>
          <button type="button" className="btn danger" onClick={onLogout}>
            Sair
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- Tokens pessoais de acesso (ADR-017) ----------

const TOKEN_DAYS = [30, 90, 180, 365];

/** Bolinha "?" com a explicação na dica (mouse) e para leitores de tela. */
function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip" title={text} aria-label={text} role="img" tabIndex={0}>
      ?
    </span>
  );
}

/** Tokens para clientes de API e MCP (Claude Code e outros), com as permissões do seu papel. */
function AccessTokensCard() {
  const { session, data, notify } = useApp();
  const [reload, setReload] = useState(0);
  const tokens = useAsync(() => data.accessTokens(), [data, reload]);
  const [name, setName] = useState("claude-code");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const org = session.organization;
  // Colar o comando no campo Nome é o erro mais comum: avisa antes de criar um token com nome estranho.
  const looksLikeCommand = /claude\s+mcp|nexo_pat_|Bearer\s/i.test(name);

  const revoke = async (t: AccessToken) => {
    const ok = await confirmDialog({
      title: "Revogar token",
      message: <>O token <strong>{t.name}</strong> deixa de funcionar na hora. Quem o usa (por exemplo, o Claude Code) perde o acesso.</>,
      confirmLabel: "Revogar",
      danger: true,
    });
    if (!ok) return;
    try {
      await data.revokeAccessToken(t.id);
      notify("Token revogado.");
      setReload((n) => n + 1);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível revogar.", "error");
    }
  };

  return (
    <section className="card">
      <div className="card-title">
        <Icon name="bot" size={15} />
        Conectar o Claude Code (MCP)
        <HelpTip text="MCP é o jeito de um assistente de IA, como o Claude Code, usar o Nexo por você: listar pipelines, vincular, executar e ver resultados, conversando. Ele age com as mesmas permissões que você tem nesta organização." />
      </div>
      <ol className="steps-inline">
        <li>Clique em <strong>Gerar token</strong>.</li>
        <li>Na janela que abrir, clique em <strong>Copiar comando</strong>.</li>
        <li>
          Cole no terminal <strong>do seu computador</strong> (PowerShell), aperte Enter e abra uma conversa nova no Claude Code.
        </li>
      </ol>
      {org ? (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const res = await data.createAccessToken({ name: name.trim(), days });
              setCreated(res.token);
              setName("claude-code");
              setReload((n) => n + 1);
            } catch (err) {
              notify(err instanceof Error ? err.message : "Não foi possível criar o token.", "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field grow">
            <label htmlFor="token-name">
              Nome do token <HelpTip text="Só um apelido para você reconhecer o token na lista (por exemplo, o computador onde vai usar). Não é aqui que se cola o comando." />
            </label>
            <input id="token-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
            {looksLikeCommand ? <small className="warning-text">Isso parece o comando. Aqui vai só um apelido, como "claude-code".</small> : null}
          </div>
          <div className="field">
            <label htmlFor="token-days">
              Validade <HelpTip text="Depois desse prazo o token para de funcionar e é só gerar outro. Você também pode revogar a qualquer momento na lista abaixo." />
            </label>
            <select id="token-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {TOKEN_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} dias
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit" disabled={busy || !name.trim() || looksLikeCommand}>
            Gerar token
          </button>
        </form>
      ) : (
        <div className="empty">Escolha uma organização: o token vale só para a organização em uso.</div>
      )}
      {org ? (
        <p className="muted small-print">
          O token vale só para <strong>{org.name}</strong>. Para conectar outra organização, troque de organização e gere outro token.
        </p>
      ) : null}
      {tokens.state === "ready" && tokens.value.length > 0 ? (
        <>
          <div className="subhead">Tokens ativos</div>
          {tokens.value.map((t) => (
            <div key={t.id} className="setting-row">
              <div>
                <strong>{t.name}</strong>
                <div className="secondary">
                  {t.organizationName} · criado em {dateTime(t.createdAt)} · último uso {dateTime(t.lastUsedAt)} · expira em {dateTime(t.expiresAt)}
                </div>
              </div>
              <IconButton icon="trash" label={`Revogar ${t.name}`} danger onClick={() => revoke(t)} />
            </div>
          ))}
        </>
      ) : null}
      {tokens.state === "error" ? <Failure error={tokens.error} /> : null}
      {created ? <TokenCreatedDialog token={created} onClose={() => setCreated(null)} /> : null}
    </section>
  );
}

function TokenCreatedDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const { notify } = useApp();
  const url = `${location.origin}/api/mcp`;
  const command = `claude mcp add --transport http nexo ${url} --header "Authorization: Bearer ${token}" --scope user`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      notify("Comando copiado. Agora cole no terminal do seu computador.");
    } catch {
      notify("Não deu para copiar automaticamente: selecione o comando abaixo e copie.", "error");
    }
  };

  return (
    <Modal title="Pronto! Falta só um passo" subtitle="conecte o Claude Code a este Nexo" onClose={onClose} width={640}>
      <div className="execute-form">
        <button type="button" className="btn primary big-copy" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={16} />
          {copied ? "Comando copiado" : "Copiar comando"}
        </button>
        <ol className="steps-inline">
          <li>
            Abra o <strong>PowerShell do seu computador</strong> (no Windows: tecla Iniciar, digite "PowerShell"). Não use o terminal do servidor.
          </li>
          <li>
            Cole com o <strong>botão direito do mouse</strong> e aperte <strong>Enter</strong>. Deve aparecer "Added HTTP MCP server nexo".
          </li>
          <li>
            Abra uma <strong>conversa nova</strong> no Claude Code e peça, por exemplo: "liste as pipelines do Nexo".
          </li>
        </ol>
        <details>
          <summary>Ver o comando e o token</summary>
          <CopyField value={command} label="Copiar comando" onCopied={(ok) => notify(ok ? "Comando copiado." : "Selecione e copie.", ok ? "success" : "error")} />
          <p className="muted small-print">
            Outros clientes MCP: endereço <span className="mono">{url}</span> (HTTP) e cabeçalho <span className="mono">Authorization: Bearer</span> com o token:
          </p>
          <CopyField value={token} label="Copiar token" onCopied={(ok) => notify(ok ? "Token copiado." : "Selecione e copie.", ok ? "success" : "error")} />
        </details>
        <div className="notice warning">
          <Icon name="alert" size={14} /> Esta é a única vez que o token aparece. Trate como senha: não mande em print nem em conversa. Se vazar, revogue na lista.
        </div>
      </div>
    </Modal>
  );
}

// ---------- Organização e política de acesso ----------

function OrganizationTab() {
  const { data, version, session, reloadSession } = useApp();
  const result = useAsync(async () => ({ org: await data.organization(), matrix: await data.accessMatrix(), policy: await data.accessPolicy() }), [data, version]);
  const isAdmin = session.organization?.role === "admin";
  const { busy, run } = useAction();
  const [name, setName] = useState<string | null>(null);
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);

  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { org, matrix } = result.value;
  const current = policy ?? result.value.policy;
  const dirty = policy !== null && JSON.stringify(policy) !== JSON.stringify(result.value.policy);

  const toggle = (role: Role, op: Operation, on: boolean) => {
    const list = new Set(current[role] ?? []);
    if (on) list.add(op);
    else list.delete(op);
    setPolicy({ ...current, [role]: [...list].sort() });
  };

  return (
    <div className="admin-stack">
      <section className="card">
        <div className="card-title">
          <Icon name="home" size={15} />
          Dados da organização
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (name === null) return;
            if (await run(() => data.renameOrganization(name), "Nome atualizado.")) {
              setName(null);
              await reloadSession();
            }
          }}
        >
          <div className="field grow">
            <label htmlFor="org-name">Nome</label>
            <input id="org-name" value={name ?? org.name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="org-slug">Identificador</label>
            <input id="org-slug" className="mono" value={org.slug} disabled title="O identificador é usado nos manifestos e não muda." />
          </div>
          {isAdmin ? (
            <button className="btn primary" type="submit" disabled={busy || name === null || name.trim() === org.name}>
              Salvar
            </button>
          ) : null}
        </form>
        <div className="admin-row">
          <span className="grow">
            {org.archivedAt ? (
              <>
                <span className="badge warning">Arquivada</span> desde {dateTime(org.archivedAt)}: só leitura, nada pode ser executado ou alterado.
              </>
            ) : (
              <span className="muted">Organização ativa.</span>
            )}
          </span>
          {isAdmin ? (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (
                  !org.archivedAt &&
                  !(await confirmDialog({
                    title: "Arquivar organização",
                    message: <>A organização <strong>{org.name}</strong> fica só leitura: nada pode ser executado ou alterado até desarquivar.</>,
                    confirmLabel: "Arquivar organização",
                    danger: true,
                  }))
                )
                  return;
                await run(() => data.setOrganizationArchived(!org.archivedAt), org.archivedAt ? "Organização desarquivada." : "Organização arquivada.");
                await reloadSession();
              }}
            >
              <Icon name={org.archivedAt ? "unarchive" : "archive"} size={14} />
              {org.archivedAt ? "Desarquivar" : "Arquivar organização"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="card flush">
        <div className="card-title padded">
          <Icon name="key" size={15} />
          Política de acesso
          <span className="hint">o que cada papel pode fazer nesta organização (§6)</span>
        </div>
        <table className="list policy">
          <thead>
            <tr>
              <th>Operação</th>
              {matrix.roles.map((r) => (
                <th key={r} className="center">
                  {ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.operations.map((op) => (
              <tr key={op}>
                <td>{OPERATION_LABEL[op] ?? op}</td>
                {matrix.roles.map((r) => {
                  const g = matrix.matrix[r][op];
                  return (
                    <td key={r} className="center">
                      {g === "allow" ? (
                        <span className="grant allow" title="Sempre permitido para este papel">
                          <Icon name="check" size={14} />
                        </span>
                      ) : g === "deny" ? (
                        <span className="grant deny" title="Nunca permitido para este papel">
                          —
                        </span>
                      ) : (
                        <label className="grant policy" title="Conforme política: a organização decide">
                          <input
                            type="checkbox"
                            disabled={!isAdmin}
                            checked={(current[r] ?? []).includes(op)}
                            onChange={(e) => toggle(r, op, e.target.checked)}
                          />
                        </label>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-row padded">
          <span className="muted grow">
            <Icon name="check" size={12} /> sempre · — nunca · caixa = conforme política (a organização decide). A mudança vale na hora para quem já está
            conectado.
          </span>
          {isAdmin ? (
            <>
              <button className="btn" type="button" disabled={!dirty || busy} onClick={() => setPolicy(null)}>
                Descartar
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!dirty || busy}
                onClick={async () => {
                  if (await run(() => data.saveAccessPolicy(current), "Política de acesso salva.")) {
                    setPolicy(null);
                    await reloadSession();
                  }
                }}
              >
                Salvar política
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ---------- Workspaces e projetos ----------

function StructureTab({ canEdit }: { canEdit: boolean }) {
  const { data, version } = useApp();
  const result = useAsync(async () => ({ workspaces: await data.adminWorkspaces(), projects: await data.adminProjects() }), [data, version]);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "workspace"; ws?: Workspace }
    | { kind: "project"; workspaceId: string; project?: Project }
    | null
  >(null);
  const { busy, run } = useAction();
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { workspaces, projects } = result.value;
  const visibleWs = workspaces.filter((w) => showArchived || !w.archivedAt);
  const active = workspaces.filter((w) => !w.archivedAt);

  return (
    <div className="admin-stack">
      <div className="admin-row">
        <label className="check grow">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Mostrar arquivados
        </label>
        {canEdit ? (
          <button className="btn primary" type="button" onClick={() => setDialog({ kind: "workspace" })}>
            <Icon name="plus" size={14} />
            Novo workspace
          </button>
        ) : null}
      </div>
      {visibleWs.length === 0 ? <div className="empty">Nenhum workspace. Crie o primeiro para organizar os projetos.</div> : null}
      {visibleWs.map((ws) => {
        const list = projects.filter((p) => p.workspaceId === ws.id && (showArchived || !p.archivedAt));
        return (
          <section key={ws.id} className={`card flush${ws.archivedAt ? " archived" : ""}`}>
            <div className="card-title padded">
              <Icon name="layers" size={15} />
              {ws.name}
              {ws.archivedAt ? <span className="badge neutral">arquivado</span> : null}
              <span className="hint">
                {list.filter((p) => !p.archivedAt).length} {list.filter((p) => !p.archivedAt).length === 1 ? "projeto" : "projetos"}
              </span>
              <span className="grow" />
              {canEdit ? (
                <span className="row-actions">
                  {!ws.archivedAt ? (
                    <>
                      <button className="btn small" type="button" onClick={() => setDialog({ kind: "project", workspaceId: ws.id })}>
                        <Icon name="plus" size={13} />
                        Projeto
                      </button>
                      <IconButton icon="pencil" label="Renomear workspace" onClick={() => setDialog({ kind: "workspace", ws })} />
                    </>
                  ) : null}
                  <IconButton
                    icon={ws.archivedAt ? "unarchive" : "archive"}
                    label={ws.archivedAt ? "Desarquivar workspace" : "Arquivar workspace"}
                    disabled={busy}
                    onClick={() =>
                      void run(() => data.setWorkspaceArchived(ws.id, !ws.archivedAt), ws.archivedAt ? "Workspace desarquivado." : "Workspace arquivado.")
                    }
                  />
                </span>
              ) : null}
            </div>
            {list.length ? (
              <table className="list">
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} className={p.archivedAt ? "archived" : undefined}>
                      <td>
                        <Icon name="folder" size={14} /> {p.name} {p.archivedAt ? <span className="badge neutral">arquivado</span> : null}
                      </td>
                      <td className="right">
                        {canEdit ? (
                          <span className="row-actions">
                            {!p.archivedAt ? (
                              <IconButton icon="pencil" label="Editar projeto" onClick={() => setDialog({ kind: "project", workspaceId: ws.id, project: p })} />
                            ) : null}
                            <IconButton
                              icon={p.archivedAt ? "unarchive" : "archive"}
                              label={p.archivedAt ? "Desarquivar projeto" : "Arquivar projeto"}
                              disabled={busy}
                              onClick={() =>
                                void run(() => data.setProjectArchived(p.id, !p.archivedAt), p.archivedAt ? "Projeto desarquivado." : "Projeto arquivado.")
                              }
                            />
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted padded">Nenhum projeto neste workspace.</p>
            )}
          </section>
        );
      })}
      {dialog?.kind === "workspace" ? (
        <NameDialog
          title={dialog.ws ? "Renomear workspace" : "Novo workspace"}
          label="Nome do workspace"
          initial={dialog.ws?.name ?? ""}
          onClose={() => setDialog(null)}
          onSave={(name) =>
            run(() => (dialog.ws ? data.renameWorkspace(dialog.ws.id, name) : data.createWorkspace(name)), dialog.ws ? "Workspace renomeado." : "Workspace criado.")
          }
        />
      ) : null}
      {dialog?.kind === "project" ? (
        <NameDialog
          title={dialog.project ? "Editar projeto" : "Novo projeto"}
          label="Nome do projeto"
          initial={dialog.project?.name ?? ""}
          workspaces={dialog.project ? active : undefined}
          workspaceId={dialog.workspaceId}
          onClose={() => setDialog(null)}
          onSave={(name, workspaceId) =>
            run(
              () =>
                dialog.project
                  ? data.updateProject(dialog.project.id, { name, ...(workspaceId && workspaceId !== dialog.project.workspaceId ? { workspaceId } : {}) })
                  : data.createProject(dialog.workspaceId, name),
              dialog.project ? "Projeto atualizado." : "Projeto criado.",
            )
          }
        />
      ) : null}
    </div>
  );
}

function NameDialog({
  title,
  label,
  initial,
  workspaces,
  workspaceId,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  initial: string;
  /** Com a lista, o diálogo também permite mover o projeto de workspace. */
  workspaces?: Workspace[] | undefined;
  workspaceId?: string;
  onClose: () => void;
  onSave: (name: string, workspaceId?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial);
  const [ws, setWs] = useState(workspaceId ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn primary" type="submit" form="name-form" disabled={busy || !name.trim()}>
            Salvar
          </button>
        </>
      }
    >
      <form
        id="name-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await onSave(name.trim(), ws || undefined);
          setBusy(false);
          if (ok !== undefined) onClose();
        }}
      >
        <div className="field">
          <label htmlFor="name-input">{label}</label>
          <input id="name-input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        {workspaces ? (
          <div className="field">
            <label htmlFor="ws-input">Workspace</label>
            <select id="ws-input" value={ws} onChange={(e) => setWs(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------- Membros e convites ----------

const ROLES: Role[] = ["admin", "manager", "operator", "reader"];

function MembersTab({ canManage }: { canManage: boolean }) {
  const { data, version, session } = useApp();
  const result = useAsync(() => data.members(), [data, version]);
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<{ link: IssuedLink; email: string } | null>(null);
  const { busy, run } = useAction();
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;

  const remove = (m: Member) => {
    void (async () => {
      const ok = await confirmDialog({ title: "Remover membro", message: <><strong>{m.displayName}</strong> perde o acesso a esta organização na hora.</>, confirmLabel: "Remover", danger: true });
      if (ok) await run(() => data.removeMember(m.userId), "Membro removido.");
    })();
  };

  return (
    <div className="admin-stack">
      <div className="admin-row">
        <span className="muted grow">
          O cadastro é fechado: só entra quem é convidado. Com e-mail configurado, o convite vai por e-mail; sem ele, você entrega o link.
        </span>
        {canManage ? (
          <button className="btn primary" type="button" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} />
            Convidar
          </button>
        ) : null}
      </div>
      <section className="card flush">
        <table className="list">
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Papel</th>
              <th>Situação</th>
              <th>Desde</th>
              {canManage ? <th className="right" aria-label="Ações" /> : null}
            </tr>
          </thead>
          <tbody>
            {result.value.map((m) => (
              <tr key={m.userId}>
                <td>
                  <span className="member">
                    <span className="org-avatar small" aria-hidden="true">
                      {initials(m.displayName)}
                    </span>
                    <span>
                      {m.displayName}
                      {m.userId === session.user.id ? <span className="muted"> (você)</span> : null}
                      {m.email ? <span className="org-meta block">{m.email}</span> : null}
                    </span>
                  </span>
                </td>
                <td>
                  {canManage && m.userId !== session.user.id ? (
                    <select
                      className="inline-select"
                      value={m.role}
                      disabled={busy}
                      aria-label={`Papel de ${m.displayName}`}
                      onChange={(e) => void run(() => data.setMemberRole(m.userId, e.target.value as Role), "Papel alterado.")}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_LABEL[m.role]
                  )}
                </td>
                <td>{m.invitePending ? <span className="badge warning">Convite pendente</span> : <span className="muted">ativo</span>}</td>
                <td>{dateTime(m.since)}</td>
                {canManage ? (
                  <td className="right">
                    {m.userId !== session.user.id ? (
                      <IconButton icon="trash" label={`Remover ${m.displayName} da organização`} danger disabled={busy} onClick={() => remove(m)} />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onIssued={(link, email) => {
            setInviting(false);
            setIssued({ link, email });
          }}
        />
      ) : null}
      {issued ? <LinkDialog title="Convite criado" who={issued.email} link={issued.link} kind="convite" onClose={() => setIssued(null)} /> : null}
    </div>
  );
}

function InviteDialog({ onClose, onIssued }: { onClose: () => void; onIssued: (link: IssuedLink, email: string) => void }) {
  const { data, refresh } = useApp();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Convidar pessoa"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn primary" type="submit" form="invite-form" disabled={busy}>
            Gerar convite
          </button>
        </>
      }
    >
      <form
        id="invite-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const link = await data.invite({ email: email.trim(), role, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
            refresh();
            onIssued(link, email.trim());
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível convidar.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="inv-email">E-mail</label>
          <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="inv-name">Nome (opcional)</label>
          <input id="inv-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="inv-role">Papel</label>
          <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <div className="notice warning" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** Mostra um link de uso único para copiar: ele só aparece agora e nunca mais (o servidor guarda só o hash). */
function LinkDialog({ title, who, link, kind, onClose }: { title: string; who: string; link: IssuedLink; kind: "convite" | "redefinição"; onClose: () => void }) {
  const { notify } = useApp();
  return (
    <Modal
      title={title}
      subtitle={who}
      onClose={onClose}
      width={560}
    >
      <div className="execute-form">
        {link.emailed ? (
          <div className="notice accent">
            <Icon name="mail" size={14} /> O link foi enviado por e-mail para <strong>{who}</strong>. Se não chegar, entregue o link abaixo.
          </div>
        ) : null}
        <p>
          {link.emailed ? "O link" : <>Envie este link para <strong>{who}</strong>. Ele</>} vale uma vez, até {dateTime(link.expiresAt)}.
          {kind === "convite" ? " Pela página, a pessoa define a senha e entra." : " Pela página, a pessoa define uma senha nova."}
        </p>
        <CopyField value={link.url} onCopied={(ok) => notify(ok ? "Link copiado." : "Não deu para copiar automaticamente: selecione o link e copie.", ok ? "success" : "error")} />
        <p className="muted small-print">O link só aparece agora. Se perder, gere outro.</p>
      </div>
    </Modal>
  );
}

// ---------- Instalação (administrador da instalação) ----------

function InstanceTab() {
  const { data, notify } = useApp();
  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<{ link: IssuedLink; email: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const slugFrom = (name: string) =>
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  return (
    <div className="admin-stack">
      <section className="card">
        <div className="card-title">
          <Icon name="plus" size={15} />
          Nova organização
          <span className="hint">você entra nela como admin; depois convide as pessoas</span>
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const org = await data.createOrganization({ name: orgName.trim(), slug });
              notify(`Organização "${org.name}" criada. Para entrar nela, troque de organização na barra lateral.`);
              setOrgName("");
              setSlug("");
            } catch (err) {
              notify(err instanceof Error ? err.message : "Não foi possível criar.", "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field grow">
            <label htmlFor="new-org">Nome</label>
            <input
              id="new-org"
              value={orgName}
              onChange={(e) => {
                const wasAuto = slug === slugFrom(orgName);
                setOrgName(e.target.value);
                if (wasAuto) setSlug(slugFrom(e.target.value));
              }}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="new-slug">Identificador</label>
            <input id="new-slug" className="mono" value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </div>
          <button className="btn primary" type="submit" disabled={busy || !orgName.trim() || !slug}>
            Criar
          </button>
        </form>
      </section>

      <section className="card">
        <div className="card-title">
          <Icon name="key" size={15} />
          Redefinir senha de alguém
          <span className="hint">gera um link de uso único para a pessoa definir uma senha nova</span>
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setIssued({ link: await data.issuePasswordReset(email.trim()), email: email.trim() });
              setEmail("");
            } catch (err) {
              notify(err instanceof Error ? err.message : "Não foi possível gerar o link.", "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field grow">
            <label htmlFor="reset-email">E-mail da pessoa</label>
            <input id="reset-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <button className="btn primary" type="submit" disabled={busy || !email.trim()}>
            Gerar link
          </button>
        </form>
      </section>
      {issued ? <LinkDialog title="Link de redefinição" who={issued.email} link={issued.link} kind="redefinição" onClose={() => setIssued(null)} /> : null}
    </div>
  );
}

// ---------- Recursos executores (máquinas exclusivas, FLX-005) ----------

function ResourcesTab({ canEdit }: { canEdit: boolean }) {
  const { data, version } = useApp();
  const result = useAsync(() => data.resources(), [data, version]);
  const [editing, setEditing] = useState<ExecResource | "new" | null>(null);
  const { busy, run } = useAction();
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const list = result.value.filter((r) => !r.archivedAt);
  const archived = result.value.filter((r) => r.archivedAt);

  return (
    <div className="admin-stack">
      <div className="admin-row">
        <span className="muted grow">
          Uma máquina ou ambiente que só aguenta uma execução por vez. A pipeline diz no manifesto quais recursos usa; com o recurso ocupado, o pedido
          espera na fila ou é recusado.
        </span>
        {canEdit ? (
          <button className="btn primary" type="button" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Novo recurso
          </button>
        ) : null}
      </div>
      {list.length === 0 ? <div className="empty">Nenhum recurso cadastrado. Cadastre a máquina de testes para o Nexo controlar a fila dela.</div> : null}
      {list.map((r) => (
        <section key={r.id} className="card">
          <div className="alert-head">
            <span className={`badge ${r.lease ? "warning" : "good"}`}>{r.lease ? "Ocupado" : "Livre"}</span>
            <strong>{r.name}</strong>
            <span className="mono muted">{r.ref}</span>
            <span className="grow" />
            {canEdit ? (
              <span className="row-actions">
                <IconButton icon="pencil" label="Editar recurso" onClick={() => setEditing(r)} />
                <IconButton icon="archive" label="Arquivar recurso" disabled={busy} onClick={() => void run(() => data.setResourceArchived(r.id, true), "Recurso arquivado.")} />
              </span>
            ) : null}
          </div>
          {r.description ? <p className="alert-message">{r.description}</p> : null}
          <div className="resource-facts">
            <span>
              <span className="muted">Se estiver ocupado: </span>
              {r.busyPolicy === "queue" ? "o pedido espera na fila" : "o pedido é recusado"}
            </span>
            <span>
              <span className="muted">Na fila: </span>
              {r.queued}
            </span>
            <span>
              <span className="muted">Reserva renovada a cada: </span>
              {Math.round(r.leaseTtlSeconds / 60)} min
            </span>
            {r.lease ? (
              <span>
                <span className="muted">Com: </span>
                {r.lease.holderKind === "external" ? "uma execução iniciada fora do Nexo" : "uma execução do Nexo"}
                {r.lease.expired ? <span className="warning-text"> · sem renovação: o Nexo está conferindo com o provedor</span> : null}
              </span>
            ) : null}
          </div>
        </section>
      ))}
      {archived.length ? (
        <p className="muted small-print">
          Arquivados:{" "}
          {archived.map((r) =>
            canEdit ? (
              <button key={r.id} className="link-btn" type="button" onClick={() => void run(() => data.setResourceArchived(r.id, false), "Recurso desarquivado.")}>
                {r.name} (desarquivar)
              </button>
            ) : (
              <span key={r.id}>{r.name} </span>
            ),
          )}
        </p>
      ) : null}
      {editing ? <ResourceDialog resource={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ResourceDialog({ resource, onClose }: { resource: ExecResource | undefined; onClose: () => void }) {
  const { data } = useApp();
  const { busy, run } = useAction();
  const [ref, setRef] = useState(resource?.ref ?? "");
  const [name, setName] = useState(resource?.name ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [busyPolicy, setBusyPolicy] = useState<"queue" | "reject">(resource?.busyPolicy ?? "queue");
  const [minutes, setMinutes] = useState(Math.round((resource?.leaseTtlSeconds ?? 900) / 60));
  return (
    <Modal
      title={resource ? "Editar recurso" : "Novo recurso"}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn primary" type="submit" form="resource-form" disabled={busy}>
            Salvar
          </button>
        </>
      }
    >
      <form
        id="resource-form"
        className="execute-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(
            () =>
              data.saveResource(
                {
                  ...(resource ? {} : { ref: ref.trim() }),
                  name: name.trim(),
                  ...(description.trim() ? { description: description.trim() } : {}),
                  busyPolicy,
                  leaseTtlSeconds: Math.min(1440, Math.max(1, minutes)) * 60,
                },
                resource?.id,
              ),
            resource ? "Recurso atualizado." : "Recurso cadastrado.",
          );
          if (ok !== undefined) onClose();
        }}
      >
        <div className="field">
          <label htmlFor="res-name">Nome</label>
          <input id="res-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Máquina de testes" required />
        </div>
        <div className="field">
          <label htmlFor="res-ref">Identificador</label>
          <input
            id="res-ref"
            className="mono"
            value={ref}
            disabled={Boolean(resource)}
            onChange={(e) => setRef(e.target.value)}
            placeholder="maquina-testes"
            required
          />
          <small>É o nome que o manifesto da pipeline usa para dizer que precisa deste recurso. Não muda depois.</small>
        </div>
        <div className="field">
          <label htmlFor="res-desc">Descrição (opcional)</label>
          <input id="res-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: agente agente-testes" />
        </div>
        <fieldset className="params">
          <legend>Se estiver ocupado</legend>
          <label className="check">
            <input type="radio" name="busy" checked={busyPolicy === "queue"} onChange={() => setBusyPolicy("queue")} />
            O pedido espera na fila
          </label>
          <label className="check">
            <input type="radio" name="busy" checked={busyPolicy === "reject"} onChange={() => setBusyPolicy("reject")} />
            O pedido é recusado
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="res-ttl">Renovar a reserva a cada (minutos)</label>
          <input id="res-ttl" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          <small>
            Enquanto a execução roda, o Nexo renova a reserva. Se passar esse tempo sem notícia do provedor, ele confere com o provedor antes de liberar
            a máquina.
          </small>
        </div>
      </form>
    </Modal>
  );
}
