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
