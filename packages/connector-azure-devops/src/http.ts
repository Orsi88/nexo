import { ProviderError, type ConnectionContext, type ProviderErrorKind } from "@painel/connector-sdk";

// Cliente HTTP mínimo da API REST do Azure DevOps.
// A credencial só entra no cabeçalho Authorization; nunca em URL, mensagem de erro ou log (RN-017).

export const API_VERSION = "7.1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function kindOf(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "invalid";
}

function describe(status: number): string {
  if (status === 401) return " (credencial inválida ou expirada)";
  if (status === 403) return " (sem permissão)";
  if (status === 404) return " (não encontrado ou sem acesso)";
  if (status === 429) return " (limite de requisições)";
  if (status >= 500) return " (indisponível)";
  return "";
}

/** Erro de chamada à API, sem o corpo da resposta (pode ecoar dados sensíveis) e sem credencial. */
export class AzureDevOpsHttpError extends ProviderError {
  readonly status: number;
  constructor(status: number, operation: string, retryAfterSeconds?: number) {
    super(kindOf(status), `${operation}: Azure DevOps respondeu ${status}${describe(status)}`, retryAfterSeconds);
    this.name = "AzureDevOpsHttpError";
    this.status = status;
  }
}

/**
 * Hosts do Azure DevOps Services. O servidor envia a credencial para este endereço, então ele não
 * pode ser qualquer um: senão um endpoint mal-intencionado leva o PAT ou sonda a rede interna (SSRF).
 * Azure DevOps Server (instalado na empresa) entra por `extraHosts`, configurado pelo operador.
 */
const CLOUD_HOST = "dev.azure.com";
const LEGACY_HOST = /^([a-z0-9][a-z0-9-]{0,61})\.visualstudio\.com$/;

/** Normaliza e valida o endpoint da organização: https, host do Azure DevOps, sem barra final. */
export function organizationUrl(endpoint: string, extraHosts: readonly string[] = []): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderError("invalid", "endpoint do Azure DevOps inválido");
  }
  if (url.protocol !== "https:") throw new ProviderError("invalid", "endpoint do Azure DevOps precisa usar https");
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError("invalid", "endpoint do Azure DevOps não pode conter credencial, query ou fragmento");
  }
  if (url.port) throw new ProviderError("invalid", "endpoint do Azure DevOps não pode indicar porta");
  const path = url.pathname.replace(/\/+$/, "");
  const host = url.hostname.toLowerCase();
  if (host === CLOUD_HOST) {
    if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(path)) {
      throw new ProviderError("invalid", "use https://dev.azure.com/<organização>");
    }
  } else if (LEGACY_HOST.test(host)) {
    if (path !== "") throw new ProviderError("invalid", "use https://<organização>.visualstudio.com");
  } else if (!extraHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new ProviderError("invalid", "endpoint fora do Azure DevOps (dev.azure.com ou <organização>.visualstudio.com)");
  }
  return `https://${host}${path}`;
}

function authorization(conn: ConnectionContext): string {
  if (conn.credential.kind !== "pat") {
    throw new ProviderError("invalid", `tipo de credencial não suportado pelo conector Azure DevOps: ${conn.credential.kind}`);
  }
  return "Basic " + Buffer.from(":" + conn.credential.value, "utf8").toString("base64");
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Rótulo da operação para mensagens de erro. */
  operation: string;
  /**
   * Só para downloads: o Azure redireciona para o armazenamento. O fetch descarta o cabeçalho
   * Authorization ao trocar de origem, então a credencial não sai da organização.
   */
  followRedirects?: boolean;
  /**
   * Status de erro que a operação trata sozinha (devolve a resposta em vez de lançar). Só para a
   * validação prévia, em que o 400 é a resposta esperada e a mensagem fala dos parâmetros enviados.
   */
  acceptStatus?: readonly number[];
}

export class AzureDevOpsClient {
  readonly #fetch: FetchLike;
  readonly #conn: ConnectionContext;
  readonly #base: string;

  constructor(conn: ConnectionContext, fetchImpl: FetchLike, extraHosts: readonly string[] = []) {
    this.#conn = conn;
    this.#fetch = fetchImpl;
    this.#base = organizationUrl(conn.endpoint, extraHosts);
  }

  url(path: string, query: RequestOptions["query"] = {}): string {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", API_VERSION);
    return url.toString();
  }

  async raw(path: string, options: RequestOptions, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: authorization(this.#conn),
      accept,
      "x-tfs-fedauthredirect": "Suppress",
      "x-vss-e2eid": this.#conn.correlationId,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      redirect: options.followRedirects ? "follow" : "manual",
    };
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
      // DNS, TLS, conexão recusada: a causa vai só para o log do processo, nunca para o usuário.
      throw new ProviderError("unavailable", `${options.operation}: não foi possível falar com o Azure DevOps`);
    }
    // Sem credencial válida, o Azure DevOps redireciona para a tela de login em vez de responder 401.
    if (response.status >= 300 && response.status < 400) {
      throw new AzureDevOpsHttpError(401, options.operation);
    }
    if (!response.ok && options.acceptStatus?.includes(response.status)) return response;
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw new AzureDevOpsHttpError(response.status, options.operation, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    // Seguindo redirecionamento, credencial inválida termina na tela de login (HTML com 200).
    if (accept !== "text/html" && (response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new AzureDevOpsHttpError(401, options.operation);
    }
    return response;
  }

  async json<T>(path: string, options: RequestOptions): Promise<{ data: T; continuation?: string }> {
    const response = await this.raw(path, options);
    const data = (await response.json()) as T;
    const continuation = response.headers.get("x-ms-continuationtoken") ?? undefined;
    return continuation ? { data, continuation } : { data };
  }
}

export function seg(value: string): string {
  return encodeURIComponent(value);
}
