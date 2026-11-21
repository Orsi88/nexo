import { describe, expect, it } from "vitest";
import type { PipelineManifest } from "@painel/contracts";
import { decide, exclusiveRefs, fromProvider, manifestForBranch, mergeParameters, parseEvent, queuePositions, type ResourceState } from "../src/index.ts";

// Regras do incremento 3 que não dependem de navegador: decisão do pedido (FLX-005, CA-007),
// tradução do estado do provedor (RN-011), posição na fila (RF-051) e eventos do SSE.

const free = (over: Partial<ResourceState> = {}): ResourceState => ({
  id: "r1",
  ref: "maquina-playwright",
  name: "Máquina Playwright",
  busyPolicy: "queue",
  busy: false,
  ...over,
});

describe("decide", () => {
  it("dispara na hora sem recurso exclusivo", () => {
    expect(decide({ violations: 0, missingResources: [], resources: [], queuedAhead: 0 })).toEqual({
      outcome: "dispatch",
      reasons: [],
      queuedAhead: 0,
    });
  });

  it("dispara na hora com o recurso livre e ninguém na frente", () => {
    expect(decide({ violations: 0, missingResources: [], resources: [free()], queuedAhead: 0 }).outcome).toBe("dispatch");
  });

  it("bloqueia parâmetro inválido e recurso não cadastrado, antes de olhar a ocupação (CA-006)", () => {
    const d = decide({ violations: 2, missingResources: ["maquina-x"], resources: [free({ busy: true })], queuedAhead: 3 });
    expect(d.outcome).toBe("blocked");
    expect(d.reasons).toHaveLength(2);
    expect(d.reasons[1]).toContain("maquina-x");
  });

  it("espera na fila quando o recurso está ocupado (CA-007)", () => {
    const d = decide({ violations: 0, missingResources: [], resources: [free({ busy: true })], queuedAhead: 0 });
    expect(d.outcome).toBe("queue");
    expect(d.reasons[0]).toContain("ocupado");
  });

  it("espera atrás de quem pediu antes, mesmo com o recurso livre (FIFO)", () => {
    const d = decide({ violations: 0, missingResources: [], resources: [free()], queuedAhead: 2 });
    expect(d).toMatchObject({ outcome: "queue", queuedAhead: 2 });
  });

  it("recusa em vez de esperar quando o recurso não aceita fila (CA-007)", () => {
    const d = decide({ violations: 0, missingResources: [], resources: [free({ busy: true, busyPolicy: "reject" })], queuedAhead: 0 });
    expect(d.outcome).toBe("reject");
    expect(d.reasons.at(-1)).toContain("não aceita fila");
  });

  it("diz quando quem ocupa é uma execução iniciada fora da plataforma (RN-007)", () => {
    const d = decide({
      violations: 0,
      missingResources: [],
      resources: [free({ busy: true, heldBy: { executionId: "e1", holderKind: "external" } })],
      queuedAhead: 0,
    });
    expect(d.reasons[0]).toContain("fora da plataforma");
  });
});

describe("fromProvider", () => {
  it("falha da pipeline fica com causa desconhecida até a ingestão (RN-011)", () => {
    expect(fromProvider("failed", "running")).toEqual({ status: "failed", failureKind: "unknown" });
  });

  it("mantém o cancelamento pedido enquanto o provedor ainda roda", () => {
    expect(fromProvider("running", "cancelling")).toEqual({ status: "cancelling" });
    expect(fromProvider("queued", "running")).toEqual({ status: "running" });
  });

  it("estados finais", () => {
    expect(fromProvider("succeeded", "running")).toEqual({ status: "succeeded", failureKind: "none" });
    expect(fromProvider("cancelled", "cancelling")).toEqual({ status: "cancelled", failureKind: "none" });
  });

  it("provedor sem resposta clara não muda o estado", () => {
    expect(fromProvider("unknown", "running")).toBeUndefined();
  });
});

describe("parâmetros e recursos do manifesto", () => {
  it("o pedido sobrescreve o perfil (RF-042, RF-043)", () => {
    expect(mergeParameters({ navegador: "chromium", limpar: true }, { navegador: "firefox" })).toEqual({ navegador: "firefox", limpar: true });
    expect(mergeParameters(undefined, undefined)).toEqual({});
  });

  it("só recursos exclusivos, sem repetição", () => {
    const manifest = {
      executionResources: [
        { ref: "maquina-playwright", exclusive: true },
        { ref: "Maquina-Playwright", exclusive: true },
        { ref: "pool-compartilhado", exclusive: false },
      ],
    } as PipelineManifest;
    expect(exclusiveRefs(manifest)).toEqual(["maquina-playwright"]);
  });
});

describe("queuePositions", () => {
  it("só disputa posição com quem pede recurso em comum (RF-051)", () => {
    const positions = queuePositions([
      { id: "a", resourceIds: ["r1"] },
      { id: "b", resourceIds: ["r2"] },
      { id: "c", resourceIds: ["r1", "r2"] },
      { id: "d", resourceIds: [] },
    ]);
    expect(Object.fromEntries(positions)).toEqual({ a: 1, b: 1, c: 3, d: 1 });
  });
});

describe("parseEvent", () => {
  it("aceita só o formato conhecido", () => {
    const ok = parseEvent(JSON.stringify({ type: "execution.changed", organizationId: "o", executionId: "e", pipelineId: "p", status: "running" }));
    expect(ok).toEqual({ type: "execution.changed", organizationId: "o", executionId: "e", pipelineId: "p", status: "running" });
    expect(parseEvent("não é json")).toBeUndefined();
    expect(parseEvent(JSON.stringify({ type: "outro" }))).toBeUndefined();
    expect(parseEvent(undefined)).toBeUndefined();
  });
});

describe("manifestForBranch (o YAML muda por branch)", () => {
  const manifest = {
    parameters: [
      { name: "branchApp", type: "string", label: "Branch da aplicação", default: "main", required: true, scope: "provider" },
      { name: "limparDados", type: "boolean", default: true, required: false, scope: "provider" },
      { name: "navegador", type: "enum", options: ["chromium", "firefox"], default: "firefox", required: false, scope: "provider" },
      { name: "soNoManifesto", type: "string", required: false, scope: "provider" },
    ],
    validationRules: [
      { id: "r1", message: "m", when: { parameter: "limparDados", equals: true }, then: { parameter: "navegador", in: ["chromium"] } },
      { id: "r2", message: "m", when: { parameter: "soNoManifesto", equals: "x" }, then: { parameter: "navegador", in: ["chromium"] } },
    ],
  } as unknown as PipelineManifest;

  it("vale o que a branch declara, com a curadoria do manifesto onde coincide", () => {
    const branch = [
      { name: "branchApp", type: "string", default: "develop", required: false, scope: "provider" },
      { name: "navegador", type: "enum", options: ["chromium", "webkit"], default: "chromium", required: false, scope: "provider" },
      { name: "suite", type: "enum", options: ["regressao", "smoke"], default: "regressao", required: false, scope: "provider" },
    ] as PipelineManifest["parameters"];
    const m = manifestForBranch(manifest, branch);
    expect(m.parameters.map((p) => p.name)).toEqual(["branchApp", "navegador", "suite"]);
    // Rótulo e obrigatoriedade do manifesto; opções da branch; padrão do manifesto só se ainda for opção.
    expect(m.parameters[0]).toMatchObject({ label: "Branch da aplicação", required: true, default: "main" });
    expect(m.parameters[1]).toMatchObject({ options: ["chromium", "webkit"], default: "chromium" });
    // Regras que citam parâmetro que a branch não tem caem.
    expect(m.validationRules).toEqual([]);
  });

  it("tipo diferente na branch: vale o da branch", () => {
    const m = manifestForBranch(manifest, [{ name: "limparDados", type: "string", required: false, scope: "provider" }] as PipelineManifest["parameters"]);
    expect(m.parameters).toEqual([{ name: "limparDados", type: "string", required: false, scope: "provider" }]);
  });
});
