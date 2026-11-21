/** Nomes dos jobs do incremento 3 (fila no PostgreSQL, ADR-004). */
export const JOBS = {
  /** Tenta reservar os recursos e disparar no provedor. Payload: { executionId }. */
  dispatch: "execution.dispatch",
  /** Lê o estado no provedor, renova leases, finaliza. Repete enquanto a execução corre. Payload: { executionId }. */
  track: "execution.track",
  /** Pede o cancelamento ao provedor. Payload: { executionId }. */
  cancel: "execution.cancel",
  /** Lê as execuções do provedor para achar as iniciadas fora da plataforma (RF-052). Payload: { pipelineId }. */
  syncRuns: "execution.sync-runs",
  /** Avalia as regras de evento de uma execução que terminou. Payload: { executionId }. */
  notify: "execution.notify",
  /** Baixa os artefatos de uma execução que terminou e processa os relatórios. Payload: { executionId }. */
  ingest: "results.ingest",
  /** Rotina periódica: fila, execuções sem notícia, leases vencidos e leitura de execuções externas. */
  tick: "execution.tick",
  /** Envia um e-mail da fila de saída. Payload: { emailId }. Incremento 7. */
  email: "notifications.email",
  /** Aplica a política de retenção de todas as organizações. Incremento 7. */
  retention: "admin.retention",
  /** Roda uma sessão assistida por IA (proposta de manifesto). Payload: { sessionId }. Incremento 8. */
  assist: "assist.run",
} as const;
