import type { ExecutionStatus, FailureKind, ParameterSpec, ParameterValue, PipelineManifest } from "@painel/contracts";
import type { ExternalRunState } from "@painel/connector-sdk";

// Regras do incremento 3 sem banco nem provedor, para serem testadas isoladamente.

/** O que acontece com um pedido, decidido antes de gravar (FLX-005) e mostrado na confirmação (RF-044). */
export type Outcome = "dispatch" | "queue" | "reject" | "blocked";

export interface ResourceState {
  id: string;
  ref: string;
  name: string;
  busyPolicy: "queue" | "reject";
  /** Há lease aberto (vencido ou não) neste recurso. */
  busy: boolean;
  /** Execução que segura o recurso, se houver. */
  heldBy?: { executionId: string; holderKind: "internal" | "external" };
}

export interface Decision {
  outcome: Outcome;
  /** Motivos legíveis, na ordem em que pesaram. */
  reasons: string[];
  /** Pedidos à frente na fila que disputam ao menos um recurso em comum. */
  queuedAhead: number;
}

/** Refs dos recursos exclusivos que o manifesto exige, sem repetição (sem diferenciar maiúsculas). */
export function exclusiveRefs(manifest: PipelineManifest): string[] {
  const seen = new Map<string, string>();
  for (const r of manifest.executionResources) if (r.exclusive && !seen.has(r.ref.toLowerCase())) seen.set(r.ref.toLowerCase(), r.ref);
  return [...seen.values()];
}

/** Valores do perfil, sobrescritos pelos informados no pedido (RF-042, RF-043). */
export function mergeParameters(
  profile: Record<string, ParameterValue> | undefined,
  overrides: Record<string, ParameterValue> | undefined,
): Record<string, ParameterValue> {
  return { ...(profile ?? {}), ...(overrides ?? {}) };
}

/**
 * Decide o destino de um pedido válido ou inválido. Recurso ocupado, ou pedido anterior esperando o
 * mesmo recurso, faz o pedido esperar — ou ser recusado, se algum recurso envolvido recusa fila (CA-007).
 */
export function decide(input: {
  violations: number;
  missingResources: string[];
  resources: ResourceState[];
  queuedAhead: number;
}): Decision {
  const reasons: string[] = [];
  if (input.violations > 0) reasons.push("Há parâmetros inválidos.");
  for (const ref of input.missingResources) {
    reasons.push(`O recurso "${ref}" exigido pelo manifesto não está cadastrado nesta organização.`);
  }
  if (reasons.length) return { outcome: "blocked", reasons, queuedAhead: input.queuedAhead };

  const busy = input.resources.filter((r) => r.busy);
  for (const r of busy) {
    reasons.push(
      r.heldBy?.holderKind === "external"
        ? `O recurso "${r.name}" está ocupado por uma execução iniciada fora da plataforma.`
        : `O recurso "${r.name}" está ocupado por outra execução.`,
    );
  }
  if (input.queuedAhead > 0) {
    reasons.push(input.queuedAhead === 1 ? "Há 1 pedido na frente na fila." : `Há ${input.queuedAhead} pedidos na frente na fila.`);
  }
  if (!busy.length && input.queuedAhead === 0) return { outcome: "dispatch", reasons, queuedAhead: 0 };

  const refusing = input.resources.filter((r) => r.busyPolicy === "reject");
  if (refusing.length) {
    reasons.push(`${refusing.map((r) => `"${r.name}"`).join(", ")} não aceita fila: o pedido é recusado em vez de esperar.`);
    return { outcome: "reject", reasons, queuedAhead: input.queuedAhead };
  }
  return { outcome: "queue", reasons, queuedAhead: input.queuedAhead };
}

/**
 * Traduz o estado lido do provedor para o estado da execução. Falha da pipeline fica com causa
 * "unknown" até a ingestão de resultados dizer se foi teste ou infraestrutura (RN-011, incremento 5).
 * Devolve undefined quando o provedor não sabe dizer: o estado atual fica.
 */
export function fromProvider(
  provider: ExternalRunState["status"],
  current: ExecutionStatus,
): { status: ExecutionStatus; failureKind?: FailureKind } | undefined {
  switch (provider) {
    case "queued":
    case "running":
      return { status: current === "cancelling" ? "cancelling" : "running" };
    case "cancelling":
      return { status: "cancelling" };
    case "succeeded":
      return { status: "succeeded", failureKind: "none" };
    case "failed":
      return { status: "failed", failureKind: "unknown" };
    case "cancelled":
      return { status: "cancelled", failureKind: "none" };
    case "unknown":
      return undefined;
  }
}

/**
 * O YAML pode declarar parâmetros diferentes em cada branch (S1, achado 1). Para executar noutra
 * branch, vale o que ela declara: parâmetro que só existe no manifesto sai; o que só existe na
 * branch entra como o provedor descreve. Quando os dois têm o parâmetro com o mesmo tipo, fica a
 * versão curada do manifesto (rótulo, obrigatoriedade, padrão), com as opções da branch se for
 * lista. Regras entre parâmetros só valem se a branch tem os dois parâmetros envolvidos.
 */
export function manifestForBranch(manifest: PipelineManifest, branchSpecs: readonly ParameterSpec[]): PipelineManifest {
  const curated = new Map(manifest.parameters.map((p) => [p.name, p]));
  const parameters = branchSpecs.map((b): ParameterSpec => {
    const m = curated.get(b.name);
    if (!m || m.type !== b.type) return b;
    if (m.type === "enum" && b.type === "enum") {
      const def = m.default !== undefined && b.options.includes(m.default) ? m.default : b.default;
      return { ...m, options: b.options, ...(def !== undefined ? { default: def } : {}) };
    }
    return m;
  });
  const names = new Set(parameters.map((p) => p.name));
  return {
    ...manifest,
    parameters,
    validationRules: manifest.validationRules.filter((r) => names.has(r.when.parameter) && names.has(r.then.parameter)),
  };
}

/** Mensagem curta, em minutos, para "sem notícia há X". */
export function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m === 1 ? "1 minuto" : `${m} minutos`;
}
