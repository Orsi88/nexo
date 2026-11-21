import { ProviderError, type ConnectionContext, type ProviderErrorKind } from "@painel/connector-sdk";

// Cliente HTTP mínimo da API REST do GitHub.
// A credencial só entra no cabeçalho Authorization; nunca em URL, mensagem de erro ou log (RN-017).
// O corpo das respostas de erro não é repassado, com uma exceção controlada (`readErrorMessage`)
// para o 422 do disparo, em que o GitHub explica qual entrada recusou.

export const API_VERSION = "2022-11-28";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function kindOf(status: number, rateLimited: boolean): ProviderErrorKind {
  if (status === 401) return "auth";
  if (rateLimited || status === 429) return "rate-limited";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status >= 500) return "unavailable";
  return "invalid";
}

function describe(kind: ProviderErrorKind): string {
  switch (kind) {
    case "auth":
      return " (credencial inválida ou expirada)";
    case "permission":
      return " (sem permissão)";
    case "not-found":
      return " (não encontrado ou sem acesso)";
    case "rate-limited":
      return " (limite de requisições)";
    case "unavailable":
      return " (indisponível)";
    default:
      return "";
  }
}

/** Erro de chamada à API, sem o corpo da resposta e sem credencial. */
export class GitHubHttpError extends ProviderError {
  readonly status: number;
  constructor(status: number, operation: string, rateLimited: boolean, retryAfterSeconds?: number) {
    const kind = kindOf(status, rateLimited);
    super(kind, `${operation}: GitHub respondeu ${status}${describe(kind)}`, retryAfterSeconds);
    this.name = "GitHubHttpError";
    this.status = status;
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Endpoint da integração: https://github.com/<dono> (pessoa ou organização). Com GitHub Enterprise
 * Server, https://<host>/<dono>, desde que o host esteja em `extraHosts` (configurado pelo operador:
 * o servidor envia a credencial para lá, então não pode ser qualquer endereço — SSRF).
 */
export function parseEndpoint(endpoint: string, extraHosts: readonly string[] = []): { apiBase: string; owner: string; webBase: string } {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new ProviderError("invalid", "endereço do GitHub inválido");
  }
  if (url.protocol !== "https:") throw new ProviderError("invalid", "endereço do GitHub precisa usar https");
  if (url.username || url.password || url.search || url.hash || url.port) {
    throw new ProviderError("invalid", "endereço do GitHub não pode conter credencial, porta, query ou fragmento");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1 || !OWNER.test(parts[0]!)) {
    throw new ProviderError("invalid", "use https://github.com/<usuário ou organização>");
  }
  const owner = parts[0]!;
  const host = url.hostname.toLowerCase();
  if (host === "github.com") return { apiBase: "https://api.github.com", owner, webBase: "https://github.com" };
  if (extraHosts.map((h) => h.toLowerCase()).includes(host)) {
    return { apiBase: `https://${host}/api/v3`, owner, webBase: `https://${host}` };
  }
  throw new ProviderError("invalid", "endereço fora do GitHub (github.com ou um GitHub Enterprise autorizado pelo operador)");
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  operation: string;
  /** Logs e artefatos: o GitHub redireciona para o armazenamento; o fetch descarta o Authorization ao trocar de origem. */
  followRedirects?: boolean;
  /** Status de erro que a operação trata sozinha (devolve a resposta em vez de lançar). */
  acceptStatus?: readonly number[];
}

export class GitHubClient {
  readonly #fetch: FetchLike;
  readonly #conn: ConnectionContext;
  readonly apiBase: string;
  readonly owner: string;
  readonly webBase: string;

  constructor(conn: ConnectionContext, fetchImpl: FetchLike, extraHosts: readonly string[] = []) {
    if (conn.credential.kind !== "pat") {
      throw new ProviderError("invalid", `tipo de credencial não suportado pelo conector GitHub: ${conn.credential.kind}`);
    }
    this.#conn = conn;
    this.#fetch = fetchImpl;
    const parsed = parseEndpoint(conn.endpoint, extraHosts);
    this.apiBase = parsed.apiBase;
    this.owner = parsed.owner;
    this.webBase = parsed.webBase;
  }

  url(path: string, query: RequestOptions["query"] = {}): string {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  async raw(path: string, options: RequestOptions, accept = "application/vnd.github+json"): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#conn.credential.value}`,
      accept,
      "x-github-api-version": API_VERSION,
      "user-agent": "nexo-painel",
    };
    const init: RequestInit = { method: options.method ?? "GET", headers, redirect: options.followRedirects ? "follow" : "manual" };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (this.#conn.signal) init.signal = this.#conn.signal;
    let response: Response;
    try {
      response = await this.#fetch(this.url(path, options.query), init);
    } catch (error) {
      if (this.#conn.signal?.aborted) throw error;
      throw new ProviderError("unavailable", `${options.operation}: não foi possível falar com o GitHub`);
    }
    if (!response.ok && options.acceptStatus?.includes(response.status)) return response;
    if (response.status >= 300 && response.status < 400) throw new GitHubHttpError(response.status, options.operation, false);
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const rateLimited = response.status === 403 && remaining === "0";
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : rateLimited && Number.isFinite(reset) ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : undefined;
      throw new GitHubHttpError(response.status, options.operation, rateLimited, wait);
    }
    return response;
  }

  async json<T>(path: string, options: RequestOptions): Promise<{ data: T; next?: string }> {
    const response = await this.raw(path, options);
    const data = (response.status === 204 ? null : await response.json()) as T;
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    return next ? { data, next } : { data };
  }
}

/** Mensagem do GitHub num erro de validação (422), curta e só a parte útil. */
export async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  return typeof body.message === "string" ? body.message.split("\n")[0]!.slice(0, 300) : `GitHub respondeu ${response.status}`;
}

export const seg = (value: string) => encodeURIComponent(value);
