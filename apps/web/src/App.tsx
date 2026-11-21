import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Ctx, routeKey, type Route, type ToastTone } from "./context.tsx";
import { apiLogin, apiLogout, apiSource, demoSource, probe, scopeToWorkspace, type DataSource } from "./data/source.ts";
import type { LinkedPipeline, OrganizationChoice, Project, Run, SessionView, Workspace } from "./data/types.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Alerts } from "./pages/Alerts.tsx";
import { AdminScreen, type AdminSection } from "./pages/Settings.tsx";
import { TokenPage, tokenFromLocation, type TokenKind } from "./pages/TokenPage.tsx";
import { PublicSharePage, shareTokenFromLocation, takePendingShare } from "./pages/Share.tsx";
import { lastRunColor, Overview } from "./pages/Overview.tsx";
import { PipelineList, PipelineView } from "./pages/Pipelines.tsx";
import { initials, ROLE_LABEL, useAsync } from "./util.tsx";

// Moldura do painel no estilo de editores como o Obsidian: faixa de ícones, árvore lateral, abas, painel de
// propriedades à direita e barra de status. Navegação por abas, sem dependência de roteador.

type Theme = "dark" | "light";

function readTheme(): Theme {
  const forced = new URLSearchParams(location.search).get("theme");
  if (forced === "light" || forced === "dark") return forced;
  try {
    return localStorage.getItem("painel.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

type Boot =
  | { stage: "probing" }
  | { stage: "share"; token: string }
  | { stage: "token"; kind: TokenKind; token: string }
  | { stage: "login"; offline: boolean; notice?: string }
  | { stage: "choose"; data: DataSource; session: SessionView }
  | { stage: "ready"; data: DataSource; session: SessionView; workspace: Workspace | null };

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  // Link de uso único (definir senha, aceitar convite) abre a página dele antes de tudo.
  const [notice, setNotice] = useState<string | null>(null);
  const [boot, setBoot] = useState<Boot>(() => {
    // Link compartilhado (incremento 7): página pública, sem a moldura do painel.
    const share = shareTokenFromLocation();
    if (share !== undefined) return { stage: "share", token: share };
    const t = tokenFromLocation();
    return t ? { stage: "token", ...t } : { stage: "probing" };
  });

  // Link "só membros" aberto sem sessão: depois de entrar, volta para ele.
  useEffect(() => {
    if (boot.stage !== "choose" && boot.stage !== "ready") return;
    const pending = takePendingShare();
    if (pending) location.assign(`/compartilhado#${pending}`);
  }, [boot.stage]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("painel.theme", theme);
    } catch {
      /* preferência só local */
    }
  }, [theme]);

  useEffect(() => {
    if (boot.stage !== "probing") return;
    // ?demo abre direto na demonstração (útil para mostrar o painel sem API).
    if (new URLSearchParams(location.search).has("demo")) {
      const data = demoSource();
      void data.session().then((session) => setBoot({ stage: "choose", data, session }));
      return;
    }
    void probe().then(async (r) => {
      if (r.state !== "session") return setBoot({ stage: "login", offline: r.state === "offline" });
      // Sessão já aberta (recarregou a página): volta ao workspace lembrado; sem ele, pergunta.
      const s = r.session;
      const data = apiSource(() => s.csrfToken);
      const workspace = await rememberedWorkspace(data, s).catch(() => undefined);
      setBoot(workspace ? { stage: "ready", data, session: s, workspace } : { stage: "choose", data, session: s });
    });
  }, [boot.stage]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  if (boot.stage === "probing") return <div className="login">Carregando…</div>;
  if (boot.stage === "share") return <PublicSharePage token={boot.token} />;
  if (boot.stage === "token") {
    return (
      <TokenPage
        kind={boot.kind}
        token={boot.token}
        onDone={(message) => {
          setNotice(message);
          setBoot({ stage: "probing" });
        }}
      />
    );
  }
  if (boot.stage === "login") {
    return (
      <Login
        offline={boot.offline}
        notice={notice}
        onSession={(s) => setBoot({ stage: "choose", data: apiSource(() => s.csrfToken), session: s })}
        onDemo={async () => {
          const data = demoSource();
          setBoot({ stage: "choose", data, session: await data.session() });
        }}
      />
    );
  }
  if (boot.stage === "choose") {
    const { data, session } = boot;
    return (
      <EntryChooser
        data={data}
        session={session}
        onEnter={(s, workspace) => setBoot({ stage: "ready", data, session: s, workspace })}
        onLogout={async () => {
          if (data.mode === "api") await apiLogout(session.csrfToken);
          const r = data.mode === "api" ? await probe() : { state: "login" as const };
          setBoot({ stage: "login", offline: r.state === "offline" });
        }}
      />
    );
  }
  const { data, session, workspace } = boot;
  return (
    <Shell
      key={`${session.organization?.id ?? "-"}/${workspace?.id ?? "-"}`}
      data={workspace ? scopeToWorkspace(data, workspace.id) : data}
      session={session}
      workspace={workspace}
      baseData={data}
      onPickWorkspace={(ws) => {
        if (session.organization) {
          writePref(lastOrgKey(session.user.id), session.organization.id);
          writePref(lastWsKey(session.user.id, session.organization.id), ws.id);
        }
        setBoot({ stage: "ready", data, session, workspace: ws });
      }}
      onPickOrganization={async (orgId) => {
        // Entra no workspace lembrado da outra organização (ou no primeiro); dá para trocar pelo mesmo menu.
        const next = await data.switchOrganization(orgId);
        const list = (await data.workspaces()).filter((w) => !w.archivedAt);
        const ws = (await rememberedWorkspace(data, next).catch(() => undefined)) ?? list[0] ?? null;
        writePref(lastOrgKey(next.user.id), orgId);
        setBoot({ stage: "ready", data, session: next, workspace: ws });
      }}
      onSession={(s) => setBoot({ stage: "ready", data, session: s, workspace })}
      onLogout={async () => {
        if (data.mode === "api") await apiLogout(session.csrfToken).catch(() => undefined);
        history.replaceState(null, "", location.pathname);
        const r = data.mode === "api" ? await probe() : { state: "login" as const };
        setBoot({ stage: "login", offline: r.state === "offline" });
      }}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}

// ---------- Entrada ----------

// Depois da senha, a pessoa escolhe onde entrar (§24, item 2 da especificação): a organização,
// quando participa de mais de uma, e o workspace dentro dela. Um clique na opção já segue; a seta
// volta. Com uma organização e um workspace só, entra direto. O painel abre recortado no workspace
// escolhido e dá para trocar pela barra lateral. A lista só aparece depois de autenticar, para não
// revelar a que organizações uma conta pertence.

const lastOrgKey = (userId: string) => `painel.lastOrg.${userId}`;
const lastWsKey = (userId: string, orgId: string) => `painel.lastWorkspace.${userId}.${orgId}`;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferência só local */
  }
}

/** Workspace lembrado neste navegador para o usuário e a organização em uso, se ainda existir. */
async function rememberedWorkspace(data: DataSource, session: SessionView): Promise<Workspace | undefined> {
  if (!session.organization) return undefined;
  const id = readPref(lastWsKey(session.user.id, session.organization.id));
  if (!id) return undefined;
  return (await data.workspaces()).find((w) => w.id === id && !w.archivedAt);
}

function Brand({ onBack, backLabel }: { onBack?: (() => void) | undefined; backLabel?: string }) {
  return (
    <div className="entry-brand">
      {onBack ? (
        <button className="entry-back" type="button" onClick={onBack} aria-label={backLabel ?? "Voltar"} title={backLabel ?? "Voltar"}>
          <Icon name="back" size={18} />
        </button>
      ) : null}
      <img className="login-logo" src="/logo.png" alt="" />
      <span className="entry-name">Nexo</span>
    </div>
  );
}

function Login({
  offline,
  notice,
  onSession,
  onDemo,
}: {
  offline: boolean;
  notice: string | null;
  onSession: (s: SessionView) => void;
  onDemo: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSession(await apiLogin(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar.");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card entry-card" onSubmit={submit}>
        <Brand />
        {notice ? (
          <div className="notice accent" role="status">
            <Icon name="check" />
            <div>{notice}</div>
          </div>
        ) : null}
        {offline ? (
          <div className="notice accent">
            <Icon name="alert" />
            <div>A API não está no ar nesta máquina. Dá para navegar pelas telas no modo demonstração, com dados fictícios.</div>
          </div>
        ) : null}
        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={offline}
            required
            autoFocus={!offline}
          />
        </label>
        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={offline}
            required
          />
        </label>
        {error ? (
          <div className="notice warning" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn primary entry-submit" type="submit" disabled={offline || busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <button className={offline ? "btn entry-submit" : "link-btn entry-demo"} type="button" onClick={onDemo}>
          Ver em modo demonstração
        </button>
      </form>
    </div>
  );
}

interface ChoiceItem {
  id: string;
  title: string;
  meta?: string | undefined;
  side?: string | undefined;
}

/** Lista em que um clique já escolhe. `pending` mostra o carregamento no item clicado. */
function ChoiceList({
  label,
  items,
  pending,
  preferred,
  onChoose,
}: {
  label: string;
  items: ChoiceItem[] | null;
  pending: string | null;
  preferred: string | null;
  onChoose: (id: string) => void;
}) {
  if (items === null) {
    return (
      <div className="choices" aria-busy="true" aria-label={label}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="choice skeleton" />
        ))}
      </div>
    );
  }
  return (
    <div className="choices" role="list" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          role="listitem"
          type="button"
          className={`choice${item.id === preferred ? " preferred" : ""}${item.id === pending ? " pending" : ""}`}
          disabled={pending !== null}
          autoFocus={item.id === preferred}
          onClick={() => onChoose(item.id)}
        >
          <span className="org-avatar" aria-hidden="true">
            {initials(item.title)}
          </span>
          <span className="org-name">
            <span>{item.title}</span>
            {item.meta ? <span className="org-meta">{item.meta}</span> : null}
          </span>
          {item.side ? <span className="org-role">{item.side}</span> : null}
          {item.id === pending ? <span className="spinner" aria-label="Abrindo" /> : <Icon name="chevron" size={16} />}
        </button>
      ))}
    </div>
  );
}

/** Escolha de organização (se houver mais de uma) e de workspace, logo depois de autenticar. */
function EntryChooser({
  data,
  session: initial,
  onEnter,
  onLogout,
}: {
  data: DataSource;
  session: SessionView;
  onEnter: (session: SessionView, workspace: Workspace | null) => void;
  onLogout: () => void;
}) {
  const [session, setSession] = useState(initial);
  const [orgs, setOrgs] = useState<OrganizationChoice[] | null>(null);
  const [step, setStep] = useState<"org" | "workspace">("workspace");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstName = session.user.displayName.split(" ")[0];
  const multipleOrgs = (orgs?.length ?? 0) > 1;

  const enter = useCallback(
    (s: SessionView, ws: Workspace | null) => {
      if (s.organization) {
        writePref(lastOrgKey(s.user.id), s.organization.id);
        if (ws) writePref(lastWsKey(s.user.id, s.organization.id), ws.id);
      }
      onEnter(s, ws);
    },
    [onEnter],
  );

  // Organizações e workspaces da organização ativa carregam juntos: na maioria das vezes a
  // pessoa fica na mesma organização e a lista de workspaces já está pronta quando ela chega.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [orgList, wsList] = await Promise.all([
          data.organizations(),
          initial.organization ? data.workspaces() : Promise.resolve([] as Workspace[]),
        ]);
        if (!alive) return;
        const activeOrgs = orgList.filter((o) => !o.archivedAt);
        const activeWs = wsList.filter((w) => !w.archivedAt);
        setOrgs(activeOrgs);
        setWorkspaces(activeWs);
        if (activeOrgs.length > 1) setStep("org");
        else if (activeOrgs.length === 1 && activeWs.length <= 1 && initial.organization) enter(initial, activeWs[0] ?? null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Não foi possível carregar suas organizações.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [data, initial, enter]);

  const chooseOrg = async (orgId: string) => {
    setPending(orgId);
    setError(null);
    try {
      const sameOrg = session.organization?.id === orgId;
      const next = sameOrg ? session : await data.switchOrganization(orgId);
      const list = sameOrg && workspaces ? workspaces : (await data.workspaces()).filter((w) => !w.archivedAt);
      writePref(lastOrgKey(next.user.id), orgId);
      setSession(next);
      setWorkspaces(list);
      setStep("workspace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar nesta organização.");
    } finally {
      setPending(null);
    }
  };

  const chooseWorkspace = (wsId: string) => {
    setPending(wsId);
    enter(session, workspaces?.find((w) => w.id === wsId) ?? null);
  };

  const errorBox = error ? (
    <div className="notice warning" role="alert">
      {error}
    </div>
  ) : null;

  const logoutLabel = data.mode === "demo" ? "Voltar para a entrada" : "Sair e usar outra conta";

  if (step === "org") {
    const preferred = readPref(lastOrgKey(session.user.id)) ?? orgs?.find((o) => o.active)?.id ?? null;
    return (
      <div className="login">
        <div className="card entry-card">
          <Brand onBack={onLogout} backLabel={logoutLabel} />
          <div key="org" className="entry-step">
            <h1 className="entry-title">Olá, {firstName}</h1>
            <p className="entry-hint">Escolha a organização</p>
            <ChoiceList
              label="Organização"
              items={orgs && orgs.map((o) => ({ id: o.id, title: o.name, meta: o.slug, side: ROLE_LABEL[o.role] ?? o.role }))}
              pending={pending}
              preferred={preferred}
              onChoose={(id) => void chooseOrg(id)}
            />
            {errorBox}
          </div>
        </div>
      </div>
    );
  }

  const noOrg = orgs !== null && !session.organization;
  const preferredWs = session.organization ? readPref(lastWsKey(session.user.id, session.organization.id)) : null;
  return (
    <div className="login">
      <div className="card entry-card">
        <Brand
          onBack={multipleOrgs ? () => setStep("org") : onLogout}
          backLabel={multipleOrgs ? "Trocar organização" : logoutLabel}
        />
        <div key={`ws-${session.organization?.id ?? "-"}`} className="entry-step">
          <h1 className="entry-title">{multipleOrgs ? session.organization?.name : `Olá, ${firstName}`}</h1>
          <p className="entry-hint">Escolha o workspace</p>
          {noOrg ? (
            <div className="notice accent">Você ainda não participa de nenhuma organização. Peça um convite a quem administra a sua.</div>
          ) : workspaces !== null && workspaces.length === 0 ? (
            <>
              <div className="notice accent">Esta organização ainda não tem workspaces.</div>
              <button className="btn primary entry-submit" type="button" onClick={() => enter(session, null)}>
                Entrar na organização
              </button>
            </>
          ) : (
            <ChoiceList
              label="Workspace"
              items={workspaces && workspaces.map((w) => ({ id: w.id, title: w.name }))}
              pending={pending}
              preferred={workspaces?.some((w) => w.id === preferredWs) ? preferredWs : (workspaces?.[0]?.id ?? null)}
              onChoose={chooseWorkspace}
            />
          )}
          {errorBox}
        </div>
      </div>
    </div>
  );
}

// ---------- Moldura ----------

const RIBBON: Array<{ route: Route; icon: IconName; label: string }> = [
  { route: { kind: "overview" }, icon: "home", label: "Visão geral" },
  { route: { kind: "pipelines" }, icon: "pipeline", label: "Pipelines" },
];

interface Tree {
  workspaces: Workspace[];
  projects: Project[];
  pipelines: LinkedPipeline[];
  runs: Run[] | null;
}

const TAB_ICON: Record<Route["kind"], IconName> = {
  overview: "home",
  pipelines: "folder",
  pipeline: "pipeline",
  integrations: "plug",
  members: "users",
  audit: "audit",
  alerts: "bell",
  settings: "settings",
};

/** A aba ativa fica no endereço (#/pipeline/<id>), para recarregar e compartilhar sem perder o lugar. */
function routeFromHash(hash: string): Route {
  const [kind, id] = hash.replace(/^#\/?/, "").split("/");
  if (kind === "pipeline" && id) return { kind: "pipeline", id };
  if (kind === "pipelines") return id ? { kind: "pipelines", projectId: id } : { kind: "pipelines" };
  if (kind === "integrations" || kind === "members" || kind === "audit" || kind === "alerts" || kind === "settings") return { kind };
  return { kind: "overview" };
}

function hashFor(r: Route): string {
  if (r.kind === "pipeline") return `#/pipeline/${r.id}`;
  if (r.kind === "pipelines") return r.projectId ? `#/pipelines/${r.projectId}` : "#/pipelines";
  return `#/${r.kind}`;
}

const ADMIN_ROUTES: Partial<Record<Route["kind"], AdminSection>> = {
  settings: "organization",
  integrations: "integrations",
  members: "members",
  audit: "audit",
};

function initialTabs(): Route[] {
  const r = routeFromHash(location.hash);
  return r.kind === "overview" || ADMIN_ROUTES[r.kind] ? [{ kind: "overview" }] : [{ kind: "overview" }, r];
}

/**
 * Organização e workspace em uso, no topo da barra lateral. Abre um menu no lugar (sem sair da
 * tela). Com uma organização e um workspace só, não há o que trocar: vira só um rótulo.
 */
function WorkspaceSwitcher({
  baseData,
  session,
  workspace,
  onPickWorkspace,
  onPickOrganization,
}: {
  baseData: DataSource;
  session: SessionView;
  workspace: Workspace | null;
  onPickWorkspace: (ws: Workspace) => void;
  onPickOrganization: (orgId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<{ orgs: OrganizationChoice[]; workspaces: Workspace[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([baseData.organizations(), session.organization ? baseData.workspaces() : Promise.resolve([] as Workspace[])])
      .then(([orgs, workspaces]) => {
        if (alive) setLists({ orgs: orgs.filter((o) => !o.archivedAt), workspaces: workspaces.filter((w) => !w.archivedAt) });
      })
      .catch(() => alive && setLists({ orgs: [], workspaces: [] }));
    return () => {
      alive = false;
    };
  }, [baseData, session.organization]);

  const orgName = session.organization?.name ?? "Sem organização";
  const wsName = workspace?.name ?? "Todos os workspaces";
  const otherOrgs = lists?.orgs.filter((o) => o.id !== session.organization?.id) ?? [];
  const canSwitch = Boolean(lists && (otherOrgs.length > 0 || lists.workspaces.length > 1));

  if (!canSwitch) {
    return (
      <div className="sidebar-switch static" title={`${orgName} · ${wsName}`}>
        <span className="sidebar-title">{orgName}</span>
        <span className="sidebar-subtitle">{wsName}</span>
      </div>
    );
  }

  const pickOrg = async (id: string) => {
    setPending(id);
    setError(null);
    try {
      await onPickOrganization(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar de organização.");
      setPending(null);
    }
  };

  return (
    <div className="switcher">
      <button className="sidebar-switch" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="sidebar-title">{orgName}</span>
        <span className="sidebar-subtitle">{wsName}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="switcher-menu" role="menu">
            <div className="switcher-label">Workspaces</div>
            {lists!.workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="menuitemradio"
                aria-checked={ws.id === workspace?.id}
                onClick={() => {
                  setOpen(false);
                  if (ws.id !== workspace?.id) onPickWorkspace(ws);
                }}
              >
                <Icon name="layers" size={14} />
                <span className="grow">{ws.name}</span>
                {ws.id === workspace?.id ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
            {otherOrgs.length ? (
              <>
                <div className="user-menu-sep" />
                <div className="switcher-label">Outras organizações</div>
                {otherOrgs.map((o) => (
                  <button key={o.id} type="button" role="menuitem" disabled={pending !== null} onClick={() => void pickOrg(o.id)}>
                    {pending === o.id ? <span className="spinner" aria-hidden="true" /> : <Icon name="home" size={14} />}
                    <span className="grow">{o.name}</span>
                  </button>
                ))}
              </>
            ) : null}
            {error ? <div className="switcher-error">{error}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Shell({
  data,
  session,
  workspace,
  baseData,
  onPickWorkspace,
  onPickOrganization,
  onSession,
  onLogout,
  theme,
  onToggleTheme,
}: {
  data: DataSource;
  /** Fonte sem o recorte do workspace (para listar os outros workspaces e organizações). */
  baseData: DataSource;
  onPickWorkspace: (ws: Workspace) => void;
  onPickOrganization: (orgId: string) => Promise<void>;
  session: SessionView;
  workspace: Workspace | null;
  onSession: (s: SessionView) => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [tabs, setTabs] = useState<Route[]>(initialTabs);
  const [active, setActive] = useState(() => routeKey(routeFromHash(location.hash)));
  const [panel, setPanelState] = useState<ReactNode>(null);
  const [sidebar, setSidebar] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [tree, setTree] = useState<Tree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [admin, setAdmin] = useState<AdminSection | null>(() => ADMIN_ROUTES[routeFromHash(location.hash).kind] ?? null);
  const [userMenu, setUserMenu] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const notify = useCallback((message: string, tone: ToastTone = "success") => setToast({ message, tone }), []);

  // Tempo real (RF-075, ADR-010): mudança de execução recarrega as telas abertas, no máximo a cada
  // 1,5 s, para uma rajada de eventos não virar uma rajada de requisições.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = data.subscribe(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        refresh();
      }, 1500);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [data, refresh]);

  // Na demonstração os endereços do provedor são fictícios: avisa em vez de abrir uma página de erro.
  useEffect(() => {
    if (data.mode !== "demo") return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href^='https://dev.azure.com/exemplo']");
      if (!a) return;
      e.preventDefault();
      setToast({ message: "Na demonstração os links do Azure são fictícios. Com a integração real, este botão abre o repositório de verdade.", tone: "info" });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [data.mode]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    void Promise.all([data.workspaces(), data.projects(), data.pipelines(), data.runs()]).then(([workspaces, projects, pipelines, runs]) =>
      setTree({ workspaces, projects, pipelines, runs }),
    );
  }, [data, version]);

  const needle = filter.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

  const open = useCallback((route: Route) => {
    const section = ADMIN_ROUTES[route.kind];
    if (section) {
      setAdmin(section);
      return;
    }
    setAdmin(null);
    const key = routeKey(route);
    setTabs((t) => (t.some((x) => routeKey(x) === key) ? t : [...t, route]));
    setActive(key);
  }, []);

  const close = (key: string) => {
    setTabs((t) => {
      const i = t.findIndex((x) => routeKey(x) === key);
      const next = t.filter((x) => routeKey(x) !== key);
      if (key === active) {
        const fallback = next[Math.max(0, i - 1)] ?? { kind: "overview" };
        setActive(routeKey(fallback));
        return next.length ? next : [fallback];
      }
      return next;
    });
  };

  const setPanel = useCallback((content: ReactNode) => setPanelState(content), []);
  const reloadSession = useCallback(async () => {
    try {
      onSession(await data.session());
    } catch {
      /* a sessão continua a mesma; a próxima navegação relê */
    }
  }, [data, onSession]);
  const ctx = useMemo(
    () => ({ data, session, open, setPanel, version, refresh, notify, reloadSession }),
    [data, session, open, setPanel, version, refresh, notify, reloadSession],
  );
  const current = tabs.find((t) => routeKey(t) === active) ?? tabs[0]!;

  useEffect(() => {
    const next = hashFor(current);
    if (location.hash !== next) history.replaceState(null, "", next);
  }, [current]);

  useEffect(() => {
    const onHash = () => open(routeFromHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [open]);

  const title = (r: Route): string => {
    switch (r.kind) {
      case "overview":
        return "Visão geral";
      case "pipelines":
        return r.projectId ? (tree?.projects.find((p) => p.id === r.projectId)?.name ?? "Projeto") : "Pipelines";
      case "pipeline":
        return tree?.pipelines.find((p) => p.id === r.id)?.name ?? "Pipeline";
      case "integrations":
        return "Integrações";
      case "members":
        return "Membros";
      case "audit":
        return "Auditoria";
      case "alerts":
        return "Avisos";
      case "settings":
        return "Administração";
    }
  };

  // Avisos abertos, para o número no sino (recarrega junto com o resto, inclusive pelo tempo real).
  const openAlerts = useAsync(() => data.alerts(true), [data, version]);
  const alertCount = openAlerts.state === "ready" ? openAlerts.value.length : 0;

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Ctx.Provider value={ctx}>
      <div className={`workspace${sidebar ? "" : " no-sidebar"}${showPanel ? "" : " no-panel"}`}>
        <nav className="ribbon" aria-label="Navegação principal">
          <img className="ribbon-logo" src="/logo.png" alt="Nexo" title="Nexo" />
          {RIBBON.map((item) => (
            <button
              key={item.label}
              className="ribbon-btn"
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={!admin && current.kind === item.route.kind ? "page" : undefined}
              onClick={() => open(item.route)}
            >
              <Icon name={item.icon} />
            </button>
          ))}
          <button
            className="ribbon-btn bell"
            type="button"
            title={alertCount ? `${alertCount} ${alertCount === 1 ? "aviso aberto" : "avisos abertos"}` : "Avisos"}
            aria-label={alertCount ? `Avisos: ${alertCount} abertos` : "Avisos"}
            aria-current={!admin && current.kind === "alerts" ? "page" : undefined}
            onClick={() => open({ kind: "alerts" })}
          >
            <Icon name="bell" />
            {alertCount ? <span className="ribbon-count">{alertCount > 9 ? "9+" : alertCount}</span> : null}
          </button>
          <button
            className="ribbon-btn"
            type="button"
            title="Administração"
            aria-label="Administração"
            aria-current={admin ? "page" : undefined}
            onClick={() => setAdmin("organization")}
          >
            <Icon name="settings" />
          </button>
          <span className="ribbon-spacer" />
          <button className="ribbon-btn" type="button" title="Mostrar/esconder a barra lateral" aria-label="Barra lateral" onClick={() => setSidebar((v) => !v)}>
            <Icon name="sidebar" />
          </button>
          <button className="ribbon-btn" type="button" title="Mostrar/esconder o painel de propriedades" aria-label="Painel" onClick={() => setShowPanel((v) => !v)}>
            <Icon name="panel" />
          </button>
          <button
            className="ribbon-btn"
            type="button"
            title={theme === "dark" ? "Tema claro" : "Tema escuro"}
            aria-label="Trocar tema"
            onClick={onToggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </nav>

        <aside className="sidebar" aria-label="Projetos e pipelines">
          <div className="sidebar-head">
            <WorkspaceSwitcher baseData={baseData} session={session} workspace={workspace} onPickWorkspace={onPickWorkspace} onPickOrganization={onPickOrganization} />
          </div>
          <label className="sidebar-search">
            <Icon name="search" size={14} />
            <input placeholder="Filtrar pipelines" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar pipelines" />
          </label>
          <div className="sidebar-scroll">
            <div className="sidebar-section">Projetos</div>
            {!tree ? (
              <div style={{ padding: 8, color: "var(--faint)" }}>Carregando…</div>
            ) : (
              tree.workspaces.map((ws) => (
                <div key={ws.id}>
                  <button className="tree-item" type="button" onClick={() => toggle(ws.id)} aria-expanded={!collapsed.has(ws.id)}>
                    <span className="tree-icon">
                      <Icon name={collapsed.has(ws.id) ? "chevron" : "chevronDown"} size={14} />
                    </span>
                    <span className="tree-label" style={{ fontWeight: 600 }}>
                      {ws.name}
                    </span>
                  </button>
                  {collapsed.has(ws.id) ? null : (
                    <div className="tree-children">
                      {tree.projects
                        .filter((p) => p.workspaceId === ws.id)
                        .map((project) => {
                          const pipes = tree.pipelines.filter((x) => x.projectId === project.id && (matches(x.name) || matches(project.name)));
                          if (needle && pipes.length === 0 && !matches(project.name)) return null;
                          const isOpen = needle ? true : !collapsed.has(project.id);
                          return (
                            <div key={project.id}>
                              <button
                                className="tree-item"
                                type="button"
                                aria-current={active === routeKey({ kind: "pipelines", projectId: project.id }) ? "true" : undefined}
                                onClick={() => open({ kind: "pipelines", projectId: project.id })}
                                onDoubleClick={() => toggle(project.id)}
                              >
                                <span
                                  className="tree-icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggle(project.id);
                                  }}
                                >
                                  <Icon name={isOpen ? "chevronDown" : "chevron"} size={14} />
                                </span>
                                <Icon name="folder" size={15} />
                                <span className="tree-label">{project.name}</span>
                                <span className="tree-count">{pipes.length}</span>
                              </button>
                              {isOpen ? (
                                <div className="tree-children">
                                  {pipes.map((pipe) => (
                                    <button
                                      key={pipe.id}
                                      className="tree-item"
                                      type="button"
                                      aria-current={active === routeKey({ kind: "pipeline", id: pipe.id }) ? "true" : undefined}
                                      onClick={() => open({ kind: "pipeline", id: pipe.id })}
                                      title={pipe.syncState === "synchronized" ? pipe.name : `${pipe.name}: dados não confirmados`}
                                    >
                                      <span className="tree-icon">
                                        <Icon name="pipeline" size={14} />
                                      </span>
                                      <span className="tree-label">{pipe.name}</span>
                                      {pipe.syncState !== "synchronized" ? (
                                        <span className="tree-warn">
                                          <Icon name="alert" size={13} title="Dados não confirmados" />
                                        </span>
                                      ) : null}
                                      {/* O ponto fica sempre no fim, no mesmo lugar; sem execução, o espaço fica reservado. */}
                                      <span
                                        className="run-dot"
                                        style={{ background: lastRunColor(tree.runs, pipe.id) ?? "transparent" }}
                                        title={lastRunColor(tree.runs, pipe.id) ? "Resultado da última execução" : undefined}
                                      />
                                    </button>
                                  ))}
                                  {pipes.length === 0 ? <div style={{ padding: "4px 8px", color: "var(--faint)", fontSize: "0.8rem" }}>sem pipelines</div> : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="sidebar-foot">
            <button type="button" className="user-chip user-button" aria-haspopup="menu" aria-expanded={userMenu} onClick={() => setUserMenu((v) => !v)}>
              <span className="avatar">{initials(session.user.displayName) || "?"}</span>
              <div>
                {session.user.displayName}
                <div style={{ color: "var(--faint)", fontSize: "0.75rem" }}>{session.organization ? ROLE_LABEL[session.organization.role] : ""}</div>
              </div>
              <Icon name="chevronDown" size={14} />
            </button>
            {userMenu ? (
              <>
                <div className="menu-backdrop" onClick={() => setUserMenu(false)} />
                <div className="user-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => (setUserMenu(false), setAdmin("account"))}>
                    <Icon name="users" size={15} />
                    Minha conta
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setUserMenu(false), setAdmin("organization"))}>
                    <Icon name="settings" size={15} />
                    Administração
                  </button>
                  <div className="user-menu-sep" />
                  <button type="button" role="menuitem" className="danger" onClick={() => (setUserMenu(false), onLogout())}>
                    <Icon name="back" size={15} />
                    {data.mode === "demo" ? "Sair da demonstração" : "Sair"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </aside>

        <main className="main">
          <div className="tabs" role="tablist" aria-label="Abas abertas">
            {tabs.map((t) => {
              const key = routeKey(t);
              return (
                <div
                  key={key}
                  className="tab"
                  role="tab"
                  tabIndex={0}
                  aria-selected={key === active}
                  onClick={() => setActive(key)}
                  onKeyDown={(e) => (e.key === "Enter" ? setActive(key) : undefined)}
                  onAuxClick={(e) => (e.button === 1 ? close(key) : undefined)}
                >
                  <span className="tab-icon">
                    <Icon name={TAB_ICON[t.kind]} size={14} />
                  </span>
                  <span className="tab-name">{title(t)}</span>
                  {tabs.length > 1 ? (
                    <span
                      className="tab-close"
                      role="button"
                      aria-label={`Fechar ${title(t)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        close(key);
                      }}
                    >
                      <Icon name="close" size={12} />
                    </span>
                  ) : null}
                </div>
              );
            })}
            {data.mode === "demo" ? (
              <div className="tabs-end">
                <span className="pill" title="Dados fictícios, no formato da API. Execuções e gráficos mostram como o painel fica depois do incremento 3.">
                  <Icon name="sparkles" size={12} />
                  Demonstração
                </span>
              </div>
            ) : null}
          </div>
          <div className="view" key={active}>
            <div className="view-inner">
              <View route={current} />
            </div>
          </div>
        </main>

        <aside className="panel" aria-label="Propriedades">
          {panel ?? <div className="panel-empty">Abra uma pipeline para ver as propriedades dela aqui.</div>}
        </aside>

        {admin ? (
          <AdminScreen section={admin} onSection={setAdmin} onClose={() => setAdmin(null)} onLogout={onLogout} />
        ) : null}

        {toast ? (
          <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
            <Icon name={toast.tone === "error" ? "alert" : toast.tone === "info" ? "sparkles" : "check"} size={15} />
            <span>{toast.message}</span>
            <button type="button" className="toast-close" aria-label="Fechar aviso" onClick={() => setToast(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ) : null}

        <footer className="statusbar">
          <span>
            <span className="dot" style={{ background: data.mode === "api" ? "var(--good)" : "var(--accent)" }} />
            {data.mode === "api" ? "Conectado à API" : "Demonstração"}
          </span>
          <span>{session.organization?.name}</span>
          <span className="spacer" />
          <span>{tree ? `${tree.pipelines.length} pipelines · ${tree.projects.length} projetos` : ""}</span>
        </footer>
      </div>
    </Ctx.Provider>
  );
}

function View({ route }: { route: Route }) {
  switch (route.kind) {
    case "overview":
      return <Overview />;
    case "pipelines":
      return <PipelineList {...(route.projectId ? { projectId: route.projectId } : {})} />;
    case "pipeline":
      return <PipelineView id={route.id} />;
    case "alerts":
      return <Alerts />;
    case "integrations":
    case "members":
    case "audit":
    case "settings":
      return null;
  }
}
