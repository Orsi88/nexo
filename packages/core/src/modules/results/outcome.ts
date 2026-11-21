import type { ExecutionStatus, FailureKind, ReportStatus } from "@painel/contracts";
import type { ReportOutcome } from "./repository.ts";

export interface OutcomeInput {
  status: ExecutionStatus;
  /** Situação de cada relatório reconhecido nos artefatos. */
  reports: readonly ReportOutcome[];
  /** Testes que falharam (instáveis não contam: passaram numa nova tentativa). */
  failedTests: number;
  /** Algum artefato não pôde ser baixado ou lido. */
  artifactErrors: number;
  /** Thresholds de desempenho (k6) que não foram atendidos. */
  failedThresholds?: number;
}

/**
 * Situação dos relatórios (RN-012) e tipo de falha (RN-011) de uma execução que terminou:
 * - sem relatório reconhecido → "missing" (a ausência fica explícita, nunca vira "0 testes");
 * - só relatórios inválidos → "invalid"; alguns problemas → "partial"; senão "available";
 * - falhou com teste falhando → "test"; falhou sem relatório utilizável ou com todos os testes
 *   passando → "infrastructure" (falha de infraestrutura nunca é falha de teste);
 * - falhou sem teste falhando mas com threshold do k6 não atendido → "threshold" (CA-045): o
 *   limite de desempenho fica explícito e não se confunde com falha de infraestrutura.
 */
export function classifyOutcome(input: OutcomeInput): { reportStatus: ReportStatus; failureKind: FailureKind } {
  const usable = input.reports.filter((r) => r === "processed" || r === "partial").length;
  const broken = input.reports.length - usable;
  let reportStatus: ReportStatus;
  if (!input.reports.length) reportStatus = "missing";
  else if (!usable) reportStatus = "invalid";
  else if (broken || input.artifactErrors || input.reports.includes("partial")) reportStatus = "partial";
  else reportStatus = "available";

  let failureKind: FailureKind;
  if (input.status === "failed") failureKind = input.failedTests > 0 ? "test" : (input.failedThresholds ?? 0) > 0 ? "threshold" : "infrastructure";
  else if (input.status === "unknown" || input.status === "stale") failureKind = "unknown";
  else failureKind = "none";
  return { reportStatus, failureKind };
}
