import type { ModuleDescriptor } from "../../shared/module.ts";

export const accessModule: ModuleDescriptor = {
  name: "access",
  responsibility: "Política de autorização (papel × escopo × operação), sempre avaliada no servidor",
  owns: ["policies"],
  requirements: ["RF-134", "RF-135", "RF-136", "RF-137", "RF-138", "RN-003", "RN-040", "RNF-007"],
};

export const ROLES = ["admin", "manager", "operator", "reader"] as const;
export type Role = (typeof ROLES)[number];

export const OPERATIONS = [
  "view",
  "execute",
  "cancel",
  "configurePipelines",
  "manageIntegrations",
  "createProjects",
  "manageUsers",
  "share",
  "viewAudit",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** "policy" = depende da política configurada pela organização ("Conforme política" no §6). */
export type Grant = "allow" | "deny" | "policy";

/**
 * Matriz de papéis do §6 da especificação, que está "sujeita a validação".
 * Links compartilhados não têm papel: são tratados em sharing e só leem projeções (RN-015).
 */
export const ROLE_MATRIX: Record<Role, Record<Operation, Grant>> = {
  admin: {
    view: "allow",
    execute: "allow",
    cancel: "allow",
    configurePipelines: "allow",
    manageIntegrations: "allow",
    createProjects: "allow",
    manageUsers: "allow",
    share: "allow",
    viewAudit: "allow",
  },
  manager: {
    view: "allow",
    execute: "allow",
    cancel: "allow",
    configurePipelines: "allow",
    manageIntegrations: "policy",
    createProjects: "allow",
    manageUsers: "policy",
    share: "allow",
    viewAudit: "policy",
  },
  operator: {
    view: "allow",
    execute: "allow",
    cancel: "policy",
    configurePipelines: "policy",
    manageIntegrations: "deny",
    createProjects: "deny",
    manageUsers: "deny",
    share: "policy",
    viewAudit: "deny",
  },
  reader: {
    view: "allow",
    execute: "deny",
    cancel: "deny",
    configurePipelines: "deny",
    manageIntegrations: "deny",
    createProjects: "deny",
    manageUsers: "deny",
    share: "deny",
    viewAudit: "deny",
  },
};

/** Permissões que a organização concedeu nos casos "policy", por papel. */
export type OrganizationPolicy = Partial<Record<Role, Operation[]>>;

export function canPerform(role: Role, operation: Operation, policy: OrganizationPolicy = {}): boolean {
  const grant = ROLE_MATRIX[role][operation];
  if (grant === "allow") return true;
  if (grant === "deny") return false;
  return policy[role]?.includes(operation) ?? false;
}

export { getPolicy, savePolicy, sanitizePolicy } from "./policies.ts";
