import { describe, expect, it } from "vitest";
import { PipelineManifestSchema, validateParameterValues } from "../src/index.ts";

// Nomes de parâmetros ilustrativos (§18.4): não são os nomes reais da pipeline do caso piloto (P-007).
const input = {
  schemaVersion: "1",
  organizationRef: "organizacao-exemplo",
  projectRef: "projeto-exemplo",
  provider: { kind: "azure-devops", integrationRef: "integracao-exemplo" },
  pipeline: { externalId: "id-externo-exemplo", displayName: "Pipeline de testes" },
  parameters: [
    { name: "browser", type: "enum", options: ["chromium", "firefox", "webkit"], default: "chromium" },
    { name: "runSmoke", type: "boolean", default: false },
    { name: "automationBranch", type: "string", required: true },
  ],
  validationRules: [
    {
      id: "smoke-only-chromium",
      message: "o smoke só roda no Chromium",
      when: { parameter: "runSmoke", equals: true },
      then: { parameter: "browser", in: ["chromium"] },
    },
  ],
  executionResources: [{ ref: "executor-exclusivo-exemplo", exclusive: true }],
  reports: [{ type: "playwright-json" }],
};
const manifest = PipelineManifestSchema.parse(input);

describe("PipelineManifestSchema", () => {
  it("rejeita regra que referencia parâmetro não declarado", () => {
    const result = PipelineManifestSchema.safeParse({
      ...input,
      validationRules: [{ ...input.validationRules[0], when: { parameter: "inexistente", equals: true } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejeita campos desconhecidos, como uma credencial embutida", () => {
    const result = PipelineManifestSchema.safeParse({ ...input, token: "nao-deveria-estar-aqui" });
    expect(result.success).toBe(false);
  });

  it("rejeita valor padrão fora das opções do enum", () => {
    const result = PipelineManifestSchema.safeParse({
      ...input,
      parameters: [{ name: "browser", type: "enum", options: ["chromium"], default: "edge" }],
      validationRules: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("validateParameterValues", () => {
  it("aplica valores padrão e aceita combinação válida", () => {
    const { effective, violations } = validateParameterValues(manifest, { automationBranch: "main" });
    expect(violations).toEqual([]);
    expect(effective).toEqual({ browser: "chromium", runSmoke: false, automationBranch: "main" });
  });

  it("bloqueia smoke em navegador não suportado (CA-034)", () => {
    const { violations } = validateParameterValues(manifest, {
      automationBranch: "main",
      runSmoke: true,
      browser: "firefox",
    });
    expect(violations).toEqual([
      { parameter: "browser", message: "o smoke só roda no Chromium", ruleId: "smoke-only-chromium" },
    ]);
  });

  it("aponta obrigatório ausente, tipo errado e parâmetro desconhecido (CA-006)", () => {
    const { violations } = validateParameterValues(manifest, { runSmoke: "sim", extra: 1 });
    expect(violations.map((v) => v.parameter).sort()).toEqual(["automationBranch", "extra", "runSmoke"]);
  });
});
