import type { ModuleDescriptor } from "./shared/module.ts";
import { accessModule } from "./modules/access/index.ts";
import { adminModule } from "./modules/admin/index.ts";
import { assistModule } from "./modules/assist/index.ts";
import { auditModule } from "./modules/audit/index.ts";
import { executionModule } from "./modules/execution/index.ts";
import { identityModule } from "./modules/identity/index.ts";
import { insightsModule } from "./modules/insights/index.ts";
import { integrationsModule } from "./modules/integrations/index.ts";
import { notificationsModule } from "./modules/notifications/index.ts";
import { pipelinesModule } from "./modules/pipelines/index.ts";
import { resourcesModule } from "./modules/resources/index.ts";
import { resultsModule } from "./modules/results/index.ts";
import { schedulingModule } from "./modules/scheduling/index.ts";
import { sharingModule } from "./modules/sharing/index.ts";
import { tenancyModule } from "./modules/tenancy/index.ts";

export type { ModuleDescriptor } from "./shared/module.ts";
export type { TenantContext } from "./shared/tenant.ts";
export type { Job, JobHandler, JobQueue, EnqueueOptions, WorkOptions } from "./shared/job-queue.ts";
export { PgJobQueue, enqueueJob, type PgJobQueueOptions } from "./shared/pg-job-queue.ts";
export { EVENTS_CHANNEL, parseEvent, publishEvent, type PlatformEvent } from "./shared/events.ts";
export type { SecretStore, SealedSecret } from "./shared/secret-store.ts";
export * from "./modules/access/index.ts";
export * from "./modules/identity/index.ts";
export * from "./modules/tenancy/index.ts";
export * from "./modules/audit/index.ts";
export { Database, isUniqueViolation, type DbScope, type DatabaseOptions, type Sql } from "./db/database.ts";
export { DomainError, type DomainErrorCode } from "./shared/errors.ts";
export * from "./foundation/service.ts";
export * from "./onboarding/service.ts";
export { lineDiff, yamlProblems, type DefinitionDiff, type DiffLine } from "./pipelines/diff.ts";
export { PIPELINE_TEMPLATES, defaultPipelinePath, renderTemplate, slugify, type PipelineTemplate, type TemplateField } from "./pipelines/templates.ts";
export * from "./modules/integrations/index.ts";
export * from "./modules/pipelines/index.ts";
export * from "./modules/resources/index.ts";
export * from "./modules/execution/index.ts";
export * from "./execution/service.ts";
export { ExecutionEngine, type ExecutionEngineOptions } from "./execution/engine.ts";
export { ProviderAccess } from "./execution/provider.ts";
export * from "./modules/notifications/index.ts";
export { evaluateRules, NotificationService, parseRuleFields, type AlertView, type EvaluateOptions } from "./notifications/service.ts";
export { EmailSender, EmailService, queueEmail, simpleHtml, EMAIL_ATTEMPTS, type Mailer, type MailMessage } from "./notifications/email.ts";
export * from "./modules/sharing/index.ts";
export * from "./modules/admin/index.ts";
export { SharingService, type CreatedShare, type ShareInput, type ShareLinkView } from "./sharing/service.ts";
export { RetentionRunner, type RetentionSummary } from "./admin/retention.ts";
export * from "./modules/assist/index.ts";
export { AssistService, REPORT_TYPES, type AssistDeps, type McpFactory, type ProviderFactory, type SessionView } from "./assist/service.ts";
export { JOBS } from "./execution/jobs.ts";
export * from "./modules/results/index.ts";
export { ResultsIngestor, ResultsService, DEFAULT_INGEST_OPTIONS, type ExecutionResults, type IngestOptions, type IngestSummary } from "./results/service.ts";
export { FileArtifactStore, MemoryArtifactStore, type ArtifactStore } from "./shared/artifact-store.ts";
export { readZip, isZip, ZipError, DEFAULT_ZIP_LIMITS, type ZipEntry, type ZipLimits } from "./shared/unzip.ts";
export { decide, exclusiveRefs, fromProvider, manifestForBranch, mergeParameters, type Decision, type Outcome, type ResourceState } from "./execution/rules.ts";
export { runMigrations, MIGRATIONS_DIR } from "./db/migrate.ts";

/** Todos os módulos do monólito modular (ADR-001), na ordem do documento de arquitetura (§5). */
export const MODULES: ModuleDescriptor[] = [
  identityModule,
  tenancyModule,
  accessModule,
  integrationsModule,
  pipelinesModule,
  resourcesModule,
  executionModule,
  schedulingModule,
  resultsModule,
  insightsModule,
  sharingModule,
  notificationsModule,
  auditModule,
  assistModule,
  adminModule,
];
