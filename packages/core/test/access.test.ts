import { describe, expect, it } from "vitest";
import { canPerform, MODULES } from "../src/index.ts";

describe("matriz de papéis (§6, sujeita a validação)", () => {
  it("leitor só visualiza", () => {
    expect(canPerform("reader", "view")).toBe(true);
    expect(canPerform("reader", "execute")).toBe(false);
    expect(canPerform("reader", "share")).toBe(false);
  });

  it("'conforme política' é negado até a organização conceder", () => {
    expect(canPerform("operator", "cancel")).toBe(false);
    expect(canPerform("operator", "cancel", { operator: ["cancel"] })).toBe(true);
  });

  it("política da organização não libera o que a matriz nega", () => {
    expect(canPerform("operator", "manageIntegrations", { operator: ["manageIntegrations"] })).toBe(false);
  });
});

describe("módulos", () => {
  it("cada tabela pertence a um único módulo (ADR-001)", () => {
    const owners = new Map<string, string>();
    for (const m of MODULES) {
      for (const table of m.owns) {
        expect(owners.get(table), `${table} já pertence a ${owners.get(table)}`).toBeUndefined();
        owners.set(table, m.name);
      }
    }
  });
});
