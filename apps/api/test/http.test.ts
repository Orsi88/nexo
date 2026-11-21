import { describe, expect, it } from "vitest";
import { parseCookies, serializeSessionCookie, sessionCookieName } from "../src/http/cookies.ts";
import { FixedWindowLimiter } from "../src/http/rate-limit.ts";

describe("cookies", () => {
  it("lê cookies e ignora valores malformados", () => {
    expect(parseCookies("a=1; b=%E0%A4%A; c=x%20y")).toEqual({ a: "1", c: "x y" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("cookie de sessão é HttpOnly e SameSite=Lax; Secure e __Host- só em HTTPS", () => {
    expect(serializeSessionCookie("s", "v", { secure: false, maxAgeSeconds: 60 })).toBe("s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60");
    expect(serializeSessionCookie("s", "v", { secure: true })).toContain("; Secure");
    expect(sessionCookieName(true)).toBe("__Host-painel_session");
    expect(sessionCookieName(false)).toBe("painel_session");
  });
});

describe("limitador por janela", () => {
  it("bloqueia acima do limite e libera na próxima janela", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect([l.take("ip", 0), l.take("ip", 10), l.take("ip", 20)]).toEqual([true, true, false]);
    expect(l.take("outro", 20)).toBe(true);
    expect(l.take("ip", 1000)).toBe(true);
  });
});
