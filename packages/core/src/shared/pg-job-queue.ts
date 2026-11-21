import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Sql } from "../db/database.ts";
import type { EnqueueOptions, Job, JobHandler, JobQueue, WorkOptions } from "./job-queue.ts";

// Fila de jobs no PostgreSQL (ADR-004). Cada worker pega jobs prontos com FOR UPDATE SKIP LOCKED,
// então várias instâncias dividem a fila sem pegar o mesmo job. Um job "running" cujo worker morreu
// volta a ficar disponível quando locked_until vence.

/** Cria o job na transação do chamador (outbox). Devolve undefined se já há um igual pendente. */
export async function enqueueJob<T>(sql: Sql, name: string, payload: T, options: EnqueueOptions = {}): Promise<string | undefined> {
  const { rows } = await sql.query<{ id: string }>(
    `INSERT INTO jobs_jobs (name, organization_id, payload, idempotency_key, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, coalesce($5, now()), $6)
     ON CONFLICT (name, idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'running')
     DO NOTHING
     RETURNING id`,
    [
      name,
      options.organizationId ?? null,
      JSON.stringify(payload ?? {}),
      options.idempotencyKey ?? null,
      options.startAfter ?? null,
      options.retryLimit ?? 5,
    ],
  );
  return rows[0]?.id;
}

export interface PgJobQueueOptions {
  /** Intervalo entre buscas quando a fila está vazia. */
  pollMs?: number;
  /** Por quanto tempo um job fica reservado para o worker que o pegou. */
  lockSeconds?: number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export class PgJobQueue implements JobQueue {
  readonly #pool: pg.Pool;
  readonly #workerId = `w-${randomUUID().slice(0, 8)}`;
  readonly #pollMs: number;
  readonly #lockSeconds: number;
  readonly #log: NonNullable<PgJobQueueOptions["log"]>;
  readonly #loops: Promise<void>[] = [];
  #stopping = false;

  constructor(pool: pg.Pool, options: PgJobQueueOptions = {}) {
    this.#pool = pool;
    this.#pollMs = options.pollMs ?? 1000;
    this.#lockSeconds = options.lockSeconds ?? 120;
    this.#log = options.log ?? (() => undefined);
  }

  async enqueue<T>(name: string, payload: T, options?: EnqueueOptions): Promise<string | undefined> {
    return enqueueJob(this.#pool, name, payload, options);
  }

  work<T>(name: string, handler: JobHandler<T>, options: WorkOptions = {}): void {
    for (let i = 0; i < (options.concurrency ?? 1); i++) this.#loops.push(this.#loop(name, handler));
  }

  /** Processa o que estiver pronto agora e volta; útil em testes. Devolve quantos jobs rodou. */
  async drain<T>(name: string, handler: JobHandler<T>, max = 100): Promise<number> {
    let n = 0;
    while (n < max) {
      const job = await this.#claim<T>(name);
      if (!job) break;
      await this.#run(job, handler);
      n++;
    }
    return n;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.all(this.#loops);
  }

  async #loop<T>(name: string, handler: JobHandler<T>): Promise<void> {
    while (!this.#stopping) {
      let job: Job<T> | undefined;
      try {
        job = await this.#claim<T>(name);
      } catch (error) {
        this.#log("error", "falha ao buscar job", { name, error: String(error) });
      }
      if (job) await this.#run(job, handler);
      else await new Promise((r) => setTimeout(r, this.#pollMs));
    }
  }

  async #claim<T>(name: string): Promise<Job<T> | undefined> {
    const { rows } = await this.#pool.query(
      `UPDATE jobs_jobs SET status = 'running', attempts = attempts + 1, locked_by = $2,
              locked_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = (
          SELECT id FROM jobs_jobs
           WHERE name = $1
             AND ((status = 'pending' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
           ORDER BY run_after
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id, name, organization_id, payload, attempts, max_attempts`,
      [name, this.#workerId, this.#lockSeconds],
    );
    const r = rows[0];
    if (!r) return undefined;
    // Um job que estourou o limite de tentativas (o worker morreu no meio, de novo e de novo) para aqui.
    if (r.attempts > r.max_attempts) {
      await this.#finish(r.id, "failed", "tentativas esgotadas");
      return undefined;
    }
    return { id: r.id, name: r.name, organizationId: r.organization_id, payload: r.payload as T, attempt: r.attempts };
  }

  async #run<T>(job: Job<T>, handler: JobHandler<T>): Promise<void> {
    try {
      const result = await handler(job);
      if (result && "again" in result) {
        // Repetição programada, não falha: zera as tentativas.
        await this.#pool.query(
          `UPDATE jobs_jobs SET status = 'pending', attempts = 0, run_after = $2, locked_by = NULL, locked_until = NULL,
                  last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [job.id, result.again],
        );
      } else {
        await this.#finish(job.id, "done", null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "erro desconhecido";
      this.#log("warn", "job falhou", { name: job.name, jobId: job.id, attempt: job.attempt, error: message });
      const { rows } = await this.#pool.query<{ max_attempts: number }>(`SELECT max_attempts FROM jobs_jobs WHERE id = $1`, [job.id]);
      if (job.attempt >= (rows[0]?.max_attempts ?? 1)) {
        await this.#finish(job.id, "failed", message);
      } else {
        const backoffSeconds = Math.min(300, 5 * 2 ** (job.attempt - 1));
        await this.#pool.query(
          `UPDATE jobs_jobs SET status = 'pending', run_after = now() + make_interval(secs => $2), locked_by = NULL,
                  locked_until = NULL, last_error = $3, updated_at = now()
            WHERE id = $1`,
          [job.id, backoffSeconds, message],
        );
      }
    }
  }

  async #finish(id: string, status: "done" | "failed", error: string | null): Promise<void> {
    await this.#pool.query(
      `UPDATE jobs_jobs SET status = $2, last_error = coalesce($3, last_error), locked_by = NULL, locked_until = NULL,
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, status, error],
    );
  }
}
