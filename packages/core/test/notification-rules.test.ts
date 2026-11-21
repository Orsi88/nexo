import { describe, expect, it } from "vitest";
import { parseRuleFields, renderMessage, ruleMatches, type ExecutionFacts } from "../src/index.ts";

// Regras de evento sem banco. Exemplo de uso real: depois de uma suíte smoke que passou, avisar que
// a versão pode seguir para homologação.

const facts: ExecutionFacts = {
  pipelineId: "p1",
  pipelineName: "testes-e2e",
  status: "succeeded",
  ref: "refs/heads/testes-maquina",
  parameters: { suite: "smoke", limparDados: true },
  systemVersion: { system: "Sistema", full: "master · 20250115.8", parts: [], missing: [] },
  runNumber: "20250116.1-master-20250115.8",
};

const smokeRule = {
  enabled: true,
  pipelineId: "p1",
  onStatus: ["succeeded" as const],
  conditions: [{ parameter: "suite", in: ["smoke", "completa"] }],
};

describe("ruleMatches", () => {
  it("vale quando pipeline, resultado e parâmetros batem", () => {
    expect(ruleMatches(smokeRule, facts)).toBe(true);
  });

  it("não vale com outro resultado, outra pipeline, parâmetro diferente ou regra desligada", () => {
    expect(ruleMatches(smokeRule, { ...facts, status: "failed" })).toBe(false);
    expect(ruleMatches(smokeRule, { ...facts, pipelineId: "p2" })).toBe(false);
    expect(ruleMatches(smokeRule, { ...facts, parameters: { suite: "regressao" } })).toBe(false);
    expect(ruleMatches(smokeRule, { ...facts, parameters: {} })).toBe(false);
    expect(ruleMatches({ ...smokeRule, enabled: false }, facts)).toBe(false);
  });

  it("regra sem pipeline vale para todas; booleano gravado como texto pelo provedor também bate", () => {
    const rule = { enabled: true, pipelineId: null, onStatus: ["succeeded" as const], conditions: [{ parameter: "limparDados", in: [true] }] };
    expect(ruleMatches(rule, { ...facts, pipelineId: "qualquer" })).toBe(true);
    expect(ruleMatches(rule, { ...facts, parameters: { limparDados: "True" } })).toBe(true);
  });
});

describe("renderMessage", () => {
  it("preenche as variáveis e marca o que falta", () => {
    const msg = renderMessage("Liberar versão: {pipeline} rodou {param:suite} em {versao} ({branch}, {resultado}). Cupom: {param:cupom}", facts);
    expect(msg).toBe("Liberar versão: testes-e2e rodou smoke em master · 20250115.8 (testes-maquina, sucesso). Cupom: —");
  });
});

describe("parseRuleFields", () => {
  it("normaliza e recusa o que não dá para cumprir", () => {
    const ok = parseRuleFields({ name: " Liberar ", title: "Liberar versão", message: "m", onStatus: ["succeeded", "succeeded"] });
    expect(ok).toMatchObject({ name: "Liberar", onStatus: ["succeeded"], severity: "warning", channels: ["panel"], conditions: [], enabled: true });
    expect(() => parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["running"] })).toThrow(/resultado/);
    // E-mail (incremento 7): exige destinatário válido e mantém o aviso no painel.
    expect(() => parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["failed"], channels: ["email"] })).toThrow(/ao menos um e-mail/);
    expect(() => parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["failed"], channels: ["email"], recipients: ["sem-arroba"] })).toThrow(/inválido/);
    expect(() => parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["failed"], channels: ["sms"] })).toThrow(/Canal/);
    expect(parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["failed"], channels: ["email"], recipients: ["A@B.test"] })).toMatchObject({
      channels: ["panel", "email"],
      recipients: ["a@b.test"],
    });
    expect(() => parseRuleFields({ name: "x", title: "t", message: "m", onStatus: ["failed"], conditions: [{ parameter: "1x", in: ["a"] }] })).toThrow(/parâmetro/);
  });
});
