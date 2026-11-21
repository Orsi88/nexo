import type { ExternalRunState } from "@painel/connector-sdk";

// Tradução dos estados da API Build (_apis/build/builds) para o vocabulário da plataforma.
// A API REST devolve texto ("completed"); alguns clientes devolvem os números do enum.
// Os dois foram observados no spike S1 (docs/spikes/S1-azure-devops.md, achado 3).

const STATUS_BY_NUMBER: Record<number, string> = {
  1: "inProgress",
  2: "completed",
  4: "cancelling",
  8: "postponed",
  32: "notStarted",
};

const RESULT_BY_NUMBER: Record<number, string> = {
  0: "none",
  2: "succeeded",
  4: "partiallySucceeded",
  8: "failed",
  32: "canceled",
};

function name(value: unknown, table: Record<number, string>): string {
  if (typeof value === "number") return table[value] ?? `unknown(${value})`;
  if (typeof value === "string" && value !== "") return value;
  return "none";
}

/** Reasons que indicam execução iniciada pelo próprio Azure (gatilho), não por pessoa ou pela plataforma. */
const AUTOMATIC_REASONS = new Set([
  "schedule",
  "individualCI",
  "batchedCI",
  "pullRequest",
  "buildCompletion",
  "resourceTrigger",
  "triggered",
]);
const REASON_BY_NUMBER: Record<number, string> = {
  1: "manual",
  2: "individualCI",
  4: "batchedCI",
  8: "schedule",
  256: "pullRequest",
  512: "buildCompletion",
  1024: "resourceTrigger",
  64: "userCreated",
  128: "validateShelveset",
  16: "scheduleForced",
};

export function translateBuildStatus(
  statusValue: unknown,
  resultValue: unknown,
): { status: ExternalRunState["status"]; externalStatus: string } {
  const status = name(statusValue, STATUS_BY_NUMBER);
  const result = name(resultValue, RESULT_BY_NUMBER);
  const externalStatus = status === "completed" ? `completed/${result}` : status;
  switch (status) {
    case "notStarted":
    case "postponed":
      return { status: "queued", externalStatus };
    case "inProgress":
      return { status: "running", externalStatus };
    case "cancelling":
      return { status: "cancelling", externalStatus };
    case "completed":
      // partiallySucceeded: algum passo com continueOnError falhou, mas a execução seguiu e
      // terminou. O detalhe fica em externalStatus para não esconder (RN-044).
      switch (result) {
        case "succeeded":
        case "partiallySucceeded":
          return { status: "succeeded", externalStatus };
        case "failed":
          return { status: "failed", externalStatus };
        case "canceled":
          return { status: "cancelled", externalStatus };
        default:
          return { status: "unknown", externalStatus };
      }
    default:
      return { status: "unknown", externalStatus };
  }
}

/**
 * true quando o próprio Azure iniciou a execução (agenda, CI, PR...). Para disparo manual a resposta
 * é undefined: pode ter sido uma pessoa no Azure ou a plataforma, e só a plataforma sabe o que ela mesma disparou.
 */
export function startedByProvider(reasonValue: unknown): boolean | undefined {
  const reason = name(reasonValue, REASON_BY_NUMBER);
  return AUTOMATIC_REASONS.has(reason) || reason === "scheduleForced" ? true : undefined;
}
