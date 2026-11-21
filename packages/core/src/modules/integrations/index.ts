import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "integrations". Outros módulos importam só deste arquivo (ADR-001).

export const integrationsModule: ModuleDescriptor = {
  name: "integrations",
  responsibility: "Conexões com provedores, credenciais cifradas, teste de conectividade e registro de conectores",
  owns: ["integrations", "data_keys"],
  requirements: ["RF-011", "RF-014", "RF-018", "RF-019", "RF-020", "RF-025", "RF-148", "RN-017"],
};

export * as integrations from "./repository.ts";
export type { Integration, IntegrationStatus, ConnectionCheckRecord } from "./repository.ts";
export { EnvelopeSecretStore, parseMasterKey, type MasterKeys } from "./secret-store.ts";
