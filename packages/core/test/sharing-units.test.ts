import { describe, expect, it } from "vitest";
import { isSensitiveName, publicParameters, sanitizeSettings, sanitizeShareOptions, scrubText } from "../src/index.ts";

describe("mascaramento para links compartilhados (RN-047, CA-037)", () => {
  it("esconde credenciais, chaves e e-mails", () => {
    expect(scrubText("git clone https://joao:s3nh4@git.exemplo.test/app.git")).toBe("git clone https://•••@git.exemplo.test/app.git");
    expect(scrubText("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer •••");
    expect(scrubText('{"password": "x1y2z3", "user": "ana"}')).toBe('{"password": "•••", "user": "ana"}');
    expect(scrubText("token=ghp_0123456789abcdefghijABCDEFGHIJ")).toBe("token=•••");
    expect(scrubText("chave AKIAABCDEFGHIJKLMNOP usada")).toBe("chave ••• usada");
    expect(scrubText("falhou para ana.silva@empresa.com.br")).toBe("falhou para •••@empresa.com.br");
    expect(scrubText("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("•••");
  });

  it("não estraga texto comum de teste", () => {
    for (const text of [
      "expect(locator).toBeVisible() failed: Timeout 15000ms",
      "Login › bloqueia após 3 tentativas",
      "tests/documentos.spec.ts:42:18",
      "refs/heads/release-2025.01",
      "sistema master · 20250114.18",
    ]) {
      expect(scrubText(text)).toBe(text);
    }
  });

  it("parâmetro com nome sensível nunca é publicado", () => {
    expect(isSensitiveName("senhaBanco")).toBe(true);
    expect(isSensitiveName("API_KEY")).toBe(true);
    expect(isSensitiveName("limparDados")).toBe(false);
    expect(publicParameters({ senhaBanco: "x", ambiente: "homologacao", url: "https://a:b@h" })).toEqual({
      values: { senhaBanco: "oculto", ambiente: "homologacao", url: "https://•••@h" },
      hidden: ["senhaBanco"],
    });
  });
});

describe("políticas da organização", () => {
  it("limita números e completa padrões", () => {
    expect(sanitizeSettings({})).toEqual({
      sharing: { allowPublic: true, defaultDays: 7, maxDays: 90 },
      retention: { artifactsDays: 90, resultsDays: 365, emailsDays: 90 },
    });
    const s = sanitizeSettings({ sharing: { allowPublic: false, defaultDays: 60, maxDays: 30 }, retention: { artifactsDays: 0, resultsDays: 5, extra: 1 } });
    expect(s.sharing).toEqual({ allowPublic: false, defaultDays: 30, maxDays: 30 }); // padrão nunca passa do máximo
    expect(s.retention).toEqual({ artifactsDays: 1, resultsDays: 30, emailsDays: 90 });
  });

  it("opções do link: só booleanos e período de 1 a 90 dias", () => {
    expect(sanitizeShareOptions({ parameters: "sim", periodDays: 500 })).toEqual({ parameters: false, errorDetails: false, branch: true, systemVersion: true, periodDays: 90 });
  });
});
