import { describe, expect, it } from "vitest";
import type { ParameterSpec } from "@painel/contracts";
import { compareWithProvider, parseMasterKey } from "../src/index.ts";

// Regras sem navegador do incremento 2.

const p = (spec: Partial<ParameterSpec> & Pick<ParameterSpec, "name" | "type">): ParameterSpec =>
  ({ required: false, scope: "provider", ...spec }) as ParameterSpec;

const provider: ParameterSpec[] = [
  p({ name: "branchApp", type: "string", default: "main" }),
  p({ name: "limparDados", type: "boolean", default: true }),
  p({ name: "navegador", type: "enum", options: ["chromium", "firefox"], default: "chromium" }),
  p({ name: "obrigatorio", type: "string", required: true }),
];

describe("compareWithProvider", () => {
  it("manifesto igual ao provedor não tem problema", () => {
    expect(compareWithProvider(provider, provider)).toEqual([]);
  });

  it("parâmetro que o provedor não declara é erro (o Azure responde Unexpected parameter)", () => {
    const problems = compareWithProvider([...provider, p({ name: "naoExiste", type: "string" })], provider);
    expect(problems).toEqual([{ parameter: "naoExiste", severity: "error", message: expect.stringContaining("não declara") }]);
  });

  it("tipo incompatível é erro", () => {
    const changed = provider.map((x) => (x.name === "limparDados" ? p({ name: "limparDados", type: "string" }) : x));
    expect(compareWithProvider(changed, provider)[0]).toMatchObject({ parameter: "limparDados", severity: "error" });
  });

  it("enum na plataforma sobre string do provedor é permitido; opção que o provedor não aceita é erro", () => {
    const narrowed = provider.map((x) =>
      x.name === "branchApp" ? p({ name: "branchApp", type: "enum", options: ["main", "testes-maquina"], default: "main" }) : x,
    );
    expect(compareWithProvider(narrowed, provider)).toEqual([]);
    const widened = provider.map((x) =>
      x.name === "navegador" ? p({ name: "navegador", type: "enum", options: ["chromium", "firefox", "edge"] }) : x,
    );
    expect(compareWithProvider(widened, provider)).toEqual([
      { parameter: "navegador", severity: "error", message: "opções que o provedor não aceita: edge" },
    ]);
  });

  it("obrigatório ausente é erro; opcional ausente só avisa", () => {
    const problems = compareWithProvider(provider.slice(0, 2), provider);
    expect(problems).toEqual([
      { parameter: "navegador", severity: "info", message: expect.any(String) },
      { parameter: "obrigatorio", severity: "error", message: expect.any(String) },
    ]);
  });
});

describe("parseMasterKey", () => {
  it("aceita 32 bytes em base64", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(parseMasterKey(key).keys.get("m1")?.length).toBe(32);
  });

  it("recusa ausente, tamanho errado e chave de exemplo", () => {
    expect(() => parseMasterKey(undefined)).toThrow("32 bytes");
    expect(() => parseMasterKey(Buffer.alloc(16, 1).toString("base64"))).toThrow("32 bytes");
    expect(() => parseMasterKey("troque-por-32-bytes-em-base64")).toThrow("32 bytes");
    expect(() => parseMasterKey(Buffer.alloc(32).toString("base64"))).toThrow("zeros");
  });
});
