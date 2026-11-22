import { MCP_TOOLS, ToolArgumentError, type McpTool, type ToolRequest } from "./tools.ts";

// Servidor MCP do Nexo (ADR-017): transporte HTTP "streamable" sem sessão, só com respostas JSON
// (sem SSE do servidor). Uma mensagem JSON-RPC por requisição; lote não é aceito (a revisão
// 2025-06-18 do protocolo removeu os lotes).

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Teto do texto devolvido ao modelo por chamada; logs longos ficam com o final. */
export const MAX_RESULT_CHARS = 60_000;

const INSTRUCTIONS = [
  "Nexo: painel de pipelines de automação de testes (Azure DevOps e GitHub Actions).",
  "O token vale para uma organização só e tem as permissões do papel de quem o criou; o que o papel não permite volta como erro.",
  "Fluxo típico: get_context, list_workspaces/list_projects, list_integrations, discover_pipelines e link_pipeline.",
  "Antes de run_pipeline, apply_pipeline_file ou cancel_execution, mostre à pessoa o que vai acontecer e peça confirmação.",
  "Integrações, credenciais, membros e papéis se configuram só pelo painel.",
].join(" ");

export interface ApiResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface McpContext {
  /** Executa a rota REST com o mesmo token da requisição MCP. */
  callApi(request: ToolRequest): Promise<ApiResponse>;
  serverVersion: string;
}

type JsonRpcId = string | number;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 } as const;

const fail = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trata uma mensagem. Devolve a resposta JSON-RPC, ou null para notificações e respostas do cliente
 * (que o transporte responde com 202 sem corpo).
 */
export async function handleMcpMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (Array.isArray(message)) return fail(null, ERR.invalidRequest, "Lotes de mensagens não são aceitos; envie uma por requisição.");
  if (!isObject(message) || message.jsonrpc !== "2.0") return fail(null, ERR.invalidRequest, "Mensagem JSON-RPC 2.0 inválida.");

  const hasId = typeof message.id === "string" || typeof message.id === "number";
  // Resposta do cliente a um pedido do servidor (este servidor não faz pedidos): só reconhece.
  if (!("method" in message)) return null;
  if (typeof message.method !== "string") return fail(hasId ? (message.id as JsonRpcId) : null, ERR.invalidRequest, "Campo method ausente.");
  // Notificação (sem id): nada a responder.
  if (!hasId) return null;

  const id = message.id as JsonRpcId;
  const params = isObject(message.params) ? message.params : {};

  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nexo", title: "Nexo", version: ctx.serverVersion },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS.map(describe) });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return fail(id, ERR.methodNotFound, `Método não suportado: ${message.method}`);
  }
}

function describe(tool: McpTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.destructive === true,
      // Repetir uma leitura não muda nada; uma escrita pode criar outro registro.
      idempotentHint: tool.readOnly,
      // O provedor de CI fica fora do Nexo: tocar nele é efeito em mundo aberto.
      openWorldHint: tool.destructive === true,
    },
  };
}

async function callTool(id: JsonRpcId, params: Record<string, unknown>, ctx: McpContext): Promise<JsonRpcResponse> {
  const tool = MCP_TOOLS.find((t) => t.name === params.name);
  if (!tool) return fail(id, ERR.invalidParams, `Ferramenta desconhecida: ${String(params.name)}`);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isObject(args)) return fail(id, ERR.invalidParams, "arguments precisa ser um objeto.");

  let request: ToolRequest;
  try {
    request = tool.request(args);
  } catch (error) {
    if (error instanceof ToolArgumentError) return ok(id, toolResult(error.message, true));
    throw error;
  }

  const res = await ctx.callApi(request);
  const isError = res.status >= 400;
  if (res.status === 204 || res.body === "") return ok(id, toolResult(isError ? `Erro ${res.status}.` : "Feito.", isError));
  const pretty = res.contentType.includes("application/json") ? prettyJson(res.body) : res.body;
  // Erros vêm do REST com { error, message }: o modelo lê a mesma mensagem que o painel mostraria.
  return ok(id, toolResult(truncate(pretty, tool.name === "get_execution_logs"), isError));
}

function toolResult(text: string, isError: boolean) {
  return { content: [{ type: "text", text }], isError };
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Corta saídas grandes. Logs guardam o final (onde costuma estar o erro); o resto guarda o começo. */
function truncate(text: string, keepEnd: boolean): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const note = `[... ${text.length - MAX_RESULT_CHARS} caracteres omitidos ...]`;
  return keepEnd ? `${note}\n${text.slice(-MAX_RESULT_CHARS)}` : `${text.slice(0, MAX_RESULT_CHARS)}\n${note}`;
}
