import { describe, expect, it } from "vitest";
import { checkAiProposal, toolsExposableToModel } from "../src/index.ts";

describe("checkAiProposal", () => {
  it("rejeita proposta inválida e explica o motivo (CA-028)", () => {
    const result = checkAiProposal({ schemaVersion: "1", pipeline: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
  });

  it("força rascunho com aprovação humana mesmo que a IA marque como aprovada", () => {
    const result = checkAiProposal({
      schemaVersion: "1",
      organizationRef: "o",
      projectRef: "p",
      provider: { kind: "azure-devops", integrationRef: "i" },
      pipeline: { externalId: "1", displayName: "x" },
      review: { status: "approved", requiresHumanApproval: false },
    });
    expect(result.ok && result.manifest.review).toEqual({ status: "draft", requiresHumanApproval: true });
  });
});

describe("toolsExposableToModel", () => {
  it("expõe só ferramentas de leitura autorizadas (RF-176, RF-182)", () => {
    const tools = toolsExposableToModel(
      [
        { server: "ado", tool: "list_pipelines", kind: "read" },
        { server: "ado", tool: "run_pipeline", kind: "mutate" },
        { server: "ado", tool: "get_logs", kind: "read" },
      ],
      new Set(["ado/list_pipelines", "ado/run_pipeline"]),
    );
    expect(tools.map((t) => t.tool)).toEqual(["list_pipelines"]);
  });
});
