import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "audit". Outros módulos importam só deste arquivo (ADR-001).

export const auditModule: ModuleDescriptor = {
  name: "audit",
  responsibility: "Registro append-only das operações críticas e consulta",
  owns: ["audit_events"],
  requirements: ["RF-139", "RF-160", "RF-183", "RN-020", "RNF-021"],
};

export { recordAudit, listAudit, scrubDetails } from "./record.ts";
export type { AuditEvent, AuditEventInput, AuditQuery, AuditOutcome, AuditActorKind } from "./record.ts";
