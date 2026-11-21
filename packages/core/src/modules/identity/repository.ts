import type { Sql } from "../../db/database.ts";
import { hashToken, newToken } from "./tokens.ts";

// Persistência do módulo identity. Tabelas globais (sem organização): identity_users,
// identity_sessions, identity_one_time_tokens. Nenhum outro módulo lê estas tabelas (ADR-001).

export type UserStatus = "invited" | "active" | "disabled";

export interface User {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  isInstanceAdmin: boolean;
  createdAt: Date;
}

export interface UserCredentials extends User {
  passwordHash: string | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface Session {
  id: string;
  userId: string;
  activeOrganizationId: string | null;
  csrfToken: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type OneTimeTokenKind = "invite" | "password-reset";

export interface OneTimeToken {
  id: string;
  kind: OneTimeTokenKind;
  userId: string;
  organizationId: string | null;
  role: string | null;
  createdBy: string | null;
  expiresAt: Date;
}

const USER_COLUMNS = `id, email, display_name, status, is_instance_admin, created_at`;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: UserStatus;
  is_instance_admin: boolean;
  created_at: Date;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    isInstanceAdmin: r.is_instance_admin,
    createdAt: r.created_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserCredentials(sql: Sql, email: string): Promise<UserCredentials | undefined> {
  const { rows } = await sql.query(
    `SELECT ${USER_COLUMNS}, password_hash, failed_login_count, locked_until
       FROM identity_users WHERE lower(email) = $1`,
    [normalizeEmail(email)],
  );
  const r = rows[0];
  if (!r) return undefined;
  return { ...toUser(r), passwordHash: r.password_hash, failedLoginCount: r.failed_login_count, lockedUntil: r.locked_until };
}

export async function getUser(sql: Sql, id: string): Promise<User | undefined> {
  const { rows } = await sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM identity_users WHERE id = $1`, [id]);
  return rows[0] && toUser(rows[0]);
}

export async function getUserByEmail(sql: Sql, email: string): Promise<User | undefined> {
  const { rows } = await sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM identity_users WHERE lower(email) = $1`, [
    normalizeEmail(email),
  ]);
  return rows[0] && toUser(rows[0]);
}

export async function getUsers(sql: Sql, ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM identity_users WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, toUser(r)]));
}

export async function countInstanceAdmins(sql: Sql): Promise<number> {
  const { rows } = await sql.query<{ n: string }>(`SELECT count(*) AS n FROM identity_users WHERE is_instance_admin`);
  return Number(rows[0]!.n);
}

export async function createUser(
  sql: Sql,
  input: { email: string; displayName: string; status: UserStatus; isInstanceAdmin?: boolean },
): Promise<User> {
  const { rows } = await sql.query<UserRow>(
    `INSERT INTO identity_users (email, display_name, status, is_instance_admin)
     VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
    [input.email.trim(), input.displayName.trim(), input.status, input.isInstanceAdmin ?? false],
  );
  return toUser(rows[0]!);
}

export async function updateDisplayName(sql: Sql, userId: string, displayName: string): Promise<void> {
  await sql.query(`UPDATE identity_users SET display_name = $2 WHERE id = $1`, [userId, displayName.trim()]);
}

/** Define a senha e ativa a conta; zera o bloqueio por tentativas. */
export async function setPasswordHash(sql: Sql, userId: string, passwordHash: string): Promise<void> {
  await sql.query(
    `UPDATE identity_users
        SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL,
            status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
      WHERE id = $1`,
    [userId, passwordHash],
  );
}

/** Conta uma falha; ao chegar ao limite, bloqueia a conta por um tempo e recomeça a contagem. */
export async function registerFailedLogin(sql: Sql, userId: string, maxAttempts: number, lockMinutes: number): Promise<boolean> {
  const { rows } = await sql.query<{ locked: boolean }>(
    `UPDATE identity_users
        SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
            locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1
      RETURNING locked_until IS NOT NULL AND locked_until > now() AS locked`,
    [userId, maxAttempts, lockMinutes],
  );
  return rows[0]?.locked ?? false;
}

export async function clearFailedLogins(sql: Sql, userId: string): Promise<void> {
  await sql.query(`UPDATE identity_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId]);
}

// ---------- Sessões ----------

const SESSION_COLUMNS = `id, user_id, active_organization_id, csrf_token, user_agent, ip, created_at, last_seen_at, expires_at`;

interface SessionRow {
  id: string;
  user_id: string;
  active_organization_id: string | null;
  csrf_token: string;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    activeOrganizationId: r.active_organization_id,
    csrfToken: r.csrf_token,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  };
}

export async function createSession(
  sql: Sql,
  input: { userId: string; activeOrganizationId: string | null; absoluteHours: number; userAgent?: string; ip?: string },
): Promise<{ token: string; session: Session }> {
  const token = newToken();
  const { rows } = await sql.query<SessionRow>(
    `INSERT INTO identity_sessions (token_hash, user_id, active_organization_id, csrf_token, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
     RETURNING ${SESSION_COLUMNS}`,
    [
      hashToken(token),
      input.userId,
      input.activeOrganizationId,
      newToken(),
      input.userAgent?.slice(0, 400) ?? null,
      input.ip ?? null,
      input.absoluteHours,
    ],
  );
  return { token, session: toSession(rows[0]!) };
}

/**
 * Sessão válida para o token: não revogada, dentro da validade absoluta e da inatividade máxima,
 * e de um usuário ativo. Atualiza last_seen_at no máximo uma vez por minuto.
 */
export async function findActiveSession(sql: Sql, token: string, idleMinutes: number): Promise<Session | undefined> {
  const { rows } = await sql.query<SessionRow>(
    `SELECT s.id, s.user_id, s.active_organization_id, s.csrf_token, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at
       FROM identity_sessions s JOIN identity_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2) AND u.status = 'active'`,
    [hashToken(token), idleMinutes],
  );
  const r = rows[0];
  if (!r) return undefined;
  if (Date.now() - r.last_seen_at.getTime() > 60_000) {
    await sql.query(`UPDATE identity_sessions SET last_seen_at = now() WHERE id = $1`, [r.id]);
  }
  return toSession(r);
}

export async function setSessionOrganization(sql: Sql, sessionId: string, organizationId: string | null): Promise<void> {
  await sql.query(`UPDATE identity_sessions SET active_organization_id = $2 WHERE id = $1`, [sessionId, organizationId]);
}

export async function listSessions(sql: Sql, userId: string): Promise<Session[]> {
  const { rows } = await sql.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM identity_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map(toSession);
}

export async function revokeSession(sql: Sql, userId: string, sessionId: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE identity_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Revoga todas as sessões do usuário, exceto `exceptSessionId` (troca de senha, desativação). */
export async function revokeUserSessions(sql: Sql, userId: string, exceptSessionId?: string): Promise<number> {
  const { rowCount } = await sql.query(
    `UPDATE identity_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
  return rowCount ?? 0;
}

/** Tira a organização das sessões de um usuário que perdeu o acesso a ela (RF-140). */
export async function detachOrganizationFromSessions(sql: Sql, userId: string, organizationId: string): Promise<void> {
  await sql.query(
    `UPDATE identity_sessions SET active_organization_id = NULL WHERE user_id = $1 AND active_organization_id = $2`,
    [userId, organizationId],
  );
}

// ---------- Tokens de uso único ----------

interface TokenRow {
  id: string;
  kind: OneTimeTokenKind;
  user_id: string;
  organization_id: string | null;
  role: string | null;
  created_by: string | null;
  expires_at: Date;
}

/** Emite um token novo e revoga os anteriores ainda não usados do mesmo tipo (e organização, no convite). */
export async function issueOneTimeToken(
  sql: Sql,
  input: { kind: OneTimeTokenKind; userId: string; organizationId?: string; role?: string; createdBy: string | null; ttlHours: number },
): Promise<{ token: string; expiresAt: Date }> {
  await sql.query(
    `UPDATE identity_one_time_tokens SET revoked_at = now()
      WHERE user_id = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL
        AND organization_id IS NOT DISTINCT FROM $3`,
    [input.userId, input.kind, input.organizationId ?? null],
  );
  const token = newToken();
  const { rows } = await sql.query<{ expires_at: Date }>(
    `INSERT INTO identity_one_time_tokens (token_hash, kind, user_id, organization_id, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7)) RETURNING expires_at`,
    [hashToken(token), input.kind, input.userId, input.organizationId ?? null, input.role ?? null, input.createdBy, input.ttlHours],
  );
  return { token, expiresAt: rows[0]!.expires_at };
}

/** Lê um token válido (não usado, não revogado, no prazo), travando a linha até o fim da transação. */
export async function lockValidOneTimeToken(sql: Sql, token: string, kind: OneTimeTokenKind): Promise<OneTimeToken | undefined> {
  const { rows } = await sql.query<TokenRow>(
    `SELECT id, kind, user_id, organization_id, role, created_by, expires_at
       FROM identity_one_time_tokens
      WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [hashToken(token), kind],
  );
  const r = rows[0];
  return (
    r && {
      id: r.id,
      kind: r.kind,
      userId: r.user_id,
      organizationId: r.organization_id,
      role: r.role,
      createdBy: r.created_by,
      expiresAt: r.expires_at,
    }
  );
}

export async function markOneTimeTokenUsed(sql: Sql, id: string): Promise<void> {
  await sql.query(`UPDATE identity_one_time_tokens SET used_at = now() WHERE id = $1`, [id]);
}

/** Revoga convites pendentes de um usuário para uma organização (remoção do membro, RF-140). */
export async function revokeInvites(sql: Sql, userId: string, organizationId: string): Promise<void> {
  await sql.query(
    `UPDATE identity_one_time_tokens SET revoked_at = now()
      WHERE user_id = $1 AND organization_id = $2 AND kind = 'invite' AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, organizationId],
  );
}

export interface PendingInvite {
  userId: string;
  role: string;
  createdAt: Date;
  expiresAt: Date;
}

export async function listPendingInvites(sql: Sql, organizationId: string): Promise<PendingInvite[]> {
  const { rows } = await sql.query(
    `SELECT user_id, role, created_at, expires_at FROM identity_one_time_tokens
      WHERE organization_id = $1 AND kind = 'invite' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map((r) => ({ userId: r.user_id, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at }));
}
