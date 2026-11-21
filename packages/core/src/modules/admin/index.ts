import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "admin". Outros módulos importam só deste arquivo (ADR-001).

export const adminModule: ModuleDescriptor = {
  name: "admin",
  responsibility: "Configurações da organização: retenção, política de compartilhamento, limites e reprocessamento",
  owns: ["org_settings"],
  requirements: ["RF-143", "RF-146", "RF-150", "RN-021", "Q-008"],
};

export * as orgSettings from "./settings.ts";
export { DEFAULT_SETTINGS, sanitizeSettings, type OrgSettings, type RetentionPolicy, type SharingPolicy } from "./settings.ts";
