import { randomUUID } from "node:crypto";
import type { ExternalArtifact } from "@painel/connector-sdk";
import type { FailureKind, ReportStatus } from "@painel/contracts";
import type { FunctionalTestRecord, PerformanceRecord, ProcessorRegistry, ReportProcessor } from "@painel/processor-sdk";
import type { Database, Sql } from "../db/database.ts";
import type { Actor, FoundationService, OrgActor } from "../foundation/service.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import { publishEvent } from "../shared/events.ts";
import type { Job } from "../shared/job-queue.ts";
import type { ArtifactStore } from "../shared/artifact-store.ts";
import { isZip, readZip, ZipError, type ZipEntry } from "../shared/unzip.ts";
import { executions, isFinal, type Execution } from "../modules/execution/index.ts";
import { pipelines } from "../modules/pipelines/index.ts";
import {
  classifyOutcome,
  results,
  type FunctionalTest,
  type NewFunctionalTest,
  type PerformancePoint,
  type PerformanceResult,
  type ProcessedReport,
  type ReportOutcome,
  type StoredArtifact,
  type TestStatus,
  type TestSummary,
} from "../modules/results/index.ts";
import type { ProviderAccess } from "../execution/provider.ts";

// Incremento 5 — relatórios (FLX-003). Quando uma execução termina, o worker baixa os artefatos
// do provedor, guarda o original (R-007), procura arquivos de relatório dentro deles, passa cada
// um pelo processador que o reconhece e grava os testes normalizados. Depois classifica a
// execução: relatório disponível/parcial/ausente (RN-012) e tipo de falha (RN-011).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_STATUSES: readonly TestStatus[] = ["passed", "failed", "skipped", "flaky"];
/** Arquivos que valem a pena olhar dentro de um artefato (os processadores decidem o resto). */
const CANDIDATE = /\.(xml|json)$/i;
const HEAD_BYTES = 4096;

export interface IngestOptions {
  /** Artefatos lidos por execução. */
  maxArtifacts: number;
  /** Tamanho máximo de um artefato baixado (o zip, como veio). */
  maxArtifactBytes: number;
  /** Arquivos de relatório processados por execução. */
  maxReportFiles: number;
  /** Tamanho máximo de um arquivo de relatório descompactado. */
  maxReportBytes: number;
  /** Tentativas do job antes de desistir e registrar a ausência do relatório. */
  attempts: number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  maxArtifacts: 20,
  maxArtifactBytes: 500 * 1024 * 1024,
  maxReportFiles: 50,
  maxReportBytes: 100 * 1024 * 1024,
  attempts: 4,
};

export interface IngestSummary {
  reportStatus: ReportStatus;
  failureKind: FailureKind;
  artifacts: number;
  reports: number;
  tests: number;
}

async function readLimited(stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new RangeError(`artefato maior que o limite (${Math.round(max / 1024 / 1024)} MB)`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    if (size > max) await stream.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function toTest(r: FunctionalTestRecord): NewFunctionalTest | undefined {
  if (!r || typeof r.name !== "string" || !TEST_STATUSES.includes(r.status)) return undefined;
  const t: NewFunctionalTest = {
    suite: typeof r.suite === "string" ? r.suite : "",
    name: r.name,
    status: r.status,
    attempts: Number.isInteger(r.attempts) && r.attempts > 0 ? r.attempts : 1,
  };
  if (r.file) t.file = r.file;
  if (r.project) t.project = r.project;
  if (typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0) t.durationMs = Math.min(Math.round(r.durationMs), 2_147_483_647);
  if (r.errorMessage) t.errorMessage = r.errorMessage;
  if (r.errorDetails) t.errorDetails = r.errorDetails;
  if (r.attachments?.length) t.attachments = r.attachments;
  return t;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Roda no worker: baixa, guarda, processa e classifica. */
export class ResultsIngestor {
  readonly #db: Database;
  readonly #provider: ProviderAccess;
  readonly #processors: ProcessorRegistry;
  readonly #store: ArtifactStore;
  readonly #options: IngestOptions;

  constructor(db: Database, provider: ProviderAccess, processors: ProcessorRegistry, store: ArtifactStore, options: Partial<IngestOptions> = {}) {
    this.#db = db;
    this.#provider = provider;
    this.#processors = processors;
    this.#store = store;
    this.#options = { ...DEFAULT_INGEST_OPTIONS, ...options };
  }

  /** Handler do job: erro passageiro tenta de novo; na última tentativa registra a ausência. */
  async handle(job: Job<{ executionId: string }>): Promise<void> {
    if (!job.organizationId) return;
    try {
      await this.ingest(job.organizationId, job.payload.executionId);
    } catch (error) {
      if (job.attempt < this.#options.attempts) throw error;
      this.#options.log?.("error", "relatórios não lidos", { executionId: job.payload.executionId, error: String(error) });
      await this.#finish(job.organizationId, job.payload.executionId, { reportStatus: "missing", failureKind: "unknown" });
    }
  }

  async ingest(organizationId: string, executionId: string): Promise<IngestSummary | undefined> {
    const found = await this.#db.tx({ organizationId, userId: null }, async (sql) => {
      const e = await executions.getExecution(sql, organizationId, executionId);
      return e && { e, pipeline: await pipelines.getPipeline(sql, organizationId, e.pipelineId) };
    });
    if (!found?.pipeline || !isFinal(found.e.status)) return undefined;
    const { e, pipeline } = found;

    // Nunca chegou ao provedor (rejeitada, cancelada na fila): não há relatório a esperar.
    if (!e.externalRunId || !pipeline.capabilities.read.artifacts) {
      const outcome = classifyOutcome({ status: e.status, reports: [], failedTests: 0, artifactErrors: 0 });
      return this.#finish(organizationId, executionId, { ...outcome, failureKind: e.externalRunId ? outcome.failureKind : e.failureKind });
    }

    const { connector, conn } = await this.#provider.open(organizationId, pipeline.integrationId, `ingest:${executionId}`);
    if (!connector.listArtifacts || !connector.downloadArtifact) {
      return this.#finish(organizationId, executionId, classifyOutcome({ status: e.status, reports: [], failedTests: 0, artifactErrors: 0 }));
    }
    const run = { externalPipelineId: pipeline.externalId, externalRunId: e.externalRunId };
    const listed = (await connector.listArtifacts(conn, run)).slice(0, this.#options.maxArtifacts);

    let artifactErrors = 0;
    let budget = this.#options.maxReportFiles;
    const outcomes: ReportOutcome[] = [];
    let failedTests = 0;
    let testCount = 0;
    for (const external of listed) {
      const artifact = await this.#artifact(organizationId, e, external, () => connector.downloadArtifact!(conn, external));
      if (!artifact.data) {
        if (artifact.row.status === "failed") artifactErrors++;
        continue;
      }
      let entries: ZipEntry[];
      try {
        entries = isZip(artifact.data)
          ? readZip(artifact.data, { maxEntries: 20_000, maxEntryBytes: this.#options.maxReportBytes, maxTotalBytes: this.#options.maxReportBytes * 5 })
          : [{ name: external.name, size: artifact.data.length, read: () => artifact.data! }];
      } catch (error) {
        artifactErrors++;
        this.#options.log?.("warn", "artefato ilegível", { executionId, artifact: external.name, error: String(error) });
        continue;
      }
      for (const entry of entries) {
        if (budget <= 0) break;
        if (!CANDIDATE.test(entry.name) || entry.size > this.#options.maxReportBytes) continue;
        let content: Buffer;
        try {
          content = entry.read();
        } catch (error) {
          if (error instanceof ZipError) {
            artifactErrors++;
            continue;
          }
          throw error;
        }
        const meta = { name: baseName(entry.name), sizeBytes: content.length, ...(entry.name.endsWith(".json") ? { contentType: "application/json" } : {}) };
        const processor = this.#processors.select(meta, content.subarray(0, HEAD_BYTES));
        if (!processor) continue;
        budget--;
        const report = await this.#process(organizationId, e, artifact.row, entry.name, processor, content);
        if (report.status !== "unsupported") outcomes.push(report.status);
        failedTests += report.failed;
        testCount += report.tests;
      }
    }

    // Lido do banco: conta também o que foi gravado numa tentativa anterior do job.
    const thresholds = await this.#db.tx({ organizationId, userId: null }, (sql) => results.failedThresholds(sql, organizationId, executionId));
    const outcome = classifyOutcome({ status: e.status, reports: outcomes, failedTests, artifactErrors, failedThresholds: thresholds });
    // Cancelada: o tipo de falha continua o que era (o relatório, se houver, fica como parcial).
    const failureKind = e.status === "cancelled" ? e.failureKind : outcome.failureKind;
    await this.#finish(organizationId, executionId, { reportStatus: outcome.reportStatus, failureKind });
    return { reportStatus: outcome.reportStatus, failureKind, artifacts: listed.length, reports: outcomes.length, tests: testCount };
  }

  /** Baixa e guarda o artefato (ou reaproveita o que já foi guardado numa tentativa anterior). */
  async #artifact(
    organizationId: string,
    e: Execution,
    external: ExternalArtifact,
    download: () => Promise<ReadableStream<Uint8Array>>,
  ): Promise<{ row: StoredArtifact; data?: Buffer }> {
    const scope = { organizationId, userId: null };
    const existing = await this.#db.tx(scope, (sql) => results.findArtifact(sql, organizationId, e.id, external.ref));
    if (existing) {
      const data = existing.storageKey ? await this.#store.get(existing.storageKey) : undefined;
      return data ? { row: existing, data } : { row: existing };
    }
    const id = randomUUID();
    const base = { id, executionId: e.id, externalRef: external.ref, name: external.name, sizeBytes: external.sizeBytes ?? null };
    if ((external.sizeBytes ?? 0) > this.#options.maxArtifactBytes) {
      const row = await this.#db.tx(scope, (sql) =>
        results.insertArtifact(sql, organizationId, { ...base, storageKey: null, status: "skipped", reason: "maior que o limite de tamanho" }),
      );
      return { row };
    }
    let data: Buffer;
    try {
      data = await readLimited(await download(), this.#options.maxArtifactBytes);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error; // erro do provedor: o job tenta de novo
      const row = await this.#db.tx(scope, (sql) => results.insertArtifact(sql, organizationId, { ...base, storageKey: null, status: "skipped", reason: error.message }));
      return { row };
    }
    // As chaves saem de ids da plataforma, nunca do nome que o provedor deu.
    const key = `${organizationId}/${e.id}/${id}${isZip(data) ? ".zip" : ".bin"}`;
    await this.#store.put(key, data);
    const row = await this.#db.tx(scope, (sql) =>
      results.insertArtifact(sql, organizationId, { ...base, sizeBytes: data.length, storageKey: key, status: "stored" }),
    );
    // Outro processo ganhou a corrida: o arquivo dele é o que vale.
    if (row.id !== id) await this.#store.delete(key);
    return { row, data };
  }

  async #process(
    organizationId: string,
    e: Execution,
    artifact: StoredArtifact,
    filePath: string,
    processor: ReportProcessor,
    content: Buffer,
  ): Promise<{ status: ReportOutcome; tests: number; failed: number }> {
    let status: ReportOutcome;
    let reason: string | undefined;
    let tests: NewFunctionalTest[] = [];
    let performance: PerformanceRecord[] = [];
    try {
      const output = await processor.process(new Blob([new Uint8Array(content)]).stream(), {
        organizationId,
        executionId: e.id,
        artifactId: artifact.id,
        correlationId: `ingest:${e.id}`,
      });
      status = output.status;
      reason = output.reason;
      if (processor.category === "functional") {
        tests = (output.records as FunctionalTestRecord[]).map(toTest).filter((t): t is NewFunctionalTest => !!t);
      } else if (processor.category === "performance") {
        // Métricas de desempenho vão para a tabela delas, nunca para a de testes (RN-045).
        performance = (output.records as PerformanceRecord[]).filter((r) => r && typeof r === "object" && Array.isArray(r.metrics)).slice(0, 10);
      }
    } catch (error) {
      status = "failed";
      reason = `o processador falhou: ${error instanceof Error ? error.message.slice(0, 300) : "erro"}`;
    }
    const saved = await this.#db.tx({ organizationId, userId: null }, (sql) =>
      results.insertReport(
        sql,
        organizationId,
        e.id,
        { artifactId: artifact.id, filePath, processorId: processor.id, category: processor.category, status, ...(reason ? { reason } : {}) },
        tests,
        performance,
      ),
    );
    if (!saved) {
      // Já processado antes (job repetido): conta o que foi gravado da outra vez.
      const previous = await this.#db.tx({ organizationId, userId: null }, async (sql) => {
        const reports = await results.listReports(sql, organizationId, e.id);
        return reports.find((r) => r.artifactId === artifact.id && r.filePath === filePath.slice(0, 1000) && r.processorId === processor.id);
      });
      const failed = previous ? (await this.#countFailed(organizationId, e.id, previous.id)) : 0;
      return { status: previous?.status ?? status, tests: previous?.tests ?? 0, failed };
    }
    return { status, tests: tests.length, failed: tests.filter((t) => t.status === "failed").length };
  }

  async #countFailed(organizationId: string, executionId: string, reportId: string): Promise<number> {
    return this.#db.tx({ organizationId, userId: null }, async (sql) => {
      const failed = await results.listTests(sql, organizationId, executionId, { status: ["failed"], limit: 2000 });
      return failed.filter((t) => t.reportId === reportId).length;
    });
  }

  async #finish(organizationId: string, executionId: string, outcome: { reportStatus: ReportStatus; failureKind: FailureKind }): Promise<IngestSummary> {
    await this.#db.tx({ organizationId, userId: null }, async (sql) => {
      const e = await executions.getExecution(sql, organizationId, executionId);
      if (!e) return;
      await executions.setReportOutcome(sql, organizationId, executionId, outcome.reportStatus, outcome.failureKind);
      await publishEvent(sql, { type: "execution.changed", organizationId, executionId, pipelineId: e.pipelineId, status: e.status });
    });
    return { ...outcome, artifacts: 0, reports: 0, tests: 0 };
  }
}

export interface ExecutionResults {
  executionId: string;
  reportStatus: ReportStatus;
  failureKind: FailureKind;
  summary: TestSummary | null;
  artifacts: Array<Pick<StoredArtifact, "id" | "name" | "sizeBytes" | "status" | "reason" | "createdAt">>;
  reports: ProcessedReport[];
  tests: FunctionalTest[];
  /** Resumos de desempenho (k6), separados dos testes funcionais (RN-045). */
  performance: PerformanceResult[];
}

/** Leitura dos resultados para a API. */
export class ResultsService {
  readonly #db: Database;
  readonly #foundation: FoundationService;

  constructor(db: Database, foundation: FoundationService) {
    this.#db = db;
    this.#foundation = foundation;
  }

  #scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }

  async executionResults(actor: Actor, id: string, filter: { status?: unknown; search?: unknown; limit?: unknown } = {}): Promise<ExecutionResults> {
    const a = await this.#foundation.authorize(actor, "view");
    if (typeof id !== "string" || !UUID.test(id)) throw notFound("Execução");
    const status = typeof filter.status === "string" && filter.status ? filter.status.split(",") : [];
    if (!status.every((s) => (TEST_STATUSES as readonly string[]).includes(s))) throw new DomainError("invalid", "Filtro de situação inválido.");
    const search = typeof filter.search === "string" ? filter.search.trim().slice(0, 200) : "";
    const limit = Number(filter.limit) || 500;
    return this.#db.tx(this.#scope(a), async (sql: Sql) => {
      const e = await executions.getExecution(sql, a.organization.id, id);
      if (!e) throw notFound("Execução");
      const summary = (await results.summaries(sql, a.organization.id, [e.id])).get(e.id) ?? null;
      return {
        executionId: e.id,
        reportStatus: e.reportStatus,
        failureKind: e.failureKind,
        summary,
        artifacts: (await results.listArtifacts(sql, a.organization.id, e.id)).map(({ id, name, sizeBytes, status, reason, createdAt }) => ({
          id,
          name,
          sizeBytes,
          status,
          reason,
          createdAt,
        })),
        reports: await results.listReports(sql, a.organization.id, e.id),
        tests: await results.listTests(sql, a.organization.id, e.id, {
          ...(status.length ? { status: status as TestStatus[] } : {}),
          ...(search ? { search } : {}),
          limit,
        }),
        performance: await results.listPerformance(sql, a.organization.id, e.id),
      };
    });
  }

  /** Série histórica de desempenho da pipeline (dashboard de desempenho, RF-190, RF-193). */
  async pipelinePerformance(actor: Actor, pipelineId: string, limit?: unknown): Promise<PerformancePoint[]> {
    const a = await this.#foundation.authorize(actor, "view");
    if (typeof pipelineId !== "string" || !UUID.test(pipelineId)) throw notFound("Pipeline");
    return this.#db.tx(this.#scope(a), async (sql: Sql) => {
      if (!(await pipelines.getPipeline(sql, a.organization.id, pipelineId))) throw notFound("Pipeline");
      return results.performanceTrend(sql, a.organization.id, pipelineId, Number(limit) || 50);
    });
  }
}
