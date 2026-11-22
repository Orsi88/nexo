import { createHash, randomBytes } from "node:crypto";

/** Token aleatório de 256 bits, em base64url. Só o hash vai para o banco. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Formato aceito antes de consultar o banco (evita consultas com lixo). */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// Token pessoal de acesso (ADR-017): o prefixo deixa o token reconhecível em varreduras de segredos
// e impede que um token de sessão de navegador seja aceito no cabeçalho, e vice-versa.
export const ACCESS_TOKEN_PREFIX = "nexo_pat_";

export function newAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${newToken()}`;
}

export function looksLikeAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ACCESS_TOKEN_PREFIX) && looksLikeToken(value.slice(ACCESS_TOKEN_PREFIX.length));
}
