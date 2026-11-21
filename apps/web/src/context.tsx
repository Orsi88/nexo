import { createContext, useContext } from "react";
import type { DataSource } from "./data/source.ts";
import type { SessionView } from "./data/types.ts";

// Rotas das abas. Cada rota vira uma aba, como arquivos abertos num editor.

export type Route =
  | { kind: "overview" }
  | { kind: "pipelines"; projectId?: string }
  | { kind: "pipeline"; id: string }
  | { kind: "integrations" }
  | { kind: "members" }
  | { kind: "audit" }
  | { kind: "alerts" }
  | { kind: "settings" };

export const routeKey = (r: Route): string =>
  r.kind === "pipeline" ? `pipeline:${r.id}` : r.kind === "pipelines" ? `pipelines:${r.projectId ?? "all"}` : r.kind;

export type ToastTone = "success" | "error" | "info";

export interface AppContext {
  data: DataSource;
  session: SessionView;
  open: (route: Route) => void;
  /** Mostra algo no painel da direita (propriedades do que está aberto). */
  setPanel: (content: React.ReactNode) => void;
  /** Muda a cada alteração de dados; telas incluem nas dependências para recarregar. */
  version: number;
  /** Avisa que algo mudou (vínculo, sincronização...) para recarregar árvore e telas. */
  refresh: () => void;
  /** Relê a sessão (papel, permissões, nome da organização) depois de uma mudança administrativa. */
  reloadSession: () => Promise<void>;
  /** Mostra um aviso curto na parte de baixo da tela. Sem tom = confirmação de sucesso. */
  notify: (message: string, tone?: ToastTone) => void;
}

export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("fora do App");
  return ctx;
}
