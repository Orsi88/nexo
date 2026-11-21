import Anthropic from "@anthropic-ai/sdk";

// Provedores de IA escolhidos pela organização (BYOAI/BYOK, RF-172, RF-173; ADR-016). Dois tipos:
//
// - "anthropic": Claude pelo SDK oficial. A conversa guarda as respostas como vieram (blocos de
//   pensamento, fallback), e os resultados das ferramentas voltam todos numa mensagem só.
// - "openai-compatible": qualquer API no formato Chat Completions (OpenAI, Azure OpenAI com
//   endpoint compatível, Ollama, LM Studio, OpenRouter, vLLM...). Não presume que todo modelo
//   chame ferramentas bem (§19.5): o teste de conexão e a validação da proposta dizem se funcionou.
//
// A chave chega aqui já aberta pelo cofre e não sai deste módulo: nunca entra em prompt, log ou erro.

export type AiProviderKind = "anthropic" | "openai-compatible";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiProviderConfig {
  kind: AiProviderKind;
  /** Base da API; vazio = padrão do tipo (api.anthropic.com para "anthropic"). */
  endpoint: string;
  model: string;
  apiKey: string;
  /** Esforço de raciocínio (Claude atual). Ausente = padrão do modelo. */
  effort?: Effort | undefined;
}

export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema do input. */
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AiTurn {
  text: string;
  toolCalls: AiToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  /** Motivo legível quando o modelo recusou (categoria do provedor). */
  refusal?: string | undefined;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** Uma conversa com ferramentas. Cada adaptador guarda o histórico no formato nativo do provedor. */
export interface AiConversation {
  start(userText: string): Promise<AiTurn>;
  /** Devolve os resultados de todas as chamadas da última resposta (e, opcional, um texto do usuário). */
  continue(results: ToolResult[], userText?: string): Promise<AiTurn>;
}

export interface AiProvider {
  readonly kind: AiProviderKind;
  /** Confere chave, endereço e modelo, gastando o mínimo possível. */
  test(): Promise<{ ok: boolean; message: string }>;
  conversation(options: { system: string; tools: AiToolSpec[]; maxTokens?: number; signal?: AbortSignal }): AiConversation;
}

/** Erro do provedor de IA já traduzido para a pessoa, sem a chave nem o corpo da requisição. */
export class AiProviderError extends Error {
  readonly kind: "auth" | "rate-limit" | "not-found" | "unavailable" | "invalid" | "refusal";
  constructor(kind: AiProviderError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

const DEFAULT_MAX_TOKENS = 16000;
const TIMEOUT_MS = 180_000;

export function createAiProvider(config: AiProviderConfig): AiProvider {
  return config.kind === "anthropic" ? anthropicProvider(config) : openAiCompatibleProvider(config);
}

// ---------------------------------------------------------------------------------------------
// Anthropic (SDK oficial)
// ---------------------------------------------------------------------------------------------

/** Modelos atuais em que a API aceita o fallback do servidor quando o modelo recusa. */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function isOfficialAnthropic(endpoint: string): boolean {
  if (!endpoint) return true;
  try {
    return new URL(endpoint).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function anthropicError(error: unknown): AiProviderError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError("auth", "A chave da Anthropic foi recusada ou não tem permissão para este modelo.");
  }
  if (error instanceof Anthropic.NotFoundError) return new AiProviderError("not-found", "Modelo não encontrado na Anthropic. Confira o nome do modelo.");
  if (error instanceof Anthropic.RateLimitError) return new AiProviderError("rate-limit", "A Anthropic limitou as chamadas desta chave agora. Tente de novo em instantes.");
  if (error instanceof Anthropic.BadRequestError) return new AiProviderError("invalid", `A Anthropic recusou o pedido: ${error.message.slice(0, 300)}`);
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError("unavailable", "Não foi possível falar com a API da Anthropic (rede ou endereço).");
  if (error instanceof Anthropic.APIError) return new AiProviderError("unavailable", `A Anthropic respondeu com erro ${error.status ?? ""}.`.trim());
  return new AiProviderError("unavailable", error instanceof Error ? error.message.slice(0, 300) : "Erro ao chamar a Anthropic.");
}

function anthropicProvider(config: AiProviderConfig): AiProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.endpoint ? { baseURL: config.endpoint.replace(/\/$/, "") } : {}),
    maxRetries: 2,
    timeout: TIMEOUT_MS,
  });
  // Recusa de política: a própria API tenta de novo num modelo de reserva, dentro da mesma chamada.
  const fallback = isOfficialAnthropic(config.endpoint) && FALLBACK_MODELS.has(config.model);

  return {
    kind: "anthropic",
    async test() {
      try {
        const model = await client.models.retrieve(config.model);
        return { ok: true, message: `Conectado. Modelo ${model.display_name ?? model.id} disponível.` };
      } catch (error) {
        return { ok: false, message: anthropicError(error).message };
      }
    },
    conversation({ system, tools, maxTokens, signal }) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [];
      const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));
      const send = async (): Promise<AiTurn> => {
        let response: Anthropic.Beta.BetaMessage;
        try {
          response = await client.beta.messages.create(
            {
              model: config.model,
              max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
              system,
              tools: toolDefs,
              tool_choice: { type: "auto" },
              messages,
              ...(config.effort ? { output_config: { effort: config.effort } } : {}),
              ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
            },
            signal ? { signal } : undefined,
          );
        } catch (error) {
          throw anthropicError(error);
        }
        // A resposta volta inteira para o histórico (pensamento e fallback incluídos).
        messages.push({ role: "assistant", content: response.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const toolCalls = response.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === "refusal") {
          const category = response.stop_details?.category;
          return { text, toolCalls: [], stop: "refusal", refusal: category ? `o modelo recusou (${category})` : "o modelo recusou o pedido", usage };
        }
        const stop = response.stop_reason === "tool_use" ? "tool_use" : response.stop_reason === "end_turn" ? "end" : response.stop_reason === "max_tokens" ? "max_tokens" : "other";
        return { text, toolCalls, stop, usage };
      };
      return {
        async start(userText) {
          messages.push({ role: "user", content: userText });
          return send();
        },
        async continue(results, userText) {
          const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          }));
          if (userText) content.push({ type: "text", text: userText });
          messages.push({ role: "user", content });
          return send();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Compatível com OpenAI (Chat Completions)
// ---------------------------------------------------------------------------------------------

interface OaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function openAiCompatibleProvider(config: AiProviderConfig): AiProvider {
  const base = config.endpoint.replace(/\/$/, "");
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  });
  const call = async (path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, headers: headers(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
    } catch {
      throw new AiProviderError("unavailable", "Não foi possível falar com a API de IA (rede ou endereço).");
    }
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new AiProviderError("auth", "A chave foi recusada pela API de IA.");
    if (res.status === 404) throw new AiProviderError("not-found", "Endereço ou modelo não encontrado na API de IA.");
    if (res.status === 429) throw new AiProviderError("rate-limit", "A API de IA limitou as chamadas agora. Tente de novo em instantes.");
    if (!res.ok) {
      const detail = typeof (body as { error?: { message?: unknown } })?.error?.message === "string" ? (body as { error: { message: string } }).error.message.slice(0, 300) : "";
      throw new AiProviderError(res.status < 500 ? "invalid" : "unavailable", `A API de IA respondeu ${res.status}${detail ? `: ${detail}` : ""}.`);
    }
    return body;
  };

  return {
    kind: "openai-compatible",
    async test() {
      try {
        const list = (await call("/models", { method: "GET" })) as { data?: Array<{ id?: string }> };
        const ids = Array.isArray(list?.data) ? list.data.map((m) => m.id).filter(Boolean) : [];
        if (ids.length && !ids.includes(config.model)) return { ok: false, message: `Conectado, mas o modelo "${config.model}" não está na lista desta API.` };
        return { ok: true, message: ids.length ? `Conectado. Modelo ${config.model} disponível.` : "Conectado (a API não lista modelos; o nome será conferido no primeiro uso)." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Falha ao testar." };
      }
    },
    conversation({ system, tools, maxTokens, signal }) {
      const messages: OaMessage[] = [{ role: "system", content: system }];
      const toolDefs = tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const send = async (): Promise<AiTurn> => {
        const body = (await call(
          "/chat/completions",
          { method: "POST", body: JSON.stringify({ model: config.model, messages, tools: toolDefs, tool_choice: "auto", max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS }) },
          signal,
        )) as {
          choices?: Array<{ message?: OaMessage; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = body?.choices?.[0];
        if (!choice?.message) throw new AiProviderError("invalid", "A API de IA devolveu uma resposta sem mensagem.");
        const msg = choice.message;
        messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        const toolCalls = (msg.tool_calls ?? []).map((tc) => {
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            input = { __invalidJson: tc.function.arguments?.slice(0, 2000) ?? "" };
          }
          return { id: tc.id, name: tc.function.name, input };
        });
        const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
        const reason = choice.finish_reason;
        const stop = toolCalls.length ? "tool_use" : reason === "length" ? "max_tokens" : reason === "content_filter" ? "refusal" : reason === "stop" ? "end" : "other";
        return { text: (msg.content ?? "").trim(), toolCalls, stop, ...(stop === "refusal" ? { refusal: "o filtro de conteúdo do provedor bloqueou a resposta" } : {}), usage };
      };
      return {
        async start(userText) {
          messages.push({ role: "user", content: userText });
          return send();
        },
        async continue(results, userText) {
          for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERRO: ${r.content}` : r.content });
          if (userText) messages.push({ role: "user", content: userText });
          return send();
        },
      };
    },
  };
}
