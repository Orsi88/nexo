import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "notifications". Outros módulos importam só deste arquivo (ADR-001).

export const notificationsModule: ModuleDescriptor = {
  name: "notifications",
  responsibility: "Regras de evento, avisos no painel e (incremento 7) envio de e-mail; histórico de envios",
  owns: ["rules", "alerts", "emails"],
  requirements: ["RF-126", "RF-130", "RN-019"],
};

export * as notifications from "./repository.ts";
export * as emails from "./emails.ts";
export type { EmailHistoryItem, EmailKind, EmailStatus, NewEmail, OutgoingEmail } from "./emails.ts";
export type { NotificationRule, Alert, RuleFields } from "./repository.ts";
export { renderMessage, ruleMatches, RULE_STATUSES, type Channel, type Condition, type ExecutionFacts, type Severity } from "./rules.ts";
