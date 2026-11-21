import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "execution". Outros módulos importam só deste arquivo (ADR-001).

export const executionModule: ModuleDescriptor = {
  name: "execution",
  responsibility: "Pedido, fila, disparo, cancelamento, reexecução, acompanhamento e reconciliação de execuções",
  owns: ["executions", "transitions"],
  requirements: ["RF-041", "RF-060", "RN-004", "RN-005", "RN-008", "RN-009", "RN-025", "Q-007"],
};

export * as executions from "./repository.ts";
export { ACTIVE_STATUSES, FINAL_STATUSES, isFinal, queuePositions } from "./repository.ts";
export type { Execution, ExecutionFilter, ExecutionPatch, Transition, TriggerType } from "./repository.ts";
