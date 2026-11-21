import type { ResultCategory } from "@painel/contracts";
import type { PerformanceMetric, PerformanceRecord, PerformanceThreshold } from "@painel/processor-sdk";
import type { Sql } from "../../db/database.ts";

/** Resumo de desempenho de um relatório (incremento 6). Latência em ms; taxas de 0 a 1. */
export interface PerformanceResult {
  id: string;
  executionId: string;
  reportId: string;
  format: string;
  durationMs: number | null;
  vusMax: number | null;
  iterations: number | null;
  httpReqs: number | null;
  httpReqRate: number | null;
  httpReqFailedRate: number | null;
  latency: { avg: number | null; med: number | null; p90: number | null; p95: number | null; p99: number | null; max: number | null };
  checksRate: number | null;
  thresholdsTotal: number;
  thresholdsFailed: number;
  metrics: PerformanceMetric[];
  thresholds: PerformanceThreshold[];
  createdAt: Date;
}

/** Ponto da série histórica de desempenho de uma pipeline (dashboard por categoria, RF-193). */
export interface PerformancePoint {
  executionId: string;
  finishedAt: Date | null;
  runNumber: string | null;
  status: string;
  latencyP95: number | null;
  latencyP99: number | null;
  latencyAvg: number | null;
  httpReqRate: number | null;
  httpReqFailedRate: number | null;
  vusMax: number | null;
  thresholdsTotal: number;
  thresholdsFailed: number;
}

// Persistência do módulo results: artefatos guardados, relatórios processados e testes
// funcionais normalizados. Tudo é só de inclusão (o histórico de uma execução não muda).

/** "expired": o arquivo original foi apagado pela política de retenção; o registro fica. */
export type ArtifactStatus = "stored" | "skipped" | "failed" | "expired";
export type ReportOutcome = "processed" | "partial" | "unsupported" | "failed";
export type TestStatus = "passed" | "failed" | "skipped" | "flaky";

export interface StoredArtifact {
  id: string;
  executionId: string;
  externalRef: string;
  name: string;
  sizeBytes: number | null;
  storageKey: string | null;
  status: ArtifactStatus;
  reason: string | null;
  createdAt: Date;
}

export interface ProcessedReport {
  id: string;
  artifactId: string;
  filePath: string;
  processorId: string;
  category: ResultCategory;
  status: ReportOutcome;
  reason: string | null;
  tests: number;
  createdAt: Date;
}

export interface FunctionalTest {
  id: string;
  reportId: string;
  suite: string;
  name: string;
  file: string | null;
  project: string | null;
  status: TestStatus;
  durationMs: number | null;
  attempts: number;
  errorMessage: string | null;
  errorDetails: string | null;
  attachments: Array<{ name: string; contentType?: string; path?: string }> | null;
}

export interface NewFunctionalTest {
  suite: string;
  name: string;
  file?: string;
  project?: string;
  status: TestStatus;
  durationMs?: number;
  attempts: number;
  errorMessage?: string;
  errorDetails?: string;
  attachments?: Array<{ name: string; contentType?: string; path?: string }>;
}

/** Contagem dos testes funcionais de uma execução (a taxa de aprovação sai daqui — RN-045). */
export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
}

const ARTIFACT_COLUMNS = `id, execution_id, external_ref, name, size_bytes, storage_key, status, reason, created_at`;
const REPORT_COLUMNS = `id, artifact_id, file_path, processor_id, category, status, reason, tests, created_at`;
const TEST_COLUMNS = `id, report_id, suite, name, file, project, status, duration_ms, attempts, error_message, error_details, attachments`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toArtifact = (r: any): StoredArtifact => ({
  id: r.id,
  executionId: r.execution_id,
  externalRef: r.external_ref,
  name: r.name,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  storageKey: r.storage_key,
  status: r.status,
  reason: r.reason,
  createdAt: r.created_at,
});
const toReport = (r: any): ProcessedReport => ({
  id: r.id,
  artifactId: r.artifact_id,
  filePath: r.file_path,
  processorId: r.processor_id,
  category: r.category,
  status: r.status,
  reason: r.reason,
  tests: r.tests,
  createdAt: r.created_at,
});
const toTest = (r: any): FunctionalTest => ({
  id: String(r.id),
  reportId: r.report_id,
  suite: r.suite,
  name: r.name,
  file: r.file,
  project: r.project,
  status: r.status,
  durationMs: r.duration_ms,
  attempts: r.attempts,
  errorMessage: r.error_message,
  errorDetails: r.error_details,
  attachments: r.attachments,
});
const toSummary = (r: any): TestSummary => ({
  total: Number(r.total),
  passed: Number(r.passed),
  failed: Number(r.failed),
  skipped: Number(r.skipped),
  flaky: Number(r.flaky),
  durationMs: Number(r.duration_ms),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function findArtifact(sql: Sql, organizationId: string, executionId: string, externalRef: string): Promise<StoredArtifact | undefined> {
  const { rows } = await sql.query(`SELECT ${ARTIFACT_COLUMNS} FROM results_artifacts WHERE organization_id = $1 AND execution_id = $2 AND external_ref = $3`, [
    organizationId,
    executionId,
    externalRef,
  ]);
  return rows[0] ? toArtifact(rows[0]) : undefined;
}

export async function insertArtifact(
  sql: Sql,
  organizationId: string,
  a: { id: string; executionId: string; externalRef: string; name: string; sizeBytes: number | null; storageKey: string | null; status: ArtifactStatus; reason?: string },
): Promise<StoredArtifact> {
  const { rows } = await sql.query(
    `INSERT INTO results_artifacts (id, organization_id, execution_id, external_ref, name, size_bytes, storage_key, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (execution_id, external_ref) DO NOTHING
     RETURNING ${ARTIFACT_COLUMNS}`,
    [a.id, organizationId, a.executionId, a.externalRef, a.name.slice(0, 500), a.sizeBytes, a.storageKey, a.status, a.reason?.slice(0, 1000) ?? null],
  );
  // Outro processo guardou antes: vale o que já está lá.
  return rows[0] ? toArtifact(rows[0]) : (await findArtifact(sql, organizationId, a.executionId, a.externalRef))!;
}

/**
 * Grava o relatório e os testes dele. Se o mesmo arquivo já foi processado pela mesma versão
 * do processador, não grava de novo (reprocessar é idempotente) e devolve undefined.
 */
export async function insertReport(
  sql: Sql,
  organizationId: string,
  executionId: string,
  r: { artifactId: string; filePath: string; processorId: string; category: ResultCategory; status: ReportOutcome; reason?: string },
  tests: readonly NewFunctionalTest[],
  performance: readonly PerformanceRecord[] = [],
): Promise<ProcessedReport | undefined> {
  const { rows } = await sql.query(
    `INSERT INTO results_reports (organization_id, execution_id, artifact_id, file_path, processor_id, category, status, reason, tests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (artifact_id, file_path, processor_id) DO NOTHING
     RETURNING ${REPORT_COLUMNS}`,
    [organizationId, executionId, r.artifactId, r.filePath.slice(0, 1000), r.processorId, r.category, r.status, r.reason?.slice(0, 1000) ?? null, tests.length],
  );
  if (!rows[0]) return undefined;
  const report = toReport(rows[0]);
  for (const p of performance) await insertPerformance(sql, organizationId, executionId, report.id, p);
  // Em lotes, para não montar um comando gigante com milhares de testes.
  for (let i = 0; i < tests.length; i += 500) {
    const batch = tests.slice(i, i + 500);
    await sql.query(
      `INSERT INTO results_functional_tests
         (organization_id, execution_id, report_id, suite, name, file, project, status, duration_ms, attempts, error_message, error_details, attachments)
       SELECT $1, $2, $3, t.suite, t.name, t.file, t.project, t.status, t.duration_ms, t.attempts, t.error_message, t.error_details, t.attachments
       FROM jsonb_to_recordset($4::jsonb) AS t(suite text, name text, file text, project text, status text, duration_ms integer, attempts integer,
            error_message text, error_details text, attachments jsonb)`,
      [
        organizationId,
        executionId,
        report.id,
        JSON.stringify(
          batch.map((t) => ({
            suite: t.suite.slice(0, 1000),
            name: t.name.slice(0, 1000),
            file: t.file?.slice(0, 1000) ?? null,
            project: t.project?.slice(0, 200) ?? null,
            status: t.status,
            duration_ms: t.durationMs ?? null,
            attempts: t.attempts,
            error_message: t.errorMessage ?? null,
            error_details: t.errorDetails ?? null,
            attachments: t.attachments ?? null,
          })),
        ),
      ],
    );
  }
  return report;
}

const PERF_COLUMNS = `id, execution_id, report_id, format, duration_ms, vus_max, iterations, http_reqs, http_req_rate, http_req_failed_rate,
  latency_avg, latency_med, latency_p90, latency_p95, latency_p99, latency_max, checks_rate, thresholds_total, thresholds_failed, metrics, thresholds, created_at`;

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/* eslint-disable @typescript-eslint/no-explicit-any */
const toPerformance = (r: any): PerformanceResult => ({
  id: r.id,
  executionId: r.execution_id,
  reportId: r.report_id,
  format: r.format,
  durationMs: n(r.duration_ms),
  vusMax: n(r.vus_max),
  iterations: n(r.iterations),
  httpReqs: n(r.http_reqs),
  httpReqRate: n(r.http_req_rate),
  httpReqFailedRate: n(r.http_req_failed_rate),
  latency: { avg: n(r.latency_avg), med: n(r.latency_med), p90: n(r.latency_p90), p95: n(r.latency_p95), p99: n(r.latency_p99), max: n(r.latency_max) },
  checksRate: n(r.checks_rate),
  thresholdsTotal: r.thresholds_total,
  thresholdsFailed: r.thresholds_failed,
  metrics: r.metrics,
  thresholds: r.thresholds,
  createdAt: r.created_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Grava o resumo de desempenho de um relatório (uma vez por relatório). */
export async function insertPerformance(sql: Sql, organizationId: string, executionId: string, reportId: string, p: PerformanceRecord): Promise<void> {
  const thresholds = (p.thresholds ?? []).slice(0, 200).map((t) => ({ metric: String(t.metric).slice(0, 200), expression: String(t.expression).slice(0, 300), ok: t.ok === true }));
  const metrics = (p.metrics ?? []).slice(0, 500);
  await sql.query(
    `INSERT INTO results_performance (organization_id, execution_id, report_id, format, duration_ms, vus_max, iterations, http_reqs, http_req_rate,
       http_req_failed_rate, latency_avg, latency_med, latency_p90, latency_p95, latency_p99, latency_max, checks_rate, thresholds_total, thresholds_failed,
       metrics, thresholds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (report_id) DO NOTHING`,
    [
      organizationId,
      executionId,
      reportId,
      String(p.format ?? "desconhecido").slice(0, 40),
      finite(p.durationMs),
      finite(p.vusMax),
      finite(p.iterations),
      finite(p.httpReqs),
      finite(p.httpReqRate),
      finite(p.httpReqFailedRate),
      finite(p.latency?.avg),
      finite(p.latency?.med),
      finite(p.latency?.p90),
      finite(p.latency?.p95),
      finite(p.latency?.p99),
      finite(p.latency?.max),
      finite(p.checksRate),
      thresholds.length,
      thresholds.filter((t) => !t.ok).length,
      JSON.stringify(metrics),
      JSON.stringify(thresholds),
    ],
  );
}

export async function listPerformance(sql: Sql, organizationId: string, executionId: string): Promise<PerformanceResult[]> {
  const { rows } = await sql.query(`SELECT ${PERF_COLUMNS} FROM results_performance WHERE organization_id = $1 AND execution_id = $2 ORDER BY created_at`, [
    organizationId,
    executionId,
  ]);
  return rows.map(toPerformance);
}

/** Thresholds que falharam numa execução (para classificar a falha como "threshold", CA-045). */
export async function failedThresholds(sql: Sql, organizationId: string, executionId: string): Promise<number> {
  const { rows } = await sql.query(
    `SELECT coalesce(sum(thresholds_failed), 0) AS failed FROM results_performance WHERE organization_id = $1 AND execution_id = $2`,
    [organizationId, executionId],
  );
  return Number(rows[0]?.failed ?? 0);
}

/**
 * Série histórica de desempenho de uma pipeline, da mais antiga para a mais recente. Com mais de um
 * resumo na mesma execução, vale o pior (maior p95, soma dos thresholds) para não esconder regressão.
 */
export async function performanceTrend(sql: Sql, organizationId: string, pipelineId: string, limit = 50): Promise<PerformancePoint[]> {
  const { rows } = await sql.query(
    `SELECT e.id AS execution_id, e.finished_at, e.run_number, e.status,
            max(p.latency_p95) AS latency_p95, max(p.latency_p99) AS latency_p99, max(p.latency_avg) AS latency_avg,
            sum(p.http_req_rate) AS http_req_rate, max(p.http_req_failed_rate) AS http_req_failed_rate, max(p.vus_max) AS vus_max,
            sum(p.thresholds_total) AS thresholds_total, sum(p.thresholds_failed) AS thresholds_failed
     FROM results_performance p
     JOIN execution_executions e ON e.organization_id = p.organization_id AND e.id = p.execution_id
     WHERE p.organization_id = $1 AND e.pipeline_id = $2
     GROUP BY e.id, e.finished_at, e.run_number, e.status, e.requested_at
     ORDER BY e.requested_at DESC
     LIMIT $3`,
    [organizationId, pipelineId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows
    .map((r) => ({
      executionId: r.execution_id as string,
      finishedAt: (r.finished_at as Date | null) ?? null,
      runNumber: (r.run_number as string | null) ?? null,
      status: r.status as string,
      latencyP95: n(r.latency_p95),
      latencyP99: n(r.latency_p99),
      latencyAvg: n(r.latency_avg),
      httpReqRate: n(r.http_req_rate),
      httpReqFailedRate: n(r.http_req_failed_rate),
      vusMax: n(r.vus_max),
      thresholdsTotal: Number(r.thresholds_total ?? 0),
      thresholdsFailed: Number(r.thresholds_failed ?? 0),
    }))
    .reverse();
}

/** Resumo de desempenho por execução, para as listas: thresholds e p95. */
export async function performanceSummaries(
  sql: Sql,
  organizationId: string,
  executionIds: readonly string[],
): Promise<Map<string, { thresholdsTotal: number; thresholdsFailed: number; latencyP95: number | null }>> {
  if (!executionIds.length) return new Map();
  const { rows } = await sql.query(
    `SELECT execution_id, sum(thresholds_total) AS total, sum(thresholds_failed) AS failed, max(latency_p95) AS p95
     FROM results_performance WHERE organization_id = $1 AND execution_id = ANY($2::uuid[]) GROUP BY execution_id`,
    [organizationId, executionIds],
  );
  return new Map(rows.map((r) => [r.execution_id as string, { thresholdsTotal: Number(r.total), thresholdsFailed: Number(r.failed), latencyP95: n(r.p95) }]));
}

// ---------- Retenção (incremento 7, RF-146, 22.1) ----------

/** Artefatos guardados antes de `olderThan`, ainda com o arquivo original. */
export async function expirableArtifacts(sql: Sql, organizationId: string, olderThan: Date, limit = 500): Promise<Array<{ id: string; storageKey: string }>> {
  const { rows } = await sql.query(
    `SELECT id, storage_key FROM results_artifacts
     WHERE organization_id = $1 AND status = 'stored' AND storage_key IS NOT NULL AND created_at < $2
     ORDER BY created_at LIMIT $3`,
    [organizationId, olderThan, limit],
  );
  return rows.map((r) => ({ id: r.id as string, storageKey: r.storage_key as string }));
}

/** O registro do artefato fica (a execução continua dizendo que ele existiu); só o arquivo some. */
export async function markArtifactExpired(sql: Sql, organizationId: string, id: string, reason: string): Promise<void> {
  await sql.query(`UPDATE results_artifacts SET status = 'expired', storage_key = NULL, reason = $3 WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    id,
    reason.slice(0, 1000),
  ]);
}

/**
 * Apaga testes e métricas detalhados de execuções pedidas antes de `olderThan`. O resumo da
 * execução (estado, tipo de falha, situação do relatório) continua no histórico.
 */
export async function purgeResultDetails(sql: Sql, organizationId: string, olderThan: Date): Promise<{ tests: number; performance: number }> {
  const old = `SELECT id FROM execution_executions WHERE organization_id = $1 AND requested_at < $2`;
  const tests = await sql.query(`DELETE FROM results_functional_tests WHERE organization_id = $1 AND execution_id IN (${old})`, [organizationId, olderThan]);
  const perf = await sql.query(`DELETE FROM results_performance WHERE organization_id = $1 AND execution_id IN (${old})`, [organizationId, olderThan]);
  return { tests: tests.rowCount ?? 0, performance: perf.rowCount ?? 0 };
}

export async function listArtifacts(sql: Sql, organizationId: string, executionId: string): Promise<StoredArtifact[]> {
  const { rows } = await sql.query(`SELECT ${ARTIFACT_COLUMNS} FROM results_artifacts WHERE organization_id = $1 AND execution_id = $2 ORDER BY created_at, name`, [
    organizationId,
    executionId,
  ]);
  return rows.map(toArtifact);
}

export async function listReports(sql: Sql, organizationId: string, executionId: string): Promise<ProcessedReport[]> {
  const { rows } = await sql.query(`SELECT ${REPORT_COLUMNS} FROM results_reports WHERE organization_id = $1 AND execution_id = $2 ORDER BY created_at, file_path`, [
    organizationId,
    executionId,
  ]);
  return rows.map(toReport);
}

/** Testes de uma execução: falhas primeiro, depois instáveis, pulados e aprovados. */
export async function listTests(
  sql: Sql,
  organizationId: string,
  executionId: string,
  filter: { status?: TestStatus[]; search?: string; limit?: number } = {},
): Promise<FunctionalTest[]> {
  const { rows } = await sql.query(
    `SELECT ${TEST_COLUMNS} FROM results_functional_tests
     WHERE organization_id = $1 AND execution_id = $2
       AND ($3::text[] IS NULL OR status = ANY($3))
       AND ($4::text IS NULL OR name ILIKE $4 OR suite ILIKE $4 OR file ILIKE $4)
     ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'flaky' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END, file NULLS LAST, suite, name
     LIMIT $5`,
    [
      organizationId,
      executionId,
      filter.status?.length ? filter.status : null,
      filter.search ? `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
      Math.min(Math.max(filter.limit ?? 500, 1), 2000),
    ],
  );
  return rows.map(toTest);
}

/** Resumo dos testes de várias execuções de uma vez (para as listas). */
export async function summaries(sql: Sql, organizationId: string, executionIds: readonly string[]): Promise<Map<string, TestSummary>> {
  if (!executionIds.length) return new Map();
  const { rows } = await sql.query(
    `SELECT execution_id, count(*) AS total,
            count(*) FILTER (WHERE status = 'passed') AS passed,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'skipped') AS skipped,
            count(*) FILTER (WHERE status = 'flaky') AS flaky,
            coalesce(sum(duration_ms), 0) AS duration_ms
     FROM results_functional_tests
     WHERE organization_id = $1 AND execution_id = ANY($2::uuid[])
     GROUP BY execution_id`,
    [organizationId, executionIds],
  );
  return new Map(rows.map((r) => [r.execution_id as string, toSummary(r)]));
}
