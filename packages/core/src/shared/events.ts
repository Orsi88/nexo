import type { Sql } from "../db/database.ts";

// Eventos internos para o tempo real (ADR-010, RF-075). Publicados com pg_notify dentro da
// transação que mudou o dado: só saem se ela confirmar. A api escuta o canal e repassa por SSE a
// quem está na mesma organização. Nunca levam parâmetros, logs ou credenciais: só ids e estado.

export const EVENTS_CHANNEL = "nexo_events";

export interface PlatformEvent {
  /** execution.changed: estado de execução mudou; alert.created: uma regra de evento gerou aviso. */
  type: "execution.changed" | "alert.created";
  organizationId: string;
  executionId: string;
  pipelineId: string;
  status: string;
}

export async function publishEvent(sql: Sql, event: PlatformEvent): Promise<void> {
  await sql.query("SELECT pg_notify($1, $2)", [EVENTS_CHANNEL, JSON.stringify(event)]);
}

export function parseEvent(payload: string | undefined): PlatformEvent | undefined {
  if (!payload) return undefined;
  try {
    const e = JSON.parse(payload) as Partial<PlatformEvent>;
    if ((e.type !== "execution.changed" && e.type !== "alert.created") || typeof e.organizationId !== "string" || typeof e.executionId !== "string") return undefined;
    return {
      type: e.type,
      organizationId: e.organizationId,
      executionId: e.executionId,
      pipelineId: typeof e.pipelineId === "string" ? e.pipelineId : "",
      status: typeof e.status === "string" ? e.status : "",
    };
  } catch {
    return undefined;
  }
}
