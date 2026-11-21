import pg from "pg";
import {
  AssistService,
  Database,
  EmailSender,
  FoundationService,
  OnboardingService,
  EnvelopeSecretStore,
  evaluateRules,
  ExecutionEngine,
  FileArtifactStore,
  JOBS,
  parseMasterKey,
  PgJobQueue,
  ProviderAccess,
  ResultsIngestor,
  RetentionRunner,
} from "@painel/core";
import { buildRegistries } from "./registry.ts";
import { describeSmtp, smtpMailer } from "./mailer.ts";

// Worker: processa a fila de jobs no PostgreSQL (ADR-004). Incremento 3: disparo, acompanhamento,
// cancelamento, leitura de execuções externas e a rotina periódica (fila, execuções sem notícia,
// leases vencidos). Várias instâncias podem rodar juntas: cada job é pego por uma só.

const log = (level: "info" | "warn" | "error", msg: string, data: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...data }));

const url = process.env.DATABASE_URL;
if (!url) {
  log("error", "DATABASE_URL não definida");
  process.exit(1);
}

const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

const pool = new pg.Pool({ connectionString: url, max: int("WORKER_DB_POOL", 10) });
const db = new Database(pool);
const extraHosts = (process.env.AZURE_DEVOPS_EXTRA_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const hosts = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
const { connectors, processors } = buildRegistries({ azureDevOpsExtraHosts: extraHosts, gitHubExtraHosts: hosts("GITHUB_EXTRA_HOSTS") });

await pool.query("SELECT 1");

const queue = new PgJobQueue(pool, { log, pollMs: int("WORKER_POLL_MS", 1000) });
const tickSeconds = int("WORKER_TICK_SECONDS", 30);
let ticker: NodeJS.Timeout | undefined;
const artifactStore = new FileArtifactStore(process.env.ARTIFACTS_DIR || "./data/artifacts");
const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:8080";

// E-mail (incremento 7): só com SMTP configurado. Sem ele, a fila de e-mail nem recebe nada.
const smtpUrl = process.env.SMTP_URL;
if (smtpUrl) {
  const sender = new EmailSender(db, smtpMailer(smtpUrl, process.env.SMTP_FROM || "Nexo <nexo@localhost>"), log);
  queue.work<{ emailId: string }>(JOBS.email, (job) => sender.handle(job), { concurrency: int("EMAIL_CONCURRENCY", 2) });
  log("info", "envio de e-mail ligado", { smtp: describeSmtp(smtpUrl) });
}

// Retenção (incremento 7): uma vez por hora, com chave por hora para várias instâncias não repetirem.
const retention = new RetentionRunner(db, artifactStore, { log });
queue.work(JOBS.retention, async () => {
  const summary = await retention.run();
  const touched = summary.filter((s) => s.artifacts || s.tests || s.performance || s.emails);
  if (touched.length) log("info", "retenção aplicada", { organizations: touched.length });
});
const scheduleRetention = () =>
  queue
    .enqueue(JOBS.retention, {}, { idempotencyKey: `retention:${new Date().toISOString().slice(0, 13)}`, retryLimit: 1 })
    .catch((error: unknown) => log("error", "falha ao agendar retenção", { error: String(error) }));
await scheduleRetention();
const retentionTimer = setInterval(() => void scheduleRetention(), 3600 * 1000);

if (process.env.SECRETS_MASTER_KEY) {
  const secrets = new EnvelopeSecretStore(db, parseMasterKey(process.env.SECRETS_MASTER_KEY));
  const provider = new ProviderAccess(db, secrets, connectors);
  const engine = new ExecutionEngine(db, provider, {
    pollSeconds: int("EXECUTION_POLL_SECONDS", 15),
    staleAfterSeconds: int("EXECUTION_STALE_AFTER_SECONDS", 600),
    externalLookbackHours: int("EXTERNAL_RUNS_LOOKBACK_HOURS", 24),
    syncRunsEverySeconds: int("EXTERNAL_RUNS_SYNC_SECONDS", 120),
    log,
  });
  const handlers = engine.handlers();
  queue.work(JOBS.dispatch, handlers[JOBS.dispatch]!, { concurrency: 2 });
  queue.work(JOBS.track, handlers[JOBS.track]!, { concurrency: 4 });
  queue.work(JOBS.cancel, handlers[JOBS.cancel]!, { concurrency: 1 });
  queue.work(JOBS.syncRuns, handlers[JOBS.syncRuns]!, { concurrency: 2 });
  queue.work(JOBS.tick, handlers[JOBS.tick]!, { concurrency: 1 });
  // Regras de evento: avaliadas quando a execução termina, sem atrasar a conclusão (RN-019).
  queue.work<{ executionId: string }>(JOBS.notify, async (job) => {
    if (!job.organizationId) return;
    await evaluateRules(db, job.organizationId, job.payload.executionId, { baseUrl, emailEnabled: Boolean(smtpUrl) });
  });

  // Relatórios (incremento 5): os artefatos originais ficam em ARTIFACTS_DIR (um volume no Docker).
  const ingestor = new ResultsIngestor(db, provider, processors, artifactStore, {
    maxArtifactBytes: int("ARTIFACT_MAX_MB", 500) * 1024 * 1024,
    log,
  });
  queue.work<{ executionId: string }>(JOBS.ingest, (job) => ingestor.handle(job), { concurrency: int("INGEST_CONCURRENCY", 2) });

  // Sessões assistidas por IA (incremento 8): só leitura; a proposta espera a revisão de uma pessoa.
  const foundation = new FoundationService(db);
  const assist = new AssistService(db, foundation, secrets, new OnboardingService(db, foundation, secrets, connectors));
  queue.work<{ sessionId: string }>(JOBS.assist, assist.handler(provider), { concurrency: int("ASSIST_CONCURRENCY", 2) });

  // A rotina periódica entra na fila com chave fixa: com várias instâncias, roda uma por vez.
  const scheduleTick = () =>
    queue.enqueue(JOBS.tick, {}, { idempotencyKey: "tick", retryLimit: 1 }).catch((error: unknown) => log("error", "falha ao agendar rotina", { error: String(error) }));
  await scheduleTick();
  ticker = setInterval(() => void scheduleTick(), tickSeconds * 1000);
} else {
  log("warn", "SECRETS_MASTER_KEY não definida: execuções desligadas (sem acesso às credenciais dos provedores)");
}

log("info", "worker iniciado", { connectors: connectors.kinds(), tickSeconds });

async function shutdown(signal: string) {
  log("info", "encerrando", { signal });
  if (ticker) clearInterval(ticker);
  clearInterval(retentionTimer);
  await queue.stop();
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
