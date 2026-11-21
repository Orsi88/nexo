import { describe, expect, it } from "vitest";
import { NO_CAPABILITIES, type ConnectorCapabilities } from "@painel/contracts";
import { checkConformance, ConnectorRegistry, NotSupportedError, type PipelineConnector } from "../src/index.ts";

const notYet = (op: string) => () => Promise.reject(new NotSupportedError(op, "teste"));

function fakeConnector(extra: Partial<PipelineConnector> = {}): PipelineConnector {
  return {
    kind: "fake",
    contractVersion: "1",
    capabilities: () => Promise.resolve(NO_CAPABILITIES),
    testConnection: notYet("testConnection"),
    listPipelines: notYet("listPipelines"),
    getPipeline: notYet("getPipeline"),
    getParameters: notYet("getParameters"),
    triggerRun: notYet("triggerRun"),
    getRun: notYet("getRun"),
    listRuns: notYet("listRuns"),
    ...extra,
  };
}

describe("checkConformance", () => {
  it("aceita conector sem capacidades opcionais", () => {
    expect(checkConformance(fakeConnector(), NO_CAPABILITIES)).toEqual([]);
  });

  it("acusa capacidade declarada sem método (suporte simulado)", () => {
    const caps: ConnectorCapabilities = { ...NO_CAPABILITIES, write: { ...NO_CAPABILITIES.write, cancelRun: true } };
    expect(checkConformance(fakeConnector(), caps)).toContain("declara suporte a cancelRun mas não o implementa");
  });

  it("acusa método implementado sem capacidade declarada", () => {
    const connector = fakeConnector({ cancelRun: () => Promise.resolve() });
    expect(checkConformance(connector, NO_CAPABILITIES)).toContain("implementa cancelRun mas não declara a capacidade");
  });
});

describe("ConnectorRegistry", () => {
  it("recusa registrar o mesmo kind duas vezes", () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector());
    expect(() => registry.register(fakeConnector())).toThrow("conector já registrado");
  });
});
