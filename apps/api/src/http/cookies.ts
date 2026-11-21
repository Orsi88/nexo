// Leitura e escrita mínima de cookies, sem dependência extra.

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // valor malformado: ignora
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
}

/** Cookie de sessão: HttpOnly, SameSite=Lax, Path=/ (§8 da arquitetura). */
export function serializeSessionCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join("; ");
}

export function sessionCookieName(secure: boolean): string {
  // __Host- exige Secure, Path=/ e nenhum Domain: o cookie não vaza para subdomínios (ex.: a origem dos relatórios).
  return secure ? "__Host-painel_session" : "painel_session";
}
