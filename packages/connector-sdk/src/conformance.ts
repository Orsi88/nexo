import { ConnectorCapabilitiesSchema, type ConnectorCapabilities } from "@painel/contracts";
import { CONNECTOR_CONTRACT_VERSION, type PipelineConnector } from "./connector.ts";

/**
 * Cada capacidade opcional e o método que a implementa.
 * Uma capacidade "true" sem método, ou um método sem capacidade, é inconsistência.
 */
const OPTIONAL_METHODS: Array<[keyof PipelineConnector, (c: ConnectorCapabilities) => boolean]> = [
  ["cancelRun", (c) => c.write.cancelRun],
  ["getLogs", (c) => c.read.logs],
  ["listArtifacts", (c) => c.read.artifacts],
  ["downloadArtifact", (c) => c.read.artifacts],
  ["getSchedules", (c) => c.read.schedules],
  ["getDefinition", (c) => c.read.definition],
  [
    "applyDefinitionChange",
    (c) => c.write.definitionViaApi || c.write.definitionViaCommit || c.write.definitionViaPullRequest,
  ],
  ["parseWebhook", (c) => c.events.webhooks],
];

/** Verificação estática de conformidade de um conector com o contrato (ADR-006). */
export function checkConformance(connector: PipelineConnector, capabilities: ConnectorCapabilities): string[] {
  const problems: string[] = [];
  if (connector.contractVersion !== CONNECTOR_CONTRACT_VERSION) {
    problems.push(`versão de contrato ${connector.contractVersion}, esperada ${CONNECTOR_CONTRACT_VERSION}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(connector.kind)) {
    problems.push(`kind inválido: ${connector.kind}`);
  }
  const parsed = ConnectorCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) {
    problems.push(`capacidades fora do esquema: ${parsed.error.message}`);
    return problems;
  }
  for (const [method, declared] of OPTIONAL_METHODS) {
    const implemented = typeof connector[method] === "function";
    const claimed = declared(capabilities);
    if (claimed && !implemented) problems.push(`declara suporte a ${method} mas não o implementa`);
    if (!claimed && implemented) problems.push(`implementa ${method} mas não declara a capacidade`);
  }
  if (capabilities.write.definitionViaApi || capabilities.write.definitionViaCommit || capabilities.write.definitionViaPullRequest) {
    if (!capabilities.read.definition) problems.push("edita definição sem conseguir lê-la (sem trava de revisão)");
  }
  return problems;
}
