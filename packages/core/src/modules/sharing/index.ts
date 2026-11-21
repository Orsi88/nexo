import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "sharing". Outros módulos importam só deste arquivo (ADR-001).

export const sharingModule: ModuleDescriptor = {
  name: "sharing",
  responsibility: "Links públicos e autenticados, projeção sanitizada, revogação e prévia do visitante",
  owns: ["share_links"],
  requirements: ["RF-119", "RF-120", "RF-121", "RF-122", "RF-123", "RF-124", "RF-125", "RN-015", "RN-016", "RN-046", "RN-047", "Q-003"],
};

export * as sharing from "./repository.ts";
export type { ShareAccess, ShareLink, ShareScope } from "./repository.ts";
export {
  ALWAYS_OMITTED,
  branchName,
  DEFAULT_SHARE_OPTIONS,
  isSensitiveName,
  publicParameters,
  sanitizeShareOptions,
  scrubText,
  versionText,
  type PublicExecution,
  type PublicPerformance,
  type PublicRun,
  type PublicTest,
  type PublicView,
  type ShareOptions,
} from "./projection.ts";
