import { randomUUID } from "node:crypto";
import { Database, isUniqueViolation, type Sql } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import { canPerform, getPolicy, ROLES, savePolicy, type Operation, type OrganizationPolicy, type Role } from "../modules/access/index.ts";
import { listAudit, recordAudit, type AuditEvent, type AuditEventInput, type AuditQuery } from "../modules/audit/index.ts";
import {
  DEFAULT_ARGON2,
  dummyPasswordHash,
  hashPassword,
  identity,
  passwordProblem,
  verifyPassword,
  type Argon2Params,
  type Session,
  type User,
} from "../modules/identity/index.ts";
import { SLUG_PATTERN, tenancy, type ListFilter, type Organization, type Project, type Workspace } from "../modules/tenancy/index.ts";

// Casos de uso do incremento 1 (Fundação): login local, sessões, organizações, workspaces, projetos,
// membros, papéis e auditoria. Compõe os módulos pela API pública de cada um (ADR-001).
// Decisões de acesso: ADR-011.

export interface FoundationConfig {
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  inviteTtlHours: number;
  passwordResetTtlHours: number;
  maxFailedLogins: number;
  lockMinutes: number;
  argon2: Argon2Params;
}

export const DEFAULT_FOUNDATION_CONFIG: FoundationConfig = {
  sessionIdleMinutes: 8 * 60,
  sessionAbsoluteHours: 7 * 24,
  inviteTtlHours: 72,
  passwordResetTtlHours: 24,
  maxFailedLogins: 5,
  lockMinutes: 15,
  argon2: DEFAULT_ARGON2,
};

export interface RequestMeta {
  correlationId: string;
  ip?: string;
  userAgent?: string;
}

/** Quem está agindo: sessão válida, usuário e, se houver, a organização em uso com o papel atual. */
export interface Actor {
  session: Session;
  user: User;
  organization?: { id: string; name: string; slug: string; archived: boolean; role: Role; policy: OrganizationPolicy };
}

export interface OrgActor extends Actor {
  organization: NonNullable<Actor["organization"]>;
}

export interface MemberView {
  userId: string;
  displayName: string;
  /** Só para quem pode gerenciar usuários (dado pessoal, §5.1). */
  email?: string;
  status: User["status"];
  role: Role;
  since: Date;
  invitePending: boolean;
}

export interface IssuedLink {
  token: string;
  expiresAt: Date;
  userId: string;
}

/** Validade máxima de um token pessoal de acesso (ADR-017). */
export const ACCESS_TOKEN_MAX_DAYS = 365;

/** Token pessoal de acesso como aparece para o dono (ADR-017). O valor do token nunca está aqui. */
export interface AccessTokenView {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  createdAt: Date;
  /** Última vez que o token foi usado (precisão de um minuto). */
  lastUsedAt: Date;
  expiresAt: Date;
}

const INVALID_LOGIN =
  "E-mail ou senha inválidos. Depois de várias tentativas seguidas, o acesso fica bloqueado por alguns minutos.";

function requireName(value: unknown, what: string, max = 120): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new DomainError("invalid", `Informe o nome do(a) ${what}.`);
  if (name.length > max) throw new DomainError("invalid", `O nome do(a) ${what} pode ter no máximo ${max} caracteres.`);
  return name;
}

function requireEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new DomainError("invalid", "Informe um e-mail válido.");
  return email;
}

function requireRole(value: unknown): Role {
  if (!(ROLES as readonly unknown[]).includes(value)) throw new DomainError("invalid", `Papel inválido. Use: ${ROLES.join(", ")}.`);
  return value as Role;
}

function requirePassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  const problem = passwordProblem(password);
  if (problem) throw new DomainError("invalid", problem);
  return password;
}

export class FoundationService {
  readonly db: Database;
  readonly config: FoundationConfig;

  constructor(db: Database, config: Partial<FoundationConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_FOUNDATION_CONFIG, ...config };
  }

  // =====================================================================
  // Instalação
  // =====================================================================

  /**
   * Primeiro acesso da instalação (ADR-011): cria o administrador da instância e a primeira
   * organização, e devolve um link de uso único para ele definir a senha. Recusa se já houver admin.
   */
  async bootstrapInstance(
    input: { adminEmail: string; adminName: string; organizationName: string; organizationSlug: string },
    meta: RequestMeta,
  ): Promise<{ userId: string; organizationId: string; link: IssuedLink }> {
    const email = requireEmail(input.adminEmail);
    const name = requireName(input.adminName, "administrador");
    const orgName = requireName(input.organizationName, "organização");
    const slug = this.requireSlug(input.organizationSlug);
    const organizationId = randomUUID();

    return this.db.tx({ organizationId }, async (sql) => {
      // Serializa bootstraps concorrentes.
      await sql.query("SELECT pg_advisory_xact_lock(hashtext('painel.bootstrap'))");
      if ((await identity.countInstanceAdmins(sql)) > 0) {
        throw new DomainError("conflict", "A instalação já tem um administrador. Use um convite ou um link de redefinição.");
      }
      if (await identity.getUserByEmail(sql, email)) throw new DomainError("conflict", "Já existe um usuário com esse e-mail.");
      const user = await identity.createUser(sql, { email, displayName: name, status: "invited", isInstanceAdmin: true });
      await this.insertOrganization(sql, organizationId, slug, orgName);
      await tenancy.insertMembership(sql, organizationId, user.id, "admin");
      const issued = await identity.issueOneTimeToken(sql, {
        kind: "password-reset",
        userId: user.id,
        createdBy: null,
        ttlHours: this.config.passwordResetTtlHours,
      });
      const base = { actorUserId: null, actorKind: "system" as const, outcome: "success" as const, correlationId: meta.correlationId };
      await recordAudit(sql, { ...base, organizationId: null, action: "instance.bootstrap", targetType: "user", targetId: user.id });
      await recordAudit(sql, { ...base, organizationId, action: "organization.create", targetType: "organization", targetId: organizationId, details: { slug } });
      return { userId: user.id, organizationId, link: { ...issued, userId: user.id } };
    });
  }

  // =====================================================================
  // Autenticação e sessões (RF-131, RF-132, RNF-026)
  // =====================================================================

  async login(input: { email: unknown; password: unknown }, meta: RequestMeta): Promise<{ token: string; actor: Actor }> {
    const email = typeof input.email === "string" ? input.email : "";
    const password = typeof input.password === "string" ? input.password.slice(0, 1024) : "";
    const creds = email ? await this.db.tx({}, (sql) => identity.findUserCredentials(sql, email)) : undefined;

    const fail = async (reason: string, userId: string | null) => {
      await this.db.tx({}, async (sql) => {
        let locked = false;
        if (userId && reason === "wrong-password") {
          locked = await identity.registerFailedLogin(sql, userId, this.config.maxFailedLogins, this.config.lockMinutes);
        }
        await recordAudit(sql, {
          organizationId: null,
          actorUserId: userId,
          action: "auth.login",
          targetType: "user",
          targetId: userId,
          outcome: "denied",
          correlationId: meta.correlationId,
          details: { reason, locked, ip: meta.ip ?? null },
        });
      });
      throw new DomainError("unauthenticated", INVALID_LOGIN);
    };

    // Sem conta, sem senha definida ou desativada: mesmo custo e mesma resposta (não revela contas).
    if (!creds || !creds.passwordHash || creds.status !== "active") {
      await verifyPassword(password, await dummyPasswordHash());
      return fail(creds ? `status-${creds.passwordHash ? creds.status : "no-password"}` : "unknown-email", creds?.id ?? null);
    }
    if (creds.lockedUntil && creds.lockedUntil > new Date()) {
      await verifyPassword(password, await dummyPasswordHash());
      return fail("locked", creds.id);
    }
    if (!(await verifyPassword(password, creds.passwordHash))) return fail("wrong-password", creds.id);

    const { token, session } = await this.db.tx({ userId: creds.id }, async (sql) => {
      await identity.clearFailedLogins(sql, creds.id);
      const orgs = await tenancy.listOrganizationsOfUser(sql, creds.id);
      const created = await identity.createSession(sql, {
        userId: creds.id,
        activeOrganizationId: orgs[0]?.id ?? null,
        absoluteHours: this.config.sessionAbsoluteHours,
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
        ...(meta.ip ? { ip: meta.ip } : {}),
      });
      await recordAudit(sql, {
        organizationId: null,
        actorUserId: creds.id,
        action: "auth.login",
        targetType: "session",
        targetId: created.session.id,
        outcome: "success",
        correlationId: meta.correlationId,
        details: { ip: meta.ip ?? null },
      });
      return created;
    });
    const actor = await this.actorFor(session);
    if (!actor) throw new DomainError("unauthenticated", INVALID_LOGIN);
    return { token, actor };
  }

  /** Sessão do token, com o papel reavaliado a cada chamada: revogar acesso vale na hora (RF-140). */
  async resolveSession(token: string): Promise<Actor | undefined> {
    const session = await this.db.tx({}, (sql) => identity.findActiveSession(sql, token, this.config.sessionIdleMinutes));
    return session && this.actorFor(session);
  }

  /** Token pessoal de acesso (ADR-017), com o papel reavaliado a cada chamada, como a sessão. */
  async resolveAccessToken(token: string): Promise<Actor | undefined> {
    const session = await this.db.tx({}, (sql) => identity.findActiveAccessToken(sql, token));
    return session && this.actorFor(session);
  }

  private async actorFor(session: Session): Promise<Actor | undefined> {
    return this.db.tx({ userId: session.userId, organizationId: session.activeOrganizationId }, async (sql) => {
      const user = await identity.getUser(sql, session.userId);
      if (!user || user.status !== "active") return undefined;
      if (!session.activeOrganizationId) return { session, user };
      const membership = await tenancy.getMembership(sql, session.activeOrganizationId, user.id);
      const org = membership && (await tenancy.getOrganization(sql, session.activeOrganizationId));
      if ((!membership || !org) && session.kind === "access-token") {
        // O token vale só para a organização em que nasceu: sem ela, é revogado.
        await identity.revokeAccessTokenById(sql, session.id);
        return undefined;
      }
      if (!membership || !org) {
        // Perdeu o acesso: a sessão continua, mas sem organização em uso.
        await identity.setSessionOrganization(sql, session.id, null);
        return { session: { ...session, activeOrganizationId: null }, user };
      }
      return {
        session,
        user,
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          archived: org.archivedAt !== null,
          role: membership.role,
          policy: await getPolicy(sql, org.id),
        },
      };
    });
  }

  async logout(actor: Actor, meta: RequestMeta): Promise<void> {
    await this.db.tx({ userId: actor.user.id }, async (sql) => {
      await identity.revokeSession(sql, actor.user.id, actor.session.id);
      await this.auditInstance(sql, actor, meta, "auth.logout", "session", actor.session.id);
    });
  }

  async listMySessions(actor: Actor): Promise<Array<Omit<Session, "csrfToken"> & { current: boolean }>> {
    const sessions = await this.db.tx({ userId: actor.user.id }, (sql) => identity.listSessions(sql, actor.user.id));
    return sessions.map(({ csrfToken: _csrf, ...s }) => ({ ...s, current: s.id === actor.session.id }));
  }

  async revokeMySession(actor: Actor, sessionId: string, meta: RequestMeta): Promise<void> {
    await this.db.tx({ userId: actor.user.id }, async (sql) => {
      if (!(await identity.revokeSession(sql, actor.user.id, sessionId, "browser"))) throw notFound("Sessão");
      await this.auditInstance(sql, actor, meta, "auth.session.revoke", "session", sessionId);
    });
  }

  // =====================================================================
  // Tokens pessoais de acesso (ADR-017): para clientes de API e MCP
  // =====================================================================

  /**
   * Cria um token preso à organização em uso, com as permissões do papel de quem cria (reavaliadas a
   * cada chamada). Só pela sessão do navegador: um token não cria outro token.
   */
  async createAccessToken(actor: Actor, input: { name: unknown; days: unknown }, meta: RequestMeta): Promise<{ token: string; accessToken: AccessTokenView }> {
    if (actor.session.kind !== "browser") throw new DomainError("forbidden", "Tokens de acesso só podem ser criados pelo painel.");
    const a = this.requireOrg(actor);
    const name = requireName(input.name, "token", 80);
    const days = typeof input.days === "number" && Number.isInteger(input.days) ? input.days : NaN;
    if (!(days >= 1 && days <= ACCESS_TOKEN_MAX_DAYS)) {
      throw new DomainError("invalid", `A validade do token vai de 1 a ${ACCESS_TOKEN_MAX_DAYS} dias.`);
    }
    return this.db.tx(this.scope(a), async (sql) => {
      const created = await identity.createAccessToken(sql, {
        userId: a.user.id,
        organizationId: a.organization.id,
        name,
        days,
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
        ...(meta.ip ? { ip: meta.ip } : {}),
      });
      await this.auditOrg(sql, a.organization.id, a, meta, "auth.token.create", "access-token", created.session.id, "success", { name, days });
      return { token: created.token, accessToken: { ...this.tokenView(created.session), organizationName: a.organization.name } };
    });
  }

  /** Tokens ativos da própria conta, em todas as organizações. O valor do token nunca volta. */
  async listMyAccessTokens(actor: Actor): Promise<AccessTokenView[]> {
    const [tokens, orgs] = await this.db.tx({ userId: actor.user.id }, async (sql) => [
      await identity.listSessions(sql, actor.user.id, "access-token"),
      await tenancy.listOrganizationsOfUser(sql, actor.user.id),
    ] as const);
    const names = new Map(orgs.map((o) => [o.id, o.name]));
    return tokens.map((t) => ({ ...this.tokenView(t), organizationName: names.get(t.activeOrganizationId ?? "") ?? "—" }));
  }

  async revokeMyAccessToken(actor: Actor, tokenId: string, meta: RequestMeta): Promise<void> {
    await this.db.tx({ userId: actor.user.id }, async (sql) => {
      if (!(await identity.revokeSession(sql, actor.user.id, tokenId, "access-token"))) throw notFound("Token");
      await this.auditInstance(sql, actor, meta, "auth.token.revoke", "access-token", tokenId);
    });
  }

  private tokenView(s: Session): Omit<AccessTokenView, "organizationName"> {
    return {
      id: s.id,
      name: s.name ?? "",
      organizationId: s.activeOrganizationId ?? "",
      createdAt: s.createdAt,
      lastUsedAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
    };
  }

  /** Troca a senha da própria conta; encerra as outras sessões. */
  async changePassword(actor: Actor, input: { currentPassword: unknown; newPassword: unknown }, meta: RequestMeta): Promise<void> {
    const next = requirePassword(input.newPassword);
    const creds = await this.db.tx({}, (sql) => identity.findUserCredentials(sql, actor.user.email));
    const current = typeof input.currentPassword === "string" ? input.currentPassword : "";
    if (!creds?.passwordHash || !(await verifyPassword(current, creds.passwordHash))) {
      await this.db.tx({}, (sql) => this.auditInstance(sql, actor, meta, "auth.password.change", "user", actor.user.id, "denied"));
      throw new DomainError("invalid", "A senha atual não confere.");
    }
    const hash = await hashPassword(next, this.config.argon2);
    await this.db.tx({ userId: actor.user.id }, async (sql) => {
      await identity.setPasswordHash(sql, actor.user.id, hash);
      const revoked = await identity.revokeUserSessions(sql, actor.user.id, actor.session.id);
      await this.auditInstance(sql, actor, meta, "auth.password.change", "user", actor.user.id, "success", { revokedSessions: revoked });
    });
  }

  /** Conclui a redefinição de senha pelo link de uso único; encerra todas as sessões da conta. */
  async completePasswordReset(input: { token: unknown; password: unknown }, meta: RequestMeta): Promise<void> {
    const password = requirePassword(input.password);
    const hash = await hashPassword(password, this.config.argon2);
    await this.db.tx({}, async (sql) => {
      const t = typeof input.token === "string" ? await identity.lockValidOneTimeToken(sql, input.token, "password-reset") : undefined;
      if (!t) throw new DomainError("invalid", "Link inválido ou expirado. Peça um novo ao administrador.");
      await identity.setPasswordHash(sql, t.userId, hash);
      await identity.markOneTimeTokenUsed(sql, t.id);
      await identity.revokeUserSessions(sql, t.userId);
      await recordAudit(sql, {
        organizationId: null,
        actorUserId: t.userId,
        action: "auth.password.reset",
        targetType: "user",
        targetId: t.userId,
        outcome: "success",
        correlationId: meta.correlationId,
      });
    });
  }

  /**
   * Aceita um convite (RF-133). Conta nova: define nome e senha. Conta que já existe: precisa estar
   * autenticada como o usuário convidado, para ninguém anexar a conta de outra pessoa a uma organização.
   */
  async acceptInvite(
    input: { token: unknown; displayName?: unknown; password?: unknown },
    meta: RequestMeta,
    actor?: Actor,
  ): Promise<{ organizationId: string; userId: string; needsLogin: boolean }> {
    const hash = input.password === undefined ? undefined : await hashPassword(requirePassword(input.password), this.config.argon2);
    return this.db.tx({}, async (sql) => {
      const t = typeof input.token === "string" ? await identity.lockValidOneTimeToken(sql, input.token, "invite") : undefined;
      if (!t || !t.organizationId || !t.role) throw new DomainError("invalid", "Convite inválido ou expirado. Peça um novo ao administrador.");
      const user = await identity.getUser(sql, t.userId);
      if (!user || user.status === "disabled") throw new DomainError("invalid", "Convite inválido ou expirado. Peça um novo ao administrador.");

      let needsLogin = false;
      if (user.status === "invited") {
        if (!hash) throw new DomainError("invalid", "Defina uma senha para ativar a conta.");
        if (input.displayName !== undefined) await identity.updateDisplayName(sql, user.id, requireName(input.displayName, "usuário"));
        await identity.setPasswordHash(sql, user.id, hash);
        needsLogin = true;
      } else if (actor?.user.id !== user.id) {
        throw new DomainError("forbidden", "Entre com a conta convidada para aceitar este convite.");
      }

      await Database.setOrganization(sql, t.organizationId);
      if (!(await tenancy.getMembership(sql, t.organizationId, user.id))) {
        await tenancy.insertMembership(sql, t.organizationId, user.id, requireRole(t.role));
      }
      await identity.markOneTimeTokenUsed(sql, t.id);
      await recordAudit(sql, {
        organizationId: t.organizationId,
        actorUserId: user.id,
        action: "member.invite.accept",
        targetType: "user",
        targetId: user.id,
        outcome: "success",
        correlationId: meta.correlationId,
        details: { role: t.role },
      });
      return { organizationId: t.organizationId, userId: user.id, needsLogin };
    });
  }

  // =====================================================================
  // Organizações (RF-001, RF-005, CA-001, CA-024)
  // =====================================================================

  async listMyOrganizations(actor: Actor, filter: ListFilter = {}): Promise<Array<Organization & { role: Role; active: boolean }>> {
    const orgs = await this.db.tx({ userId: actor.user.id }, (sql) => tenancy.listOrganizationsOfUser(sql, actor.user.id, filter));
    return orgs.map((o) => ({ ...o, active: o.id === actor.session.activeOrganizationId }));
  }

  /** Troca a organização em uso (CA-024). Sem associação: 404, igual a uma organização inexistente. */
  async switchOrganization(actor: Actor, organizationId: string, meta: RequestMeta): Promise<Actor> {
    if (actor.session.kind === "access-token") {
      throw new DomainError("forbidden", "O token de acesso vale só para a organização em que foi criado. Crie outro token na outra organização.");
    }
    const ok = await this.db.tx({ userId: actor.user.id, organizationId }, async (sql) => {
      const membership = await tenancy.getMembership(sql, organizationId, actor.user.id);
      if (!membership) return false;
      await identity.setSessionOrganization(sql, actor.session.id, organizationId);
      await this.auditOrg(sql, organizationId, actor, meta, "session.organization.switch", "organization", organizationId);
      return true;
    });
    if (!ok) {
      await this.db.tx({}, (sql) =>
        this.auditInstance(sql, actor, meta, "session.organization.switch", "organization", organizationId, "denied"),
      );
      throw notFound("Organização");
    }
    const next = await this.actorFor({ ...actor.session, activeOrganizationId: organizationId });
    if (!next) throw new DomainError("unauthenticated", "Sessão encerrada.");
    return next;
  }

  /** Só o administrador da instância cria organizações (ADR-011). Quem cria vira admin dela. */
  async createOrganization(actor: Actor, input: { name: unknown; slug: unknown }, meta: RequestMeta): Promise<Organization> {
    const name = requireName(input.name, "organização");
    const slug = this.requireSlug(input.slug);
    if (!actor.user.isInstanceAdmin) {
      await this.db.tx({}, (sql) => this.auditInstance(sql, actor, meta, "organization.create", "organization", null, "denied"));
      throw new DomainError("forbidden", "Só o administrador da instalação pode criar organizações.");
    }
    const id = randomUUID();
    return this.db.tx({ userId: actor.user.id, organizationId: id }, async (sql) => {
      const org = await this.insertOrganization(sql, id, slug, name);
      await tenancy.insertMembership(sql, id, actor.user.id, "admin");
      await this.auditOrg(sql, id, actor, meta, "organization.create", "organization", id, "success", { slug });
      return org;
    });
  }

  async getCurrentOrganization(actor: Actor): Promise<Organization> {
    const a = await this.authorize(actor, "view");
    const org = await this.db.tx(this.scope(a), (sql) => tenancy.getOrganization(sql, a.organization.id));
    if (!org) throw notFound("Organização");
    return org;
  }

  /** Configurações gerais da organização (RF-143): só admin da organização. */
  async updateOrganization(actor: Actor, input: { name: unknown }, meta: RequestMeta): Promise<Organization> {
    const a = await this.requireOrgAdmin(actor, meta, "organization.update");
    this.requireWritable(a);
    const name = requireName(input.name, "organização");
    return this.db.tx(this.scope(a), async (sql) => {
      const org = await tenancy.updateOrganization(sql, a.organization.id, { name });
      if (!org) throw notFound("Organização");
      await this.auditOrg(sql, org.id, a, meta, "organization.update", "organization", org.id, "success", { name });
      return org;
    });
  }

  /** Arquivar deixa a organização somente leitura; desarquivar devolve a escrita (RF-001). */
  async setOrganizationArchived(actor: Actor, archived: boolean, meta: RequestMeta): Promise<Organization> {
    const action = archived ? "organization.archive" : "organization.unarchive";
    const a = await this.requireOrgAdmin(actor, meta, action);
    return this.db.tx(this.scope(a), async (sql) => {
      const org = await tenancy.setOrganizationArchived(sql, a.organization.id, archived);
      if (!org) throw notFound("Organização");
      await this.auditOrg(sql, org.id, a, meta, action, "organization", org.id);
      return org;
    });
  }

  // =====================================================================
  // Workspaces e projetos (RF-002, RF-003, RF-007)
  // Criar, editar e arquivar usam a operação "createProjects" da matriz do §6.
  // =====================================================================

  async listWorkspaces(actor: Actor, filter: ListFilter = {}): Promise<Workspace[]> {
    const a = await this.authorize(actor, "view");
    return this.db.tx(this.scope(a), (sql) => tenancy.listWorkspaces(sql, a.organization.id, filter));
  }

  async getWorkspace(actor: Actor, id: string): Promise<Workspace> {
    const a = await this.authorize(actor, "view");
    const ws = await this.db.tx(this.scope(a), (sql) => tenancy.getWorkspace(sql, a.organization.id, id));
    if (!ws) throw notFound("Workspace");
    return ws;
  }

  async createWorkspace(actor: Actor, input: { name: unknown }, meta: RequestMeta): Promise<Workspace> {
    const a = await this.authorize(actor, "createProjects", meta, "workspace.create");
    this.requireWritable(a);
    const name = requireName(input.name, "workspace");
    return this.db.tx(this.scope(a), async (sql) => {
      const ws = await this.unique(() => tenancy.insertWorkspace(sql, a.organization.id, name), "Já existe um workspace ativo com esse nome.");
      await this.auditOrg(sql, a.organization.id, a, meta, "workspace.create", "workspace", ws.id, "success", { name });
      return ws;
    });
  }

  async updateWorkspace(actor: Actor, id: string, input: { name: unknown }, meta: RequestMeta): Promise<Workspace> {
    const a = await this.authorize(actor, "createProjects", meta, "workspace.update");
    this.requireWritable(a);
    const name = requireName(input.name, "workspace");
    return this.db.tx(this.scope(a), async (sql) => {
      const ws = await this.unique(() => tenancy.updateWorkspace(sql, a.organization.id, id, name), "Já existe um workspace ativo com esse nome.");
      if (!ws) throw notFound("Workspace");
      await this.auditOrg(sql, a.organization.id, a, meta, "workspace.update", "workspace", id, "success", { name });
      return ws;
    });
  }

  /** Só arquiva workspace sem projetos ativos: arquive ou mova os projetos antes. */
  async setWorkspaceArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<Workspace> {
    const action = archived ? "workspace.archive" : "workspace.unarchive";
    const a = await this.authorize(actor, "createProjects", meta, action);
    this.requireWritable(a);
    return this.db.tx(this.scope(a), async (sql) => {
      const current = await tenancy.getWorkspace(sql, a.organization.id, id);
      if (!current) throw notFound("Workspace");
      if (archived && (await tenancy.countActiveProjects(sql, a.organization.id, id)) > 0) {
        throw new DomainError("conflict", "O workspace tem projetos ativos. Arquive ou mova esses projetos antes.");
      }
      const ws = await this.unique(
        () => tenancy.setWorkspaceArchived(sql, a.organization.id, id, archived),
        "Já existe um workspace ativo com esse nome.",
      );
      await this.auditOrg(sql, a.organization.id, a, meta, action, "workspace", id);
      return ws!;
    });
  }

  async listProjects(actor: Actor, filter: ListFilter & { workspaceId?: string } = {}): Promise<Project[]> {
    const a = await this.authorize(actor, "view");
    return this.db.tx(this.scope(a), (sql) => tenancy.listProjects(sql, a.organization.id, filter));
  }

  async getProject(actor: Actor, id: string): Promise<Project> {
    const a = await this.authorize(actor, "view");
    const p = await this.db.tx(this.scope(a), (sql) => tenancy.getProject(sql, a.organization.id, id));
    if (!p) throw notFound("Projeto");
    return p;
  }

  async createProject(actor: Actor, input: { workspaceId: unknown; name: unknown }, meta: RequestMeta): Promise<Project> {
    const a = await this.authorize(actor, "createProjects", meta, "project.create");
    this.requireWritable(a);
    const name = requireName(input.name, "projeto");
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
    return this.db.tx(this.scope(a), async (sql) => {
      await this.requireActiveWorkspace(sql, a.organization.id, workspaceId);
      const p = await this.unique(
        () => tenancy.insertProject(sql, a.organization.id, workspaceId, name),
        "Já existe um projeto ativo com esse nome neste workspace.",
      );
      await this.auditOrg(sql, a.organization.id, a, meta, "project.create", "project", p.id, "success", { name, workspaceId });
      return p;
    });
  }

  async updateProject(actor: Actor, id: string, input: { name?: unknown; workspaceId?: unknown }, meta: RequestMeta): Promise<Project> {
    const a = await this.authorize(actor, "createProjects", meta, "project.update");
    this.requireWritable(a);
    const name = input.name === undefined ? undefined : requireName(input.name, "projeto");
    const workspaceId = input.workspaceId === undefined ? undefined : String(input.workspaceId);
    return this.db.tx(this.scope(a), async (sql) => {
      if (workspaceId) await this.requireActiveWorkspace(sql, a.organization.id, workspaceId);
      const p = await this.unique(
        () => tenancy.updateProject(sql, a.organization.id, id, { ...(name ? { name } : {}), ...(workspaceId ? { workspaceId } : {}) }),
        "Já existe um projeto ativo com esse nome neste workspace.",
      );
      if (!p) throw notFound("Projeto");
      await this.auditOrg(sql, a.organization.id, a, meta, "project.update", "project", id, "success", {
        ...(name ? { name } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      return p;
    });
  }

  async setProjectArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<Project> {
    const action = archived ? "project.archive" : "project.unarchive";
    const a = await this.authorize(actor, "createProjects", meta, action);
    this.requireWritable(a);
    return this.db.tx(this.scope(a), async (sql) => {
      const current = await tenancy.getProject(sql, a.organization.id, id);
      if (!current) throw notFound("Projeto");
      if (!archived) await this.requireActiveWorkspace(sql, a.organization.id, current.workspaceId);
      const p = await this.unique(
        () => tenancy.setProjectArchived(sql, a.organization.id, id, archived),
        "Já existe um projeto ativo com esse nome neste workspace.",
      );
      await this.auditOrg(sql, a.organization.id, a, meta, action, "project", id);
      return p!;
    });
  }

  // =====================================================================
  // Membros, convites e papéis (RF-133, RF-134, RF-140)
  // =====================================================================

  async listMembers(actor: Actor): Promise<MemberView[]> {
    const a = await this.authorize(actor, "view");
    const showEmail = canPerform(a.organization.role, "manageUsers", a.organization.policy);
    return this.db.tx(this.scope(a), async (sql) => {
      const memberships = await tenancy.listMemberships(sql, a.organization.id);
      const users = await identity.getUsers(sql, memberships.map((m) => m.userId));
      const pending = new Set((await identity.listPendingInvites(sql, a.organization.id)).map((i) => i.userId));
      return memberships.flatMap((m) => {
        const u = users.get(m.userId);
        if (!u) return [];
        return [{
          userId: u.id,
          displayName: u.displayName,
          ...(showEmail ? { email: u.email } : {}),
          status: u.status,
          role: m.role,
          since: m.createdAt,
          invitePending: pending.has(u.id),
        }];
      });
    });
  }

  /**
   * Convida por e-mail com um papel. Devolve o link de uso único (ADR-011: entregue por fora até haver
   * e-mail). Só admin concede o papel admin. Pessoa já convidada e ainda pendente: o link é reemitido.
   */
  async inviteMember(actor: Actor, input: { email: unknown; role: unknown; displayName?: unknown }, meta: RequestMeta): Promise<IssuedLink> {
    const a = await this.authorize(actor, "manageUsers", meta, "member.invite");
    this.requireWritable(a);
    const email = requireEmail(input.email);
    const role = requireRole(input.role);
    await this.requireCanGrant(a, role, meta, "member.invite");
    return this.db.tx(this.scope(a), async (sql) => {
      let user = await identity.getUserByEmail(sql, email);
      if (user?.status === "disabled") throw new DomainError("conflict", "Essa conta está desativada.");
      if (user && (await tenancy.getMembership(sql, a.organization.id, user.id))) {
        throw new DomainError("conflict", "Essa pessoa já é membro da organização.");
      }
      user ??= await identity.createUser(sql, {
        email,
        displayName: input.displayName === undefined ? email.split("@")[0]! : requireName(input.displayName, "usuário"),
        status: "invited",
      });
      const issued = await identity.issueOneTimeToken(sql, {
        kind: "invite",
        userId: user.id,
        organizationId: a.organization.id,
        role,
        createdBy: a.user.id,
        ttlHours: this.config.inviteTtlHours,
      });
      await this.auditOrg(sql, a.organization.id, a, meta, "member.invite", "user", user.id, "success", { role });
      return { ...issued, userId: user.id };
    });
  }

  async changeMemberRole(actor: Actor, userId: string, roleInput: unknown, meta: RequestMeta): Promise<void> {
    const a = await this.authorize(actor, "manageUsers", meta, "member.role.change");
    this.requireWritable(a);
    const role = requireRole(roleInput);
    await this.requireCanGrant(a, role, meta, "member.role.change");
    await this.db.tx(this.scope(a), async (sql) => {
      const adminCount = await tenancy.lockAndCountAdmins(sql, a.organization.id);
      const current = await tenancy.getMembership(sql, a.organization.id, userId);
      if (!current) throw notFound("Membro");
      if (current.role === "admin" && a.organization.role !== "admin") throw this.onlyAdminsTouchAdmins();
      if (current.role === "admin" && role !== "admin" && adminCount <= 1) {
        throw new DomainError("conflict", "A organização precisa de pelo menos um admin.");
      }
      await tenancy.updateMembershipRole(sql, a.organization.id, userId, role);
      await this.auditOrg(sql, a.organization.id, a, meta, "member.role.change", "user", userId, "success", { from: current.role, to: role });
    });
  }

  /** Revoga o acesso à organização na hora (RF-140): remove a associação, convites e o uso nas sessões. */
  async removeMember(actor: Actor, userId: string, meta: RequestMeta): Promise<void> {
    const a = await this.authorize(actor, "manageUsers", meta, "member.remove");
    this.requireWritable(a);
    await this.db.tx(this.scope(a), async (sql) => {
      const adminCount = await tenancy.lockAndCountAdmins(sql, a.organization.id);
      const current = await tenancy.getMembership(sql, a.organization.id, userId);
      if (!current) throw notFound("Membro");
      if (current.role === "admin" && a.organization.role !== "admin") throw this.onlyAdminsTouchAdmins();
      if (current.role === "admin" && adminCount <= 1) throw new DomainError("conflict", "A organização precisa de pelo menos um admin.");
      await tenancy.deleteMembership(sql, a.organization.id, userId);
      await identity.revokeInvites(sql, userId, a.organization.id);
      await identity.detachOrganizationFromSessions(sql, userId, a.organization.id);
      await this.auditOrg(sql, a.organization.id, a, meta, "member.remove", "user", userId, "success", { role: current.role });
    });
  }

  /**
   * Link de redefinição de senha (ADR-011). Só o administrador da instância gera, porque a conta pode
   * participar de outras organizações: o admin de uma organização não pode tomar a conta de outra.
   */
  async issuePasswordReset(actor: Actor, input: { email: unknown }, meta: RequestMeta): Promise<IssuedLink> {
    const email = requireEmail(input.email);
    if (!actor.user.isInstanceAdmin) {
      await this.db.tx({}, (sql) => this.auditInstance(sql, actor, meta, "auth.password.reset.issue", "user", null, "denied"));
      throw new DomainError("forbidden", "Só o administrador da instalação gera links de redefinição de senha.");
    }
    return this.db.tx({}, async (sql) => {
      const user = await identity.getUserByEmail(sql, email);
      if (!user || user.status === "disabled") throw notFound("Usuário");
      const issued = await identity.issueOneTimeToken(sql, {
        kind: "password-reset",
        userId: user.id,
        createdBy: actor.user.id,
        ttlHours: this.config.passwordResetTtlHours,
      });
      await this.auditInstance(sql, actor, meta, "auth.password.reset.issue", "user", user.id);
      return { ...issued, userId: user.id };
    });
  }

  // =====================================================================
  // Política de papéis (RF-134) e auditoria (RF-139)
  // =====================================================================

  async getAccessPolicy(actor: Actor): Promise<OrganizationPolicy> {
    const a = await this.authorize(actor, "view");
    return this.db.tx(this.scope(a), (sql) => getPolicy(sql, a.organization.id));
  }

  async updateAccessPolicy(actor: Actor, policy: unknown, meta: RequestMeta): Promise<OrganizationPolicy> {
    const a = await this.requireOrgAdmin(actor, meta, "access.policy.update");
    this.requireWritable(a);
    return this.db.tx(this.scope(a), async (sql) => {
      const saved = await savePolicy(sql, a.organization.id, policy as OrganizationPolicy, a.user.id);
      await this.auditOrg(sql, a.organization.id, a, meta, "access.policy.update", "organization", a.organization.id, "success", { grants: saved });
      return saved;
    });
  }

  async listAudit(actor: Actor, q: AuditQuery, meta: RequestMeta): Promise<AuditEvent[]> {
    const a = await this.authorize(actor, "viewAudit", meta, "audit.list");
    return this.db.tx(this.scope(a), (sql) => listAudit(sql, a.organization.id, q));
  }

  // =====================================================================
  // Apoio
  // =====================================================================

  /** Autoriza no servidor (RNF-007). A negação é auditada numa transação própria (RF-139). */
  async authorize(actor: Actor, operation: Operation, meta?: RequestMeta, action?: string): Promise<OrgActor> {
    const org = actor.organization;
    if (!org) throw new DomainError("conflict", "Escolha uma organização para continuar.");
    if (!canPerform(org.role, operation, org.policy)) {
      if (meta) await this.auditDenied(actor as OrgActor, meta, action ?? operation, { operation });
      throw new DomainError("forbidden", "Seu papel nesta organização não permite esta operação.");
    }
    return actor as OrgActor;
  }

  private requireOrg(actor: Actor): OrgActor {
    if (!actor.organization) throw new DomainError("conflict", "Escolha uma organização para continuar.");
    return actor as OrgActor;
  }

  private async requireOrgAdmin(actor: Actor, meta: RequestMeta, action: string): Promise<OrgActor> {
    const a = await this.authorize(actor, "view");
    if (a.organization.role !== "admin") {
      await this.auditDenied(a, meta, action, { requiredRole: "admin" });
      throw new DomainError("forbidden", "Só o admin da organização pode fazer isto.");
    }
    return a;
  }

  /** Quem não é admin não concede o papel admin (evita escalada de privilégio). */
  private async requireCanGrant(a: OrgActor, role: Role, meta: RequestMeta, action: string): Promise<void> {
    if (role === "admin" && a.organization.role !== "admin") {
      await this.auditDenied(a, meta, action, { grant: role });
      throw this.onlyAdminsTouchAdmins();
    }
  }

  private onlyAdminsTouchAdmins() {
    return new DomainError("forbidden", "Só um admin pode conceder, alterar ou remover o papel admin.");
  }

  private requireWritable(a: OrgActor): void {
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
  }

  private async requireActiveWorkspace(sql: Sql, organizationId: string, workspaceId: string): Promise<void> {
    const ws = /^[0-9a-f-]{36}$/i.test(workspaceId) ? await tenancy.getWorkspace(sql, organizationId, workspaceId) : undefined;
    if (!ws) throw notFound("Workspace");
    if (ws.archivedAt) throw new DomainError("conflict", "O workspace está arquivado.");
  }

  private requireSlug(value: unknown): string {
    const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!SLUG_PATTERN.test(slug)) {
      throw new DomainError("invalid", "Identificador inválido: use de 1 a 40 letras minúsculas, números ou hífens, sem hífen nas pontas.");
    }
    return slug;
  }

  private insertOrganization(sql: Sql, id: string, slug: string, name: string): Promise<Organization> {
    return this.unique(() => tenancy.insertOrganization(sql, { id, slug, name }), "Já existe uma organização com esse identificador.");
  }

  private async unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("conflict", message);
      throw error;
    }
  }

  private scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }

  private auditOrg(
    sql: Sql,
    organizationId: string,
    actor: Actor,
    meta: RequestMeta,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: AuditEventInput["outcome"] = "success",
    details?: Record<string, unknown>,
  ) {
    return recordAudit(sql, {
      organizationId,
      actorUserId: actor.user.id,
      action,
      targetType,
      targetId,
      outcome,
      correlationId: meta.correlationId,
      ...(details ? { details } : {}),
    });
  }

  private auditInstance(
    sql: Sql,
    actor: Actor,
    meta: RequestMeta,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: AuditEventInput["outcome"] = "success",
    details?: Record<string, unknown>,
  ) {
    return recordAudit(sql, {
      organizationId: null,
      actorUserId: actor.user.id,
      action,
      targetType,
      targetId,
      outcome,
      correlationId: meta.correlationId,
      ...(details ? { details } : {}),
    });
  }

  private async auditDenied(a: OrgActor, meta: RequestMeta, action: string, details: Record<string, unknown>) {
    await this.db.tx(this.scope(a), (sql) =>
      this.auditOrg(sql, a.organization.id, a, meta, action, "organization", a.organization.id, "denied", details),
    );
  }
}
