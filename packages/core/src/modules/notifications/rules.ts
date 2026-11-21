import type { ExecutionStatus, ParameterValue, SystemVersion } from "@painel/contracts";

// Regras de evento sem banco: quando uma regra vale para uma execução e como a mensagem é montada.

export type Severity = "info" | "warning" | "critical";
export type Channel = "panel" | "email";

export interface Condition {
  parameter: string;
  /** Valores aceitos; a regra vale se o parâmetro usado for um deles. */
  in: ParameterValue[];
}

export interface RuleMatchInput {
  enabled: boolean;
  pipelineId: string | null;
  onStatus: ExecutionStatus[];
  conditions: Condition[];
}

export interface ExecutionFacts {
  pipelineId: string;
  pipelineName: string;
  status: ExecutionStatus;
  ref: string | null;
  parameters: Record<string, ParameterValue>;
  systemVersion: SystemVersion | null;
  runNumber: string | null;
}

/** Só resultados finais disparam regras: uma execução em andamento ainda pode mudar. */
export const RULE_STATUSES: readonly ExecutionStatus[] = ["succeeded", "failed", "cancelled", "unknown"];

export function ruleMatches(rule: RuleMatchInput, e: ExecutionFacts): boolean {
  if (!rule.enabled) return false;
  if (rule.pipelineId && rule.pipelineId !== e.pipelineId) return false;
  if (!rule.onStatus.includes(e.status)) return false;
  return rule.conditions.every((c) => {
    const actual = e.parameters[c.parameter];
    // Compara como texto também: o provedor pode ter gravado "True" para um booleano (S1, achado 2).
    return actual !== undefined && c.in.some((v) => v === actual || String(v).toLowerCase() === String(actual).toLowerCase());
  });
}

const STATUS_TEXT: Partial<Record<ExecutionStatus, string>> = {
  succeeded: "sucesso",
  failed: "falha",
  cancelled: "cancelada",
  unknown: "indefinida",
};

/**
 * Preenche a mensagem. Variáveis: {pipeline}, {resultado}, {branch}, {versao}, {execucao} e
 * {param:nome}. Variável sem valor vira "—", nunca some em silêncio.
 */
export function renderMessage(template: string, e: ExecutionFacts): string {
  const branch = e.ref ? e.ref.replace(/^refs\/(heads|tags)\//, "") : null;
  const values: Record<string, string | null> = {
    pipeline: e.pipelineName,
    resultado: STATUS_TEXT[e.status] ?? e.status,
    branch,
    versao: e.systemVersion?.full || null,
    execucao: e.runNumber,
  };
  return template
    .replace(/\{param:([A-Za-z][A-Za-z0-9_.-]{0,63})\}/g, (_m, name: string) => {
      const v = e.parameters[name];
      return v === undefined ? "—" : String(v);
    })
    .replace(/\{(pipeline|resultado|branch|versao|execucao)\}/g, (_m, key: string) => values[key] || "—")
    .slice(0, 1000);
}
