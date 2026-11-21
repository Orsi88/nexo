import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "insights". Outros módulos importam só deste arquivo (ADR-001).
// Ainda sem casos de uso: entram nos incrementos do plano (docs/arquitetura.md, §14).

export const insightsModule: ModuleDescriptor = {
  name: "insights",
  responsibility: "Indicadores e dashboards (consultas de leitura e agregações)",
  owns: ["dashboards","saved_views"],
  requirements: ["RF-106","RF-118","RN-022"],
};
