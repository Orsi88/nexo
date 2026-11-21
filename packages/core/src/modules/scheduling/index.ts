import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "scheduling". Outros módulos importam só deste arquivo (ADR-001).
// Ainda sem casos de uso: entram nos incrementos do plano (docs/arquitetura.md, §14).

export const schedulingModule: ModuleDescriptor = {
  name: "scheduling",
  responsibility: "Agendamentos internos, leitura dos agendamentos do provedor e prevenção de duplicidade",
  owns: ["schedules"],
  requirements: ["RF-061","RF-070","RN-023","Q-005"],
};
