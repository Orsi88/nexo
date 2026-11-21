// Estados explícitos (RNF-025, RN-011, RN-012 e §20.3 da especificação).

export const EXECUTION_STATUSES = [
  "queued",
  "rejected",
  "dispatching",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "stale",
  "unknown",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Por que uma execução falhou: falha de infraestrutura nunca é falha de teste (RN-011). */
export const FAILURE_KINDS = ["none", "test", "infrastructure", "threshold", "unknown"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Estado de um processador de relatório (§20.3). */
export const PROCESSING_STATUSES = ["pending", "processing", "processed", "partial", "unsupported", "failed"] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/** Situação dos relatórios de uma execução; "missing" representa a ausência explicitamente (RN-012). */
export const REPORT_STATUSES = ["pending", "available", "partial", "missing", "invalid"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Estado de sincronização de um dado vindo do provedor (RNF-025). */
export const SYNC_STATES = ["synchronized", "pending", "unknown"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** Categorias de resultado mantidas semanticamente separadas (RN-045, §20.2). */
export const RESULT_CATEGORIES = ["functional", "api", "performance"] as const;
export type ResultCategory = (typeof RESULT_CATEGORIES)[number];
