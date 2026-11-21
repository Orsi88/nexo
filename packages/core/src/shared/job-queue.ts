/**
 * Fila de jobs persistente e reprocessável (ADR-004, RNF-023). A implementação usa o PostgreSQL
 * (pg-job-queue.ts). O job nasce na mesma transação que o dado que o originou (outbox): use
 * `enqueueJob(sql, ...)` dentro da transação do caso de uso.
 */
export interface JobQueue {
  enqueue<T>(name: string, payload: T, options?: EnqueueOptions): Promise<string | undefined>;
  work<T>(name: string, handler: JobHandler<T>, options?: WorkOptions): void;
  stop(): Promise<void>;
}

export interface EnqueueOptions {
  /** Organização de destino: o worker abre a transação do job com este contexto (RLS). */
  organizationId?: string;
  /** Evita dois jobs pendentes para o mesmo efeito (RNF-010, RF-057). */
  idempotencyKey?: string;
  startAfter?: Date;
  /** Tentativas antes de desistir (padrão 5). */
  retryLimit?: number;
}

export interface WorkOptions {
  concurrency?: number;
}

export interface Job<T> {
  id: string;
  name: string;
  organizationId: string | null;
  payload: T;
  attempt: number;
}

/**
 * O handler termina o job retornando nada, ou pede para rodá-lo de novo mais tarde (`again`),
 * sem contar como falha — é assim que o acompanhamento de uma execução se repete enquanto ela corre.
 * Exceção = falha: o job volta com espera crescente até esgotar as tentativas.
 */
export type JobHandler<T> = (job: Job<T>) => Promise<void | { again: Date }>;
