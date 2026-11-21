import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "resources". Outros módulos importam só deste arquivo (ADR-001).

export const resourcesModule: ModuleDescriptor = {
  name: "resources",
  responsibility: "Catálogo de executores, grupos de exclusividade, reservas e leases",
  owns: ["resources", "leases"],
  requirements: ["RF-049", "RF-078", "RF-079", "RF-169", "RN-005", "RN-006", "RN-007", "Q-010"],
};

/**
 * Leases de recurso exclusivo (ADR-009, FLX-005): uma linha no banco com validade, consistente com
 * várias instâncias; um worker que morre não prende o recurso para sempre, porque o lease vence e o
 * reconciliador consulta o provedor antes de liberar (RF-060).
 */
export * as resources from "./repository.ts";
export type { Resource, Lease, BusyPolicy, HolderKind } from "./repository.ts";
