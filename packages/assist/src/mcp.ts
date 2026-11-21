// Cliente MCP mínimo (RF-174, RF-175; ADR-016): transporte HTTP "streamable" (JSON-RPC 2.0 por POST;
// a resposta vem como JSON ou como fluxo SSE). Só o que o onboarding assistido usa: initialize,
// tools/list e tools/call. O transporte stdio não é suportado: o servidor do Nexo não executa
// programas arbitrários configurados pela interface.
//
// Tudo que volta de um servidor MCP é dado não confiável (§19.5): descrições e resultados de
// ferramentas nunca viram instrução nem autorização.

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerConfig {
  url: string;
  /** Cabeçalho de autenticação já montado (ex.: Authorization: Bearer ...), aberto pelo cofre. */
  auth?: { header: string; value: string } | undefined;
  timeoutMs?: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Dica do próprio servidor; o Nexo só usa como sugestão inicial da classificação. */
  readOnlyHint: boolean;
}

export class McpError extends Error {}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function validateMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError("Endereço inválido. Use a URL completa do servidor MCP (https://...).");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpError("O servidor MCP precisa ser acessado por http ou https.");
  if (url.username || url.password) throw new McpError("Não coloque usuário e senha na URL: use o campo de autenticação.");
  return url.toString();
}

/** Lê uma resposta SSE e devolve a mensagem JSON-RPC com o id pedido. */
function fromSse(text: string, id: number): unknown {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: unknown };
      if (msg && msg.id === id) return msg;
    } catch {
      /* evento que não é JSON: ignora */
    }
  }
  throw new McpError("O servidor MCP não respondeu ao pedido no fluxo de eventos.");
}

export class McpClient {
  readonly #config: McpServerConfig;
  #session: string | undefined;
  #nextId = 1;
  #initialized = false;
  serverInfo: { name?: string; version?: string } = {};

  constructor(config: McpServerConfig) {
    this.#config = { ...config, url: validateMcpUrl(config.url) };
  }

  async #post(body: unknown, expectResponse: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (this.#session) headers["mcp-session-id"] = this.#session;
    if (this.#config.auth) headers[this.#config.auth.header.toLowerCase()] = this.#config.auth.value;
    let res: Response;
    try {
      res = await fetch(this.#config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? 30_000),
        redirect: "error",
      });
    } catch {
      throw new McpError("Não foi possível falar com o servidor MCP (rede, endereço ou tempo esgotado).");
    }
    const session = res.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,200}$/.test(session)) this.#session = session;
    if (res.status === 401 || res.status === 403) throw new McpError("O servidor MCP recusou a autenticação.");
    if (!res.ok && res.status !== 202) throw new McpError(`O servidor MCP respondeu ${res.status}.`);
    if (!expectResponse) return undefined;
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new McpError("Resposta do servidor MCP grande demais.");
    const id = (body as { id: number }).id;
    const msg = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? fromSse(text, id) : JSON.parse(text);
    const rpc = msg as { result?: unknown; error?: { message?: unknown } };
    if (rpc.error) throw new McpError(`Erro do servidor MCP: ${String(rpc.error.message ?? "sem mensagem").slice(0, 300)}`);
    return rpc.result;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#initialized && method !== "initialize") await this.initialize();
    return this.#post({ jsonrpc: "2.0", id: this.#nextId++, method, params }, true);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const result = (await this.#post(
      {
        jsonrpc: "2.0",
        id: this.#nextId++,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nexo", version: "1" } },
      },
      true,
    )) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.serverInfo = { ...(result?.serverInfo?.name ? { name: String(result.serverInfo.name).slice(0, 120) } : {}), ...(result?.serverInfo?.version ? { version: String(result.serverInfo.version).slice(0, 40) } : {}) };
    this.#initialized = true;
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = (await this.#request("tools/list", cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: unknown };
      for (const raw of result?.tools ?? []) {
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
        if (typeof t.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description.slice(0, 1000) : "",
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object", properties: {} },
          readOnlyHint: t.annotations?.readOnlyHint === true,
        });
        if (tools.length >= 200) return tools;
      }
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** Chama uma ferramenta e devolve o texto do resultado (conteúdo não textual vira uma descrição curta). */
  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const result = (await this.#request("tools/call", { name, arguments: args && typeof args === "object" ? args : {} })) as {
      content?: Array<{ type?: string; text?: unknown; mimeType?: unknown }>;
      structuredContent?: unknown;
      isError?: unknown;
    };
    const parts = (result?.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[conteúdo ${String(c.type ?? "desconhecido")}${c.mimeType ? ` ${String(c.mimeType)}` : ""} omitido]`));
    if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    return { text: parts.join("\n"), isError: result?.isError === true };
  }
}
