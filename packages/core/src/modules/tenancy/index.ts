import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "tenancy". Outros módulos importam só deste arquivo (ADR-001).

export const tenancyModule: ModuleDescriptor = {
  name: "tenancy",
  responsibility: "Organizações, workspaces, projetos e membros",
  owns: ["organizations", "workspaces", "projects", "memberships"],
  requirements: ["RF-001", "RF-002", "RF-003", "RF-005", "RF-007", "RN-002", "Q-002"],
};

export * as tenancy from "./repository.ts";
export type { Organization, Workspace, Project, Membership, ListFilter } from "./repository.ts";
export { SLUG_PATTERN } from "./repository.ts";
