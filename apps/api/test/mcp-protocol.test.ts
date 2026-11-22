import { describe, expect, it } from "vitest";
import { handleMcpMessage, LATEST_PROTOCOL_VERSION, MAX_RESULT_CHARS, type ApiResponse, type McpContext } from "../src/mcp/protocol.ts";
import { MCP_TOOLS, type ToolRequest } from "../src/mcp/tools.ts";

// Protocolo do servidor MCP (ADR-017) sem banco: JSON-RPC, catálogo de ferramentas e tradução das
// chamadas para as rotas REST. A autenticação e as permissões são testadas em access-tokens-http.

const PIPELINE = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";

function context(response: Partial<ApiResponse> = {}) {
  const calls: ToolRequest[] = [];
  const ctx: McpContext = {
    serverVersion: "test",
    callApi: async (request) => {
      calls.push(request);
      return { status: 200, contentType: "application/json; charset=utf-8", body: "{}", ...response };
    },
  };
  return { ctx, calls };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("servidor MCP: protocolo", () => {
  it("negocia a versão no initialize", async () => {
    const { ctx } = context();
    const known = await handleMcpMessage(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} }), ctx);
    expect(known?.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "nexo" } });
    const unknown = await handleMcpMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), ctx);
    expect(unknown?.result).toMatchObject({ protocolVersion: LATEST_PROTOCOL_VERSION });
  });

  it("não responde notificações nem respostas do cliente", async () => {
    const { ctx } = context();
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 9, result: {} }, ctx)).toBeNull();
  });

  it("recusa lote, mensagem inválida e método desconhecido", async () => {
    const { ctx } = context();
    expect((await handleMcpMessage([rpc("ping")], ctx))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ id: 1, method: "ping" }, ctx))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage(rpc("resources/list"), ctx))?.error?.code).toBe(-32601);
    expect((await handleMcpMessage(rpc("ping"), ctx))?.result).toEqual({});
  });

  it("lista as ferramentas com esquema e anotações", async () => {
    const { ctx } = context();
    const res = await handleMcpMessage(rpc("tools/list"), ctx);
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema: { type: string }; annotations: Record<string, boolean> }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    expect(tools.find((t) => t.name === "run_pipeline")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === "list_projects")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("nunca expõe credenciais, membros, papéis nem tokens", () => {
    const urls = MCP_TOOLS.map((t) => t.name).join(" ");
    expect(urls).not.toMatch(/credential|member|invite|role|policy|token|integration_create/);
  });

  it("traduz a chamada para a rota REST, sem campos extras", async () => {
    const { ctx, calls } = context({ status: 201, body: JSON.stringify({ id: "x" }) });
    const res = await handleMcpMessage(
      rpc("tools/call", { name: "link_pipeline", arguments: { projectId: PIPELINE, integrationId: PIPELINE, externalId: "42" } }),
      ctx,
    );
    expect(calls).toEqual([{ method: "POST", url: "/api/pipelines", payload: { projectId: PIPELINE, integrationId: PIPELINE, externalId: "42" } }]);
    expect(res?.result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining('"id": "x"') }] });
  });

  it("monta a query só com o que veio", async () => {
    const { ctx, calls } = context();
    await handleMcpMessage(rpc("tools/call", { name: "discover_pipelines", arguments: { integrationId: PIPELINE, q: "docs e testes" } }), ctx);
    expect(calls[0]?.url).toBe(`/api/integrations/${PIPELINE}/discover?q=docs+e+testes`);
  });

  it("devolve argumento inválido como resultado com erro, sem chamar a API", async () => {
    const { ctx, calls } = context();
    const res = await handleMcpMessage(rpc("tools/call", { name: "get_pipeline", arguments: { pipelineId: "../admin" } }), ctx);
    expect(calls).toHaveLength(0);
    expect(res?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("pipelineId") }] });
  });

  it("repassa o erro do REST (permissão negada) como resultado com erro", async () => {
    const { ctx } = context({ status: 403, body: JSON.stringify({ error: "forbidden", message: "Seu papel nesta organização não permite esta operação." }) });
    const res = await handleMcpMessage(rpc("tools/call", { name: "create_workspace", arguments: { name: "QA" } }), ctx);
    expect(res?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("não permite") }] });
  });

  it("recusa ferramenta desconhecida e arguments que não são objeto", async () => {
    const { ctx } = context();
    expect((await handleMcpMessage(rpc("tools/call", { name: "drop_database" }), ctx))?.error?.code).toBe(-32602);
    expect((await handleMcpMessage(rpc("tools/call", { name: "get_context", arguments: [1] }), ctx))?.error?.code).toBe(-32602);
  });

  it("corta logs longos guardando o final", async () => {
    const log = `${"x".repeat(MAX_RESULT_CHARS)}FIM-DO-LOG`;
    const { ctx } = context({ contentType: "text/plain; charset=utf-8", body: log });
    const res = await handleMcpMessage(rpc("tools/call", { name: "get_execution_logs", arguments: { executionId: PIPELINE } }), ctx);
    const text = (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text.endsWith("FIM-DO-LOG")).toBe(true);
    expect(text).toContain("caracteres omitidos");
  });
});
