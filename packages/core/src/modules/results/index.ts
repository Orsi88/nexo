import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "results". Outros módulos importam só deste arquivo (ADR-001).

export const resultsModule: ModuleDescriptor = {
  name: "results",
  responsibility: "Ingestão de artefatos, processadores e resultados normalizados por categoria",
  owns: ["artifacts", "reports", "functional_tests"],
  requirements: ["RF-086", "RF-105", "RF-188", "RF-194", "RN-011", "RN-012", "RN-014", "RN-045"],
};

export * as results from "./repository.ts";
export type {
  ArtifactStatus,
  FunctionalTest,
  NewFunctionalTest,
  PerformancePoint,
  PerformanceResult,
  ProcessedReport,
  ReportOutcome,
  StoredArtifact,
  TestStatus,
  TestSummary,
} from "./repository.ts";
export { classifyOutcome, type OutcomeInput } from "./outcome.ts";
