import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "pipelines". Outros módulos importam só deste arquivo (ADR-001).

export const pipelinesModule: ModuleDescriptor = {
  name: "pipelines",
  responsibility: "Pipelines vinculadas, configuração versionada (manifesto), perfis, ambientes e edição de definições externas",
  owns: ["pipelines", "config_versions", "execution_profiles"],
  requirements: ["RF-026", "RF-040", "RF-042", "RF-151", "RF-161", "RF-162", "RF-171", "RN-010", "RN-042", "RN-043"],
};

export * as pipelines from "./repository.ts";
export * as profiles from "./profiles.ts";
export type { LinkedPipeline, ManifestVersion, ManifestSource, ExternalSnapshot } from "./repository.ts";
export type { ExecutionProfile } from "./profiles.ts";
export { compareWithProvider, type ParameterProblem } from "./drift.ts";
