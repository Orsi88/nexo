import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AssistService, EmailService, ExecutionService, FoundationService, NotificationService, OnboardingService, ResultsService, SharingService } from "@painel/core";
import { registerAssistRoutes } from "./routes/assist.ts";
import { registerMcpRoutes } from "./routes/mcp.ts";
import { registerSharingRoutes } from "./routes/sharing.ts";
import type { EventHub } from "./events.ts";
import type { Config } from "./config.ts";
import { registerFoundationRoutes } from "./routes/foundation.ts";
import { registerOnboardingRoutes } from "./routes/onboarding.ts";
import { registerExecutionRoutes } from "./routes/execution.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerResultsRoutes } from "./routes/results.ts";

export interface Dependencies {
  /** Verifica se o banco responde; ausente quando DATABASE_URL não foi configurada. */
  checkDatabase?: () => Promise<void>;
  /** Casos de uso da fundação (incremento 1); ausente sem banco: as rotas /api de negócio não sobem. */
  foundation?: FoundationService;
  /** Integrações e pipelines (incremento 2); precisa de foundation e de SECRETS_MASTER_KEY. */
  onboarding?: OnboardingService;
  /** Execução e concorrência (incremento 3); mesmas condições de onboarding. */
  execution?: ExecutionService;
  /** Regras de evento e avisos; só precisa da fundação. */
  notifications?: NotificationService;
  /** Resultados de testes (incremento 5); só precisa da fundação. */
  results?: ResultsService;
  /** Eventos do banco para o SSE (ADR-010). */
  events?: EventHub;
  /** Links compartilhados e configurações da organização (incremento 7); só precisa da fundação. */
  sharing?: SharingService;
  /** E-mail (incremento 7): status, histórico, teste e links de acesso por e-mail. */
  email?: EmailService;
  /** IA própria + MCP (incremento 8); precisa de SECRETS_MASTER_KEY, como as integrações. */
  assist?: AssistService;
}

function baseServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Nunca registrar credenciais (RN-017, RNF-033).
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    // Correlação ponta a ponta (RNF-013).
    // Aceita o id do cliente só num formato seguro para logs e auditoria; senão gera um.
    genReqId: (req) => {
      const given = req.headers["x-correlation-id"];
      return typeof given === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(given) ? given : randomUUID();
    },
    requestIdHeader: false,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });
  // JSON vazio vale como "sem corpo": clientes mandam content-type JSON até em DELETE sem corpo, e o
  // padrão do Fastify recusava com 400 (revogar token e remover membro falhavam no painel).
  // O resto vai para o parser padrão, que mantém a proteção contra __proto__ e o 400 de JSON malformado.
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (String(body).trim() === "") return done(null, undefined);
    defaultJson(req, body as string, done);
  });
  return app;
}

/** Servidor do painel: API, SSE e webhooks. Incremento 1: autenticação, organizações e auditoria. */
export function buildApiServer(config: Config, deps: Dependencies = {}): FastifyInstance {
  const app = baseServer(config);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-correlation-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    // Respostas da API carregam dados de sessão e de tenant: nunca em cache compartilhado.
    if (req.url.startsWith("/api")) reply.header("cache-control", "no-store");
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_req, reply) => {
    if (!deps.checkDatabase) return reply.code(503).send({ status: "unavailable", reason: "DATABASE_URL não configurada" });
    try {
      await deps.checkDatabase();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable", reason: "banco indisponível" });
    }
  });

  app.get("/api", async () => ({ name: "painel-pipelines", mode: "api" }));

  if (deps.foundation) {
    registerFoundationRoutes(app, config, deps.foundation, deps.email);
    // Servidor MCP (ADR-017): só reaproveita as rotas registradas aqui, com o token da requisição.
    registerMcpRoutes(app);
    if (deps.sharing && deps.email) registerSharingRoutes(app, config, deps.sharing, deps.email);
    if (deps.assist) registerAssistRoutes(app, deps.assist);
    if (deps.onboarding) registerOnboardingRoutes(app, deps.onboarding);
    if (deps.execution) registerExecutionRoutes(app, deps.execution, deps.events);
    if (deps.notifications) registerNotificationRoutes(app, deps.notifications);
    if (deps.results) registerResultsRoutes(app, deps.results);
  }

  return app;
}

/**
 * Origem isolada para relatórios HTML de terceiros (ADR-007, RNF-024, CA-012).
 * Não emite nem aceita cookies do painel; toda resposta vai com CSP "sandbox", que trata o
 * documento como origem opaca, sem acesso a cookies ou armazenamento de outra origem.
 */
export function buildReportOriginServer(config: Config): FastifyInstance {
  const app = baseServer(config);

  app.addHook("onSend", async (_req, reply) => {
    reply.header(
      "content-security-policy",
      "sandbox allow-scripts allow-popups; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors " +
        new URL(config.PUBLIC_BASE_URL).origin,
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-site");
    reply.removeHeader("set-cookie");
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  // Incremento 5: servir artefatos do object storage por URL assinada de curta duração.
  app.get("/r/*", async (_req, reply) =>
    reply.code(501).send({ status: "not-implemented", reason: "visualizador de relatórios entra no incremento 5" }),
  );

  return app;
}
