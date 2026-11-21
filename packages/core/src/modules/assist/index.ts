import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "assist". Outros módulos importam só deste arquivo (ADR-001).

export const assistModule: ModuleDescriptor = {
  name: "assist",
  responsibility: "Provedores de IA do usuário, servidores MCP, sessões assistidas e propostas de manifesto",
  owns: ["ai_providers", "mcp_servers", "assist_sessions"],
  requirements: ["RF-172", "RF-173", "RF-174", "RF-175", "RF-176", "RF-177", "RF-183", "RF-184", "RF-185", "RF-186", "RN-038", "RN-041", "RN-049"],
};

export * as assist from "./repository.ts";
export type { AiProviderRow, AssistSession, CheckRecord, McpServerRow, McpToolRow, SessionReview, SessionStatus } from "./repository.ts";
