import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  canPerform,
  DomainError,
  looksLikeAccessToken,
  looksLikeToken,
  OPERATIONS,
  ROLE_MATRIX,
  ROLES,
  type Actor,
  type EmailService,
  type FoundationService,
  type IssuedLink,
  type RequestMeta,
} from "@painel/core";
import { isSecureOrigin, type Config } from "../config.ts";
import { parseCookies, serializeSessionCookie, sessionCookieName } from "../http/cookies.ts";
import { FixedWindowLimiter } from "../http/rate-limit.ts";

// Rotas do incremento 1 (Fundação). Toda operação é autorizada no servidor (RNF-007) pelo
// FoundationService; aqui ficam sessão em cookie, CSRF, validação de entrada e tradução de erros.

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const STATUS: Record<DomainError["code"], number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "rate-limited": 429,
  provider: 502,
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new DomainError("invalid", "Dados inválidos.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export const IdParams = z.object({ id: z.uuid() });
const UserIdParams = z.object({ userId: z.uuid() });
const ListQuery = z.object({
  q: z.string().max(120).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const toFilter = (q: z.infer<typeof ListQuery>) => ({
  ...(q.q ? { q: q.q } : {}),
  includeArchived: q.includeArchived === "true",
});

export function requestMeta(req: FastifyRequest): RequestMeta {
  return {
    correlationId: String(req.id),
    ip: req.ip,
    ...(typeof req.headers["user-agent"] === "string" ? { userAgent: req.headers["user-agent"] } : {}),
  };
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new DomainError("unauthenticated", "Entre para continuar.");
  return req.actor;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerFoundationRoutes(app: FastifyInstance, config: Config, svc: FoundationService, email?: EmailService): void {
  const secure = isSecureOrigin(config);
  const cookieName = sessionCookieName(secure);
  const panelOrigin = new URL(config.PUBLIC_BASE_URL).origin;
  const limiter = new FixedWindowLimiter(config.AUTH_RATE_LIMIT_PER_MINUTE);

  const meta = requestMeta;

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.header("set-cookie", serializeSessionCookie(cookieName, token, { secure, maxAgeSeconds: config.SESSION_ABSOLUTE_HOURS * 3600 }));
  const clearSessionCookie = (reply: FastifyReply) =>
    reply.header("set-cookie", serializeSessionCookie(cookieName, "", { secure, maxAgeSeconds: 0 }));

  const link = (path: string, issued: IssuedLink) => ({
    // O token vai no fragmento (#), que o navegador não envia ao servidor nem em Referer.
    url: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}${path}#token=${issued.token}`,
    expiresAt: issued.expiresAt,
    userId: issued.userId,
  });

  const sessionView = (actor: Actor) => ({
    user: {
      id: actor.user.id,
      email: actor.user.email,
      displayName: actor.user.displayName,
      isInstanceAdmin: actor.user.isInstanceAdmin,
    },
    organization: actor.organization
      ? {
          id: actor.organization.id,
          name: actor.organization.name,
          slug: actor.organization.slug,
          archived: actor.organization.archived,
          role: actor.organization.role,
          // O que o papel permite agora, para a interface decidir o que mostrar; o servidor sempre reavalia.
          permissions: Object.fromEntries(
            OPERATIONS.map((op) => [op, canPerform(actor.organization!.role, op, actor.organization!.policy)]),
          ),
        }
      : null,
    csrfToken: actor.session.csrfToken,
    expiresAt: actor.session.expiresAt,
  });

  // ----- Sessão, CSRF e origem, antes de toda rota /api -----
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    const origin = req.headers.origin;
    if (MUTATING.has(req.method) && origin !== undefined && origin !== panelOrigin) {
      throw new DomainError("forbidden", "Origem não permitida.");
    }
    // Token pessoal de acesso (ADR-017): só no cabeçalho Authorization, e o cookie é ignorado. Não há
    // CSRF a checar: o navegador não envia esse cabeçalho sozinho, então outro site não o forja.
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const bearer = /^Bearer (\S+)$/.exec(authorization)?.[1];
      const actor = bearer && looksLikeAccessToken(bearer) ? await svc.resolveAccessToken(bearer) : undefined;
      if (!actor) throw new DomainError("unauthenticated", "Token de acesso inválido, expirado ou revogado.");
      req.actor = actor;
      return;
    }
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (token && looksLikeToken(token)) {
      const actor = await svc.resolveSession(token);
      if (actor) req.actor = actor;
    }
    if (req.actor && MUTATING.has(req.method)) {
      const header = req.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, req.actor.session.csrfToken)) {
        throw new DomainError("forbidden", "Token CSRF ausente ou inválido. Recarregue a página.");
      }
    }
  });

  const limited = async (req: FastifyRequest) => {
    if (!limiter.take(`${req.ip}:${req.routeOptions.url}`)) {
      throw new DomainError("rate-limited", "Muitas tentativas. Aguarde um minuto e tente de novo.");
    }
  };

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) {
      if (error.code === "unauthenticated" && req.url.startsWith("/api/auth/") === false) clearSessionCookie(reply);
      return reply.code(STATUS[error.code]).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "invalid", message: "Requisição inválida." });
    }
    req.log.error({ err: error }, "erro inesperado");
    return reply.code(500).send({ error: "internal", message: "Erro interno. Informe o id de correlação ao suporte.", correlationId: req.id });
  });

  // ===== Autenticação (públicas) =====

  app.post("/api/auth/login", { preHandler: limited }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(254), password: z.string().max(1024) }), req.body);
    const { token, actor } = await svc.login(body, meta(req));
    setSessionCookie(reply, token);
    return sessionView(actor);
  });

  app.post("/api/auth/invites/accept", { preHandler: limited }, async (req) => {
    const body = parse(
      z.object({ token: z.string().max(100), displayName: z.string().max(120).optional(), password: z.string().max(1024).optional() }),
      req.body,
    );
    return svc.acceptInvite(body, meta(req), req.actor);
  });

  app.post("/api/auth/password-reset/complete", { preHandler: limited }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().max(100), password: z.string().max(1024) }), req.body);
    await svc.completePasswordReset(body, meta(req));
    return reply.code(204).send();
  });

  // ===== Sessão do usuário =====

  app.get("/api/session", async (req) => sessionView(actorOf(req)));

  app.post("/api/auth/logout", async (req, reply) => {
    await svc.logout(actorOf(req), meta(req));
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post("/api/session/organization", async (req) => {
    const body = parse(z.object({ organizationId: z.uuid() }), req.body);
    return sessionView(await svc.switchOrganization(actorOf(req), body.organizationId, meta(req)));
  });

  app.get("/api/sessions", async (req) => ({ items: await svc.listMySessions(actorOf(req)) }));

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await svc.revokeMySession(actorOf(req), id, meta(req));
    return reply.code(204).send();
  });

  // ===== Tokens pessoais de acesso (ADR-017) =====

  app.get("/api/access-tokens", async (req) => ({ items: await svc.listMyAccessTokens(actorOf(req)) }));

  app.post("/api/access-tokens", async (req, reply) => {
    const body = parse(z.object({ name: z.string().max(80), days: z.number().int() }), req.body);
    return reply.code(201).send(await svc.createAccessToken(actorOf(req), body, meta(req)));
  });

  app.delete("/api/access-tokens/:id", async (req, reply) => {
    await svc.revokeMyAccessToken(actorOf(req), parse(IdParams, req.params).id, meta(req));
    return reply.code(204).send();
  });

  app.post("/api/auth/password", async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) }), req.body);
    await svc.changePassword(actorOf(req), body, meta(req));
    return reply.code(204).send();
  });

  // ===== Administração da instância =====

  app.post("/api/admin/password-resets", async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(254) }), req.body);
    const issued = await svc.issuePasswordReset(actorOf(req), body, meta(req));
    const out = link("/redefinir-senha", issued);
    // Com SMTP, o mesmo link vai por e-mail (ADR-011, item 6); continua aparecendo para quem gerou.
    const emailed = email ? await email.sendAccessLink({ kind: "password-reset", organizationId: null, to: body.email.trim(), url: out.url, expiresAt: issued.expiresAt }) : false;
    return reply.code(201).send({ ...out, emailed });
  });

  // ===== Organizações =====

  app.get("/api/organizations", async (req) => {
    const q = parse(ListQuery, req.query);
    return { items: await svc.listMyOrganizations(actorOf(req), toFilter(q)) };
  });

  app.post("/api/organizations", async (req, reply) => {
    const body = parse(z.object({ name: z.string(), slug: z.string() }), req.body);
    return reply.code(201).send(await svc.createOrganization(actorOf(req), body, meta(req)));
  });

  app.get("/api/organization", async (req) => svc.getCurrentOrganization(actorOf(req)));

  app.patch("/api/organization", async (req) => {
    const body = parse(z.object({ name: z.string() }), req.body);
    return svc.updateOrganization(actorOf(req), body, meta(req));
  });

  app.post("/api/organization/archive", async (req) => svc.setOrganizationArchived(actorOf(req), true, meta(req)));
  app.post("/api/organization/unarchive", async (req) => svc.setOrganizationArchived(actorOf(req), false, meta(req)));

  // ===== Workspaces =====

  app.get("/api/workspaces", async (req) => {
    const q = parse(ListQuery, req.query);
    return { items: await svc.listWorkspaces(actorOf(req), toFilter(q)) };
  });

  app.post("/api/workspaces", async (req, reply) => {
    const body = parse(z.object({ name: z.string() }), req.body);
    return reply.code(201).send(await svc.createWorkspace(actorOf(req), body, meta(req)));
  });

  app.get("/api/workspaces/:id", async (req) => svc.getWorkspace(actorOf(req), parse(IdParams, req.params).id));

  app.patch("/api/workspaces/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ name: z.string() }), req.body);
    return svc.updateWorkspace(actorOf(req), id, body, meta(req));
  });

  app.post("/api/workspaces/:id/archive", async (req) =>
    svc.setWorkspaceArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)),
  );
  app.post("/api/workspaces/:id/unarchive", async (req) =>
    svc.setWorkspaceArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  // ===== Projetos =====

  app.get("/api/projects", async (req) => {
    const q = parse(ListQuery.extend({ workspaceId: z.uuid().optional() }), req.query);
    return { items: await svc.listProjects(actorOf(req), { ...toFilter(q), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) }) };
  });

  app.post("/api/projects", async (req, reply) => {
    const body = parse(z.object({ workspaceId: z.uuid(), name: z.string() }), req.body);
    return reply.code(201).send(await svc.createProject(actorOf(req), body, meta(req)));
  });

  app.get("/api/projects/:id", async (req) => svc.getProject(actorOf(req), parse(IdParams, req.params).id));

  app.patch("/api/projects/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ name: z.string().optional(), workspaceId: z.uuid().optional() }), req.body);
    return svc.updateProject(actorOf(req), id, body, meta(req));
  });

  app.post("/api/projects/:id/archive", async (req) => svc.setProjectArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)));
  app.post("/api/projects/:id/unarchive", async (req) =>
    svc.setProjectArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  // ===== Membros e convites =====

  app.get("/api/members", async (req) => ({ items: await svc.listMembers(actorOf(req)) }));

  app.post("/api/invites", async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(254), role: z.string(), displayName: z.string().max(120).optional() }), req.body);
    const actor = actorOf(req);
    const issued = await svc.inviteMember(actor, body, meta(req));
    const out = link("/convite", issued);
    const emailed = email
      ? await email.sendAccessLink({
          kind: "invite",
          organizationId: actor.organization!.id,
          organizationName: actor.organization!.name,
          to: body.email.trim(),
          url: out.url,
          expiresAt: issued.expiresAt,
        })
      : false;
    return reply.code(201).send({ ...out, emailed });
  });

  app.patch("/api/members/:userId", async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params);
    const body = parse(z.object({ role: z.string() }), req.body);
    await svc.changeMemberRole(actorOf(req), userId, body.role, meta(req));
    return reply.code(204).send();
  });

  app.delete("/api/members/:userId", async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params);
    await svc.removeMember(actorOf(req), userId, meta(req));
    return reply.code(204).send();
  });

  // ===== Política de papéis e auditoria =====

  app.get("/api/access-policy", async (req) => svc.getAccessPolicy(actorOf(req)));

  // Matriz de papéis do §6: o que cada papel pode sempre, nunca, ou "conforme política" (o que a
  // organização concede em access-policy). Fonte única para a tela de administração.
  app.get("/api/access-matrix", async (req) => {
    actorOf(req);
    return { roles: ROLES, operations: OPERATIONS, matrix: ROLE_MATRIX };
  });

  app.put("/api/access-policy", async (req) => {
    const body = parse(z.record(z.string(), z.array(z.string())), req.body);
    return svc.updateAccessPolicy(actorOf(req), body, meta(req));
  });

  app.get("/api/audit", async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(80).optional(),
        actorUserId: z.uuid().optional(),
        outcome: z.enum(["success", "denied", "failed"]).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        before: z.string().regex(/^\d{1,19}$/).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    const items = await svc.listAudit(actorOf(req), q, meta(req));
    return { items, next: items.length === (q.limit ?? 50) ? items.at(-1)?.id : null };
  });
}
