import { results, type TestSummary } from "../modules/results/index.ts";
import { randomUUID } from "node:crypto";
import {
  extractSystemVersion,
  validateParameterValues,
  type ParameterSpec,
  type ParameterValue,
  type ParameterViolation,
  type PipelineManifest,
  type SystemVersion,
} from "@painel/contracts";
import { NotSupportedError, ProviderError, type ExternalRef, type LogChunk } from "@painel/connector-sdk";
import { isUniqueViolation, type Database, type Sql } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import { enqueueJob } from "../shared/pg-job-queue.ts";
import { publishEvent } from "../shared/events.ts";
import { recordAudit, type AuditEventInput } from "../modules/audit/index.ts";
import { executions, isFinal, queuePositions, type Execution, type Transition, type TriggerType } from "../modules/execution/index.ts";
import { pipelines, profiles, type ExecutionProfile, type LinkedPipeline } from "../modules/pipelines/index.ts";
import { resources, type BusyPolicy, type Lease, type Resource } from "../modules/resources/index.ts";
import { tenancy } from "../modules/tenancy/index.ts";
import type { Actor, FoundationService, OrgActor, RequestMeta } from "../foundation/service.ts";
import { providerFailure } from "../onboarding/service.ts";
import { ProviderAccess } from "./provider.ts";
import { decide, exclusiveRefs, manifestForBranch, mergeParameters, type Decision, type ResourceState } from "./rules.ts";
import { JOBS } from "./jobs.ts";

// Casos de uso do incremento 3 do lado da api: recursos, perfis, pedido de execução (com prévia
// para a confirmação), fila, cancelamento, reexecução, consulta e logs. O disparo e o
// acompanhamento rodam no worker (engine.ts). CA-005–009, CA-021, CA-022, CA-042.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;

export interface ExecutionServiceOptions {
  /** Pedido igual do mesmo usuário dentro desta janela é tratado como repetição acidental (RF-057). */
  duplicateWindowSeconds?: number;
}

export interface ResourceView extends Resource {
  /** Quem segura o recurso agora (RF-079). Vencido = sem renovação; o reconciliador decide. */
  lease: { executionId: string; holderKind: Lease["holderKind"]; since: Date; expiresAt: Date; expired: boolean } | null;
  /** Pedidos esperando este recurso. */
  queued: number;
}

export interface ExecutionView extends Execution {
  /** Posição na fila (1 = próxima), só para execuções enfileiradas (RF-051). */
  queuePosition: number | null;
  /** Contagem dos testes lidos dos relatórios; null enquanto não há relatório (RN-012). */
  tests: TestSummary | null;
  /** Desempenho (k6), separado dos testes (RN-045); null quando a execução não tem resumo de desempenho. */
  performance?: { thresholdsTotal: number; thresholdsFailed: number; latencyP95: number | null } | null;
}

export interface ExecutionDetail {
  execution: ExecutionView;
  pipeline: { id: string; name: string; externalUrl: string | null; capabilities: LinkedPipeline["capabilities"] };
  transitions: Transition[];
  leases: Array<{ resourceId: string; resourceName: string; holderKind: Lease["holderKind"]; expiresAt: Date }>;
  /** Execuções que reexecutaram esta (RN-009). */
  reruns: string[];
}

export interface ExecutionRequest {
  pipelineId: unknown;
  profileId?: unknown;
  ref?: unknown;
  parameters?: unknown;
  idempotencyKey?: unknown;
  /** Confirma que o pedido igual e recente não é acidental (RF-057). */
  allowDuplicate?: unknown;
}

/** Prévia do pedido, para a tela de confirmação (RF-044). Nada é gravado. */
export interface ExecutionPreview {
  pipeline: { id: string; name: string };
  manifestVersion: number;
  ref: string | null;
  parameters: Record<string, ParameterValue>;
  violations: ParameterViolation[];
  resources: ResourceState[];
  missingResources: string[];
  decision: Decision;
  /** Versão do sistema em teste que já dá para saber pelos parâmetros (o resto vem do provedor). */
  systemVersion: SystemVersion | null;
  /** Parâmetros que valem para a ref escolhida, na ordem do YAML (o formulário é montado com eles). */
  parameterSpecs: ParameterSpec[];
  /** De onde vieram: o manifesto, ou o YAML da branch escolhida (que pode declarar outros parâmetros). */
  parametersFrom: "manifest" | "branch";
  /**
   * Validação feita pelo próprio provedor, sem executar. null = o conector não oferece; ok null =
   * o provedor não respondeu (o pedido continua possível, a validação local vale).
   */
  providerCheck: { ok: boolean; problems: string[] } | { ok: null; message: string } | null;
}

export interface RequestResult {
  execution: ExecutionView;
  /** true = o mesmo pedido (mesma chave de idempotência) já existia e foi devolvido. */
  replayed: boolean;
}

interface Plan extends Omit<ExecutionPreview, "providerCheck"> {
  projectId: string;
  externalId: string;
  integrationId: string;
  profile?: ExecutionProfile;
  resourceRows: Resource[];
}

function text(value: unknown, what: string, max = 120): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new DomainError("invalid", `Informe ${what}.`);
  if (v.length > max) throw new DomainError("invalid", `${what[0]!.toUpperCase()}${what.slice(1)} pode ter no máximo ${max} caracteres.`);
  return v;
}

function optionalText(value: unknown, what: string, max = 200): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, what, max);
}

function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound(what);
  return value;
}

function parameterValues(value: unknown): Record<string, ParameterValue> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new DomainError("invalid", "Os parâmetros precisam ser um objeto nome → valor.");
  const out: Record<string, ParameterValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new DomainError("invalid", `O parâmetro "${k.slice(0, 64)}" precisa ser texto, número ou verdadeiro/falso.`);
    }
    if (typeof v === "string" && v.length > 2000) throw new DomainError("invalid", `O valor do parâmetro "${k.slice(0, 64)}" é longo demais.`);
    out[k] = v;
  }
  if (Object.keys(out).length > 200) throw new DomainError("invalid", "Parâmetros demais.");
  return out;
}

export class ExecutionService {
  readonly #db: Database;
  readonly #foundation: FoundationService;
  readonly #provider: ProviderAccess;
  readonly #duplicateWindow: number;

  constructor(db: Database, foundation: FoundationService, provider: ProviderAccess, options: ExecutionServiceOptions = {}) {
    this.#db = db;
    this.#foundation = foundation;
    this.#provider = provider;
    this.#duplicateWindow = options.duplicateWindowSeconds ?? 60;
  }

  // =====================================================================
  // Recursos executores (RF-049, RF-078, RF-079)
  // =====================================================================

  async listResources(actor: Actor, includeArchived = false): Promise<ResourceView[]> {
    const a = await this.#foundation.authorize(actor, "view");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const list = await resources.listResources(sql, a.organization.id, includeArchived);
      const leases = await resources.openLeases(sql, a.organization.id);
      const queue = await executions.queued(sql, a.organization.id);
      const now = Date.now();
      return list.map((r) => {
        const lease = leases.find((l) => l.resourceId === r.id);
        return {
          ...r,
          lease: lease
            ? {
                executionId: lease.executionId,
                holderKind: lease.holderKind,
                since: lease.acquiredAt,
                expiresAt: lease.expiresAt,
                expired: lease.expiresAt.getTime() < now,
              }
            : null,
          queued: queue.filter((e) => e.resourceIds.includes(r.id)).length,
        };
      });
    });
  }

  async createResource(
    actor: Actor,
    input: { ref: unknown; name: unknown; description?: unknown; busyPolicy?: unknown; leaseTtlSeconds?: unknown },
    meta: RequestMeta,
  ): Promise<Resource> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "resource.create");
    this.#requireWritable(a);
    const ref = text(input.ref, "o identificador do recurso", 100);
    if (!REF.test(ref)) throw new DomainError("invalid", "O identificador do recurso usa só letras, números, ponto, hífen e sublinhado.");
    const name = text(input.name, "o nome do recurso");
    const description = optionalText(input.description, "a descrição", 500);
    const busyPolicy = this.#busyPolicy(input.busyPolicy) ?? "queue";
    const leaseTtlSeconds = this.#ttl(input.leaseTtlSeconds) ?? 900;
    return this.#db.tx(this.#scope(a), async (sql) => {
      const created = await this.#unique(
        () =>
          resources.insertResource(sql, {
            organizationId: a.organization.id,
            ref,
            name,
            ...(description ? { description } : {}),
            busyPolicy,
            leaseTtlSeconds,
            createdBy: a.user.id,
          }),
        "Já existe um recurso com esse identificador.",
      );
      await this.#audit(sql, a, meta, "resource.create", "resource", created.id, "success", { ref, busyPolicy, leaseTtlSeconds });
      return created;
    });
  }

  async updateResource(
    actor: Actor,
    id: string,
    input: { name?: unknown; description?: unknown; busyPolicy?: unknown; leaseTtlSeconds?: unknown },
    meta: RequestMeta,
  ): Promise<Resource> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "resource.update");
    this.#requireWritable(a);
    const resourceId = uuid(id, "Recurso");
    const patch: Parameters<typeof resources.updateResource>[3] = {};
    if (input.name !== undefined) patch.name = text(input.name, "o nome do recurso");
    if (input.description !== undefined) patch.description = optionalText(input.description, "a descrição", 500) ?? null;
    const policy = this.#busyPolicy(input.busyPolicy);
    if (policy) patch.busyPolicy = policy;
    const ttl = this.#ttl(input.leaseTtlSeconds);
    if (ttl) patch.leaseTtlSeconds = ttl;
    return this.#db.tx(this.#scope(a), async (sql) => {
      const updated = await resources.updateResource(sql, a.organization.id, resourceId, patch);
      if (!updated) throw notFound("Recurso");
      await this.#audit(sql, a, meta, "resource.update", "resource", resourceId, "success", { ...patch });
      return updated;
    });
  }

  /** Só arquiva recurso livre: arquivar um recurso ocupado esconderia quem o está usando. */
  async setResourceArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<Resource> {
    const action = archived ? "resource.archive" : "resource.unarchive";
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, action);
    const resourceId = uuid(id, "Recurso");
    return this.#db.tx(this.#scope(a), async (sql) => {
      if (archived && (await resources.openLeases(sql, a.organization.id, [resourceId])).length) {
        throw new DomainError("conflict", "O recurso está em uso. Espere a execução terminar.");
      }
      const updated = await this.#unique(
        () => resources.setResourceArchived(sql, a.organization.id, resourceId, archived),
        "Já existe um recurso ativo com esse identificador.",
      );
      if (!updated) throw notFound("Recurso");
      await this.#audit(sql, a, meta, action, "resource", resourceId, "success");
      return updated;
    });
  }

  // =====================================================================
  // Perfis de execução (RF-042)
  // =====================================================================

  async listProfiles(actor: Actor, pipelineId: string, includeArchived = false): Promise<ExecutionProfile[]> {
    const a = await this.#foundation.authorize(actor, "view");
    const id = uuid(pipelineId, "Pipeline");
    return this.#db.tx(this.#scope(a), async (sql) => {
      if (!(await pipelines.getPipeline(sql, a.organization.id, id))) throw notFound("Pipeline");
      return profiles.listProfiles(sql, a.organization.id, id, includeArchived);
    });
  }

  async createProfile(
    actor: Actor,
    pipelineId: string,
    input: { name: unknown; description?: unknown; ref?: unknown; parameters?: unknown },
    meta: RequestMeta,
  ): Promise<ExecutionProfile> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "profile.create");
    this.#requireWritable(a);
    const id = uuid(pipelineId, "Pipeline");
    const fields = this.#profileFields(input);
    return this.#db.tx(this.#scope(a), async (sql) => {
      const manifest = await this.#activeManifest(sql, a, id);
      this.#requireValid(manifest, fields.parameters);
      const created = await this.#unique(
        () =>
          profiles.insertProfile(sql, {
            organizationId: a.organization.id,
            pipelineId: id,
            name: fields.name,
            ...(fields.description ? { description: fields.description } : {}),
            ...(fields.ref ? { ref: fields.ref } : {}),
            parameters: fields.parameters,
            createdBy: a.user.id,
          }),
        "Já existe um perfil com esse nome nesta pipeline.",
      );
      await this.#audit(sql, a, meta, "profile.create", "profile", created.id, "success", { pipelineId: id, name: fields.name });
      return created;
    });
  }

  async updateProfile(
    actor: Actor,
    profileId: string,
    input: { name: unknown; description?: unknown; ref?: unknown; parameters?: unknown },
    meta: RequestMeta,
  ): Promise<ExecutionProfile> {
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, "profile.update");
    this.#requireWritable(a);
    const id = uuid(profileId, "Perfil");
    const fields = this.#profileFields(input);
    return this.#db.tx(this.#scope(a), async (sql) => {
      const current = await profiles.getProfile(sql, a.organization.id, id);
      if (!current) throw notFound("Perfil");
      if (current.archivedAt) throw new DomainError("conflict", "O perfil está arquivado.");
      const manifest = await this.#activeManifest(sql, a, current.pipelineId);
      this.#requireValid(manifest, fields.parameters);
      const updated = await this.#unique(
        () =>
          profiles.updateProfile(sql, a.organization.id, id, {
            name: fields.name,
            description: fields.description ?? null,
            ref: fields.ref ?? null,
            parameters: fields.parameters,
          }),
        "Já existe um perfil com esse nome nesta pipeline.",
      );
      await this.#audit(sql, a, meta, "profile.update", "profile", id, "success", { name: fields.name });
      return updated!;
    });
  }

  async setProfileArchived(actor: Actor, profileId: string, archived: boolean, meta: RequestMeta): Promise<ExecutionProfile> {
    const action = archived ? "profile.archive" : "profile.unarchive";
    const a = await this.#foundation.authorize(actor, "configurePipelines", meta, action);
    const id = uuid(profileId, "Perfil");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const updated = await this.#unique(
        () => profiles.setProfileArchived(sql, a.organization.id, id, archived),
        "Já existe um perfil ativo com esse nome nesta pipeline.",
      );
      if (!updated) throw notFound("Perfil");
      await this.#audit(sql, a, meta, action, "profile", id, "success");
      return updated;
    });
  }

  // =====================================================================
  // Pedido de execução (FLX-002, FLX-005)
  // =====================================================================

  /** O que aconteceria com o pedido agora, sem gravar nada: base da confirmação (RF-044). */
  async previewExecution(actor: Actor, input: ExecutionRequest, meta: RequestMeta = { correlationId: "preview" }): Promise<ExecutionPreview> {
    const a = await this.#foundation.authorize(actor, "execute");
    const branch = await this.#branchSpecs(a, input, meta.correlationId);
    const plan = await this.#db.tx(this.#scope(a), (sql) => this.#plan(sql, a, input, false, branch));
    return {
      pipeline: plan.pipeline,
      manifestVersion: plan.manifestVersion,
      ref: plan.ref,
      parameters: plan.parameters,
      violations: plan.violations,
      resources: plan.resources,
      missingResources: plan.missingResources,
      decision: plan.decision,
      systemVersion: plan.systemVersion,
      parameterSpecs: plan.parameterSpecs,
      parametersFrom: plan.parametersFrom,
      providerCheck: plan.decision.outcome === "blocked" ? null : await this.#providerCheck(a, plan, meta.correlationId),
    };
  }

  /** Branches e tags do repositório da pipeline, para escolher a versão a executar. */
  async listRefs(actor: Actor, pipelineId: string, query: { search?: string }, meta: RequestMeta): Promise<ExternalRef[]> {
    const a = await this.#foundation.authorize(actor, "view");
    const id = uuid(pipelineId, "Pipeline");
    const pipeline = await this.#db.tx(this.#scope(a), (sql) => pipelines.getPipeline(sql, a.organization.id, id));
    if (!pipeline) throw notFound("Pipeline");
    const { connector, conn } = await this.#provider.open(a.organization.id, pipeline.integrationId, meta.correlationId, a.user.id);
    if (!connector.listRefs) throw new DomainError("conflict", "O conector desta pipeline não lista branches e tags.");
    try {
      return await connector.listRefs(conn, pipeline.externalId, { ...(query.search ? { search: query.search.slice(0, 100) } : {}), limit: 50 });
    } catch (error) {
      if (error instanceof NotSupportedError) throw new DomainError("conflict", error.message);
      providerFailure(error, false);
    }
  }

  /**
   * Parâmetros da ref pedida, quando ela é outra que não a de onde o manifesto foi lido: o YAML
   * muda por branch. undefined = vale o manifesto.
   */
  async #branchSpecs(a: OrgActor, input: ExecutionRequest, correlationId: string): Promise<{ ref: string; specs: ParameterSpec[] } | undefined> {
    const ctx = await this.#db.tx(this.#scope(a), async (sql) => {
      const pipeline = await pipelines.getPipeline(sql, a.organization.id, uuid(input.pipelineId, "Pipeline"));
      if (!pipeline) throw notFound("Pipeline");
      let profileRef: string | null = null;
      if (typeof input.profileId === "string" && input.profileId) {
        profileRef = (await profiles.getProfile(sql, a.organization.id, uuid(input.profileId, "Perfil")))?.ref ?? null;
      }
      return { pipeline, profileRef };
    });
    const { pipeline } = ctx;
    const ref = optionalText(input.ref, "a branch") ?? ctx.profileRef ?? null;
    const base = pipeline.parametersRef ?? pipeline.defaultRef;
    if (!ref || !pipeline.capabilities.read.parameters || sameRef(ref, base)) return undefined;
    const { connector, conn } = await this.#provider.open(a.organization.id, pipeline.integrationId, correlationId, a.user.id);
    try {
      return { ref, specs: await connector.getParameters(conn, pipeline.externalId, ref) };
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "not-found") {
        throw new DomainError("invalid", `A branch "${ref}" não existe no provedor, ou não tem o arquivo desta pipeline.`);
      }
      if (error instanceof NotSupportedError) return undefined;
      providerFailure(error, false);
    }
  }

  /** Pergunta ao provedor se ele aceitaria o pedido. Falha de rede não bloqueia: vira aviso. */
  async #providerCheck(a: OrgActor, plan: Plan, correlationId: string): Promise<ExecutionPreview["providerCheck"]> {
    try {
      const { connector, conn } = await this.#provider.open(a.organization.id, plan.integrationId, correlationId, a.user.id);
      if (!connector.validateRun) return null;
      return await connector.validateRun(conn, {
        externalPipelineId: plan.externalId,
        ...(plan.ref ? { ref: plan.ref } : {}),
        parameters: plan.parameters,
      });
    } catch (error) {
      const message = error instanceof ProviderError || error instanceof DomainError ? error.message : "o provedor não respondeu";
      return { ok: null, message: message.slice(0, 300) };
    }
  }

  /**
   * Registra o pedido (CA-005). Parâmetro inválido ou recurso não cadastrado bloqueia, com as
   * inconsistências (CA-006). Recurso ocupado: espera na fila ou é recusado, conforme o recurso
   * (CA-007). O disparo no provedor é feito pelo worker.
   */
  async requestExecution(actor: Actor, input: ExecutionRequest, meta: RequestMeta): Promise<RequestResult> {
    const a = await this.#foundation.authorize(actor, "execute", meta, "execution.request");
    this.#requireWritable(a);
    const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null ? undefined : String(input.idempotencyKey);
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new DomainError("invalid", "Chave de idempotência inválida (8 a 100 caracteres: letras, números, . _ : -).");
    }
    return this.#create(a, input, meta, { triggerType: "manual", ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  /** Nova execução com os mesmos parâmetros, ligada à original (RF-047, RN-009, CA-021). */
  async rerunExecution(actor: Actor, id: string, input: { idempotencyKey?: unknown }, meta: RequestMeta): Promise<RequestResult> {
    const a = await this.#foundation.authorize(actor, "execute", meta, "execution.rerun");
    this.#requireWritable(a);
    const originalId = uuid(id, "Execução");
    const original = await this.#db.tx(this.#scope(a), (sql) => executions.getExecution(sql, a.organization.id, originalId));
    if (!original) throw notFound("Execução");
    const key = input.idempotencyKey === undefined || input.idempotencyKey === null ? undefined : String(input.idempotencyKey);
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) throw new DomainError("invalid", "Chave de idempotência inválida.");
    return this.#create(
      a,
      { pipelineId: original.pipelineId, ref: original.ref ?? undefined, parameters: original.parameters, allowDuplicate: true },
      meta,
      { triggerType: "rerun", rerunOf: original.id, ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  async #create(
    a: OrgActor,
    input: ExecutionRequest,
    meta: RequestMeta,
    options: { triggerType: TriggerType; rerunOf?: string; idempotencyKey?: string },
  ): Promise<RequestResult> {
    const action = options.triggerType === "rerun" ? "execution.rerun" : "execution.request";
    try {
      const branch = await this.#branchSpecs(a, input, meta.correlationId);
      return await this.#db.tx(this.#scope(a), async (sql) => {
        if (options.idempotencyKey) {
          const existing = await executions.findByIdempotencyKey(sql, a.organization.id, a.user.id, options.idempotencyKey);
          if (existing) return { execution: await this.#view(sql, existing), replayed: true };
        }
        const plan = await this.#plan(sql, a, input, true, branch);
        if (plan.decision.outcome === "blocked") {
          throw new DomainError("invalid", plan.decision.reasons.join(" "), {
            violations: plan.violations,
            missingResources: plan.missingResources,
          });
        }
        if (input.allowDuplicate !== true) {
          const duplicate = await executions.findRecentDuplicate(sql, {
            organizationId: a.organization.id,
            userId: a.user.id,
            pipelineId: plan.pipeline.id,
            ref: plan.ref,
            parameters: plan.parameters,
            withinSeconds: this.#duplicateWindow,
          });
          if (duplicate) {
            throw new DomainError("conflict", "Você acabou de pedir esta mesma execução. Confirme se quer outra igual.", {
              duplicateOf: duplicate.id,
            });
          }
        }

        const id = randomUUID();
        const rejected = plan.decision.outcome === "reject";
        const execution = await executions.insertExecution(sql, {
          id,
          organizationId: a.organization.id,
          projectId: plan.projectId,
          pipelineId: plan.pipeline.id,
          ...(plan.profile ? { profileId: plan.profile.id } : {}),
          manifestVersion: plan.manifestVersion,
          triggerType: options.triggerType,
          requestedBy: a.user.id,
          ...(options.rerunOf ? { rerunOf: options.rerunOf } : {}),
          status: rejected ? "rejected" : "queued",
          ...(rejected ? { statusReason: plan.decision.reasons.join(" ") } : {}),
          ...(plan.ref ? { ref: plan.ref } : {}),
          parameters: plan.parameters,
          resourceRefs: plan.resourceRows.map((r) => r.ref),
          resourceIds: plan.resourceRows.map((r) => r.id),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          ...(plan.systemVersion ? { systemVersion: plan.systemVersion } : {}),
          correlationId: meta.correlationId,
        });
        if (!rejected) {
          await enqueueJob(sql, JOBS.dispatch, { executionId: id }, { organizationId: a.organization.id, idempotencyKey: `dispatch:${id}` });
        }
        await this.#audit(sql, a, meta, action, "execution", id, rejected ? "denied" : "success", {
          pipelineId: plan.pipeline.id,
          outcome: plan.decision.outcome,
          ...(options.rerunOf ? { rerunOf: options.rerunOf } : {}),
          ...(rejected ? { reason: plan.decision.reasons.join(" ") } : {}),
        });
        await publishEvent(sql, {
          type: "execution.changed",
          organizationId: a.organization.id,
          executionId: id,
          pipelineId: plan.pipeline.id,
          status: execution.status,
        });
        return { execution: await this.#view(sql, execution), replayed: false };
      });
    } catch (error) {
      // Corrida entre dois envios com a mesma chave: o segundo devolve o primeiro.
      if (isUniqueViolation(error) && options.idempotencyKey) {
        const existing = await this.#db.tx(this.#scope(a), (sql) =>
          executions.findByIdempotencyKey(sql, a.organization.id, a.user.id, options.idempotencyKey!),
        );
        if (existing) return { execution: await this.#db.tx(this.#scope(a), (sql) => this.#view(sql, existing)), replayed: true };
      }
      if (error instanceof DomainError && error.code !== "not-found") {
        await this.#db.tx(this.#scope(a), (sql) =>
          this.#audit(sql, a, meta, action, "pipeline", typeof input.pipelineId === "string" ? input.pipelineId.slice(0, 64) : null, "failed", {
            reason: error.message.slice(0, 300),
          }),
        );
      }
      throw error;
    }
  }

  /**
   * Monta o pedido: pipeline, perfil, ref, parâmetros validados contra o manifesto atual e o estado
   * dos recursos exigidos. Com `lock`, trava os recursos para a decisão valer até o fim da transação.
   */
  async #plan(
    sql: Sql,
    a: OrgActor,
    input: ExecutionRequest,
    lock: boolean,
    branch?: { ref: string; specs: ParameterSpec[] },
  ): Promise<Plan> {
    const pipelineId = uuid(input.pipelineId, "Pipeline");
    const pipeline = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
    if (!pipeline) throw notFound("Pipeline");
    if (pipeline.archivedAt) throw new DomainError("conflict", "A pipeline está arquivada.");
    if (!pipeline.capabilities.write.triggerRun) {
      throw new DomainError("conflict", "O provedor desta pipeline não permite disparar execuções pela plataforma.");
    }
    const project = await tenancy.getProject(sql, a.organization.id, pipeline.projectId);
    if (!project || project.archivedAt) throw new DomainError("conflict", "O projeto desta pipeline está arquivado.");

    let profile: ExecutionProfile | undefined;
    if (input.profileId !== undefined && input.profileId !== null && input.profileId !== "") {
      profile = await profiles.getProfile(sql, a.organization.id, uuid(input.profileId, "Perfil"));
      if (!profile || profile.pipelineId !== pipeline.id) throw notFound("Perfil");
      if (profile.archivedAt) throw new DomainError("conflict", "O perfil está arquivado.");
    }

    const version = await pipelines.getVersion(sql, a.organization.id, pipeline.id, pipeline.currentVersion);
    const ref = optionalText(input.ref, "a branch") ?? profile?.ref ?? pipeline.parametersRef ?? pipeline.defaultRef ?? null;
    // Noutra branch, valem os parâmetros que o YAML dela declara (com a curadoria do manifesto).
    const useBranch = branch && ref && sameRef(branch.ref, ref);
    const manifest = useBranch ? manifestForBranch(version!.manifest, branch.specs) : version!.manifest;
    const { effective, violations } = validateParameterValues(manifest, mergeParameters(profile?.parameters, parameterValues(input.parameters)));

    const refs = exclusiveRefs(manifest);
    const found = await resources.findByRefs(sql, a.organization.id, refs);
    const missingResources = refs.filter((r) => !found.some((f) => f.ref.toLowerCase() === r.toLowerCase()));
    const resourceRows = lock ? await resources.lockResources(sql, a.organization.id, found.map((r) => r.id)) : found;
    const leases = await resources.openLeases(sql, a.organization.id, resourceRows.map((r) => r.id));
    const queue = await executions.queued(sql, a.organization.id);
    const ids = resourceRows.map((r) => r.id);
    const queuedAhead = ids.length ? queue.filter((e) => e.resourceIds.some((r) => ids.includes(r))).length : 0;

    const states: ResourceState[] = resourceRows.map((r) => {
      const lease = leases.find((l) => l.resourceId === r.id);
      return {
        id: r.id,
        ref: r.ref,
        name: r.name,
        busyPolicy: r.busyPolicy,
        busy: Boolean(lease),
        ...(lease ? { heldBy: { executionId: lease.executionId, holderKind: lease.holderKind } } : {}),
      };
    });

    return {
      pipeline: { id: pipeline.id, name: pipeline.name },
      projectId: pipeline.projectId,
      externalId: pipeline.externalId,
      integrationId: pipeline.integrationId,
      parameterSpecs: manifest.parameters,
      parametersFrom: useBranch ? "branch" : "manifest",
      ...(profile ? { profile } : {}),
      manifestVersion: pipeline.currentVersion,
      ref,
      parameters: effective,
      violations,
      resources: states,
      missingResources,
      resourceRows,
      decision: decide({ violations: violations.length, missingResources, resources: states, queuedAhead }),
      systemVersion: extractSystemVersion(manifest.systemUnderTest, { parameters: effective }) ?? null,
    };
  }

  // =====================================================================
  // Cancelamento (RF-046, CA-008, CA-042)
  // =====================================================================

  /**
   * Na fila: cancela na hora, sem falar com o provedor. Em andamento: pede ao provedor (se ele
   * permitir) e o estado final vem da reconciliação. A execução continua no histórico (RN-008).
   */
  async cancelExecution(actor: Actor, id: string, meta: RequestMeta): Promise<ExecutionView> {
    const a = await this.#foundation.authorize(actor, "cancel", meta, "execution.cancel");
    const executionId = uuid(id, "Execução");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const e = await executions.getExecutionForUpdate(sql, a.organization.id, executionId);
      if (!e) throw notFound("Execução");
      if (isFinal(e.status)) throw new DomainError("conflict", "A execução já terminou.");
      if (e.status === "cancelling") return this.#view(sql, e);

      let next: Execution;
      if (e.status === "queued") {
        next = await executions.transition(
          sql,
          e,
          "cancelled",
          { statusReason: "Cancelada na fila, antes de ir ao provedor.", cancelRequestedBy: a.user.id, finishedAt: new Date() },
          a.user.id,
        );
        await this.#wakeQueue(sql, a.organization.id);
        await enqueueJob(sql, JOBS.notify, { executionId }, { organizationId: a.organization.id, idempotencyKey: `notify:${executionId}` });
      } else {
        const pipeline = await pipelines.getPipeline(sql, a.organization.id, e.pipelineId);
        if (!pipeline?.capabilities.write.cancelRun) {
          throw new DomainError("conflict", "O provedor desta pipeline não permite cancelar pela plataforma. Cancele direto no provedor.");
        }
        next = await executions.transition(
          sql,
          e,
          "cancelling",
          { statusReason: "Cancelamento pedido ao provedor.", cancelRequestedBy: a.user.id },
          a.user.id,
        );
        await enqueueJob(sql, JOBS.cancel, { executionId }, { organizationId: a.organization.id, idempotencyKey: `cancel:${executionId}` });
      }
      await this.#audit(sql, a, meta, "execution.cancel", "execution", executionId, "success", {
        from: e.status,
        triggerType: e.triggerType,
      });
      await publishEvent(sql, { type: "execution.changed", organizationId: a.organization.id, executionId, pipelineId: e.pipelineId, status: next.status });
      return this.#view(sql, next);
    });
  }

  // =====================================================================
  // Consulta (RF-045, RF-056, RF-059, RF-076, RF-077)
  // =====================================================================

  async listExecutions(
    actor: Actor,
    filter: { pipelineId?: string; projectId?: string; status?: string[]; before?: string; limit?: number },
  ): Promise<ExecutionView[]> {
    const a = await this.#foundation.authorize(actor, "view");
    const f: executions.ExecutionFilter = {};
    if (filter.pipelineId) f.pipelineId = uuid(filter.pipelineId, "Pipeline");
    if (filter.projectId) f.projectId = uuid(filter.projectId, "Projeto");
    if (filter.status?.length) f.status = filter.status as Execution["status"][];
    if (filter.before) {
      const d = new Date(filter.before);
      if (Number.isNaN(d.getTime())) throw new DomainError("invalid", "Data inválida em before.");
      f.before = d;
    }
    if (filter.limit) f.limit = filter.limit;
    return this.#db.tx(this.#scope(a), async (sql) => {
      const list = await executions.listExecutions(sql, a.organization.id, f);
      const positions = queuePositions(await executions.queued(sql, a.organization.id));
      const ids = list.map((e) => e.id);
      const tests = await results.summaries(sql, a.organization.id, ids);
      const perf = await results.performanceSummaries(sql, a.organization.id, ids);
      return list.map((e) => ({ ...e, queuePosition: positions.get(e.id) ?? null, tests: tests.get(e.id) ?? null, performance: perf.get(e.id) ?? null }));
    });
  }

  async getExecution(actor: Actor, id: string): Promise<ExecutionDetail> {
    const a = await this.#foundation.authorize(actor, "view");
    const executionId = uuid(id, "Execução");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const e = await executions.getExecution(sql, a.organization.id, executionId);
      if (!e) throw notFound("Execução");
      const pipeline = (await pipelines.getPipeline(sql, a.organization.id, e.pipelineId))!;
      const open = (await resources.openLeases(sql, a.organization.id)).filter((l) => l.executionId === e.id);
      const names = await resources.listResources(sql, a.organization.id, true);
      const reruns = await executions.listReruns(sql, a.organization.id, e.id);
      return {
        execution: await this.#view(sql, e),
        pipeline: { id: pipeline.id, name: pipeline.name, externalUrl: pipeline.externalUrl, capabilities: pipeline.capabilities },
        transitions: await executions.listTransitions(sql, a.organization.id, e.id),
        leases: open.map((l) => ({
          resourceId: l.resourceId,
          resourceName: names.find((r) => r.id === l.resourceId)?.name ?? l.resourceId,
          holderKind: l.holderKind,
          expiresAt: l.expiresAt,
        })),
        reruns,
      };
    });
  }

  /** Logs da execução, lidos do provedor sob demanda (RF-058). Não são guardados pela plataforma. */
  async executionLogs(actor: Actor, id: string, meta: RequestMeta): Promise<AsyncIterable<LogChunk>> {
    const a = await this.#foundation.authorize(actor, "view");
    const executionId = uuid(id, "Execução");
    const { e, pipeline } = await this.#db.tx(this.#scope(a), async (sql) => {
      const e = await executions.getExecution(sql, a.organization.id, executionId);
      if (!e) throw notFound("Execução");
      return { e, pipeline: (await pipelines.getPipeline(sql, a.organization.id, e.pipelineId))! };
    });
    if (!e.externalRunId) throw new DomainError("conflict", "A execução ainda não chegou ao provedor: não há logs.");
    if (!pipeline.capabilities.read.logs) throw new DomainError("conflict", "O provedor desta pipeline não oferece logs pela plataforma.");
    const { connector, conn } = await this.#provider.open(a.organization.id, pipeline.integrationId, meta.correlationId, a.user.id);
    if (!connector.getLogs) throw new DomainError("conflict", "O conector desta pipeline não lê logs.");
    const source = connector.getLogs(conn, { externalPipelineId: pipeline.externalId, externalRunId: e.externalRunId });
    return (async function* () {
      try {
        for await (const chunk of source) yield chunk;
      } catch (error) {
        if (error instanceof NotSupportedError) throw new DomainError("conflict", error.message);
        providerFailure(error, false);
      }
    })();
  }

  // =====================================================================
  // Apoio
  // =====================================================================

  async #view(sql: Sql, e: Execution): Promise<ExecutionView> {
    const tests = (await results.summaries(sql, e.organizationId, [e.id])).get(e.id) ?? null;
    if (e.status !== "queued") return { ...e, queuePosition: null, tests };
    const positions = queuePositions(await executions.queued(sql, e.organizationId));
    return { ...e, queuePosition: positions.get(e.id) ?? null, tests };
  }

  /** Recurso liberado ou pedido saiu da fila: o próximo da fila tenta de novo. */
  async #wakeQueue(sql: Sql, organizationId: string): Promise<void> {
    for (const q of await executions.queued(sql, organizationId)) {
      await enqueueJob(sql, JOBS.dispatch, { executionId: q.id }, { organizationId, idempotencyKey: `dispatch:${q.id}` });
    }
  }

  async #activeManifest(sql: Sql, a: OrgActor, pipelineId: string): Promise<PipelineManifest> {
    const p = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
    if (!p) throw notFound("Pipeline");
    if (p.archivedAt) throw new DomainError("conflict", "A pipeline está arquivada.");
    return (await pipelines.getVersion(sql, a.organization.id, pipelineId, p.currentVersion))!.manifest;
  }

  #requireValid(manifest: PipelineManifest, values: Record<string, ParameterValue>): void {
    const { violations } = validateParameterValues(manifest, values);
    if (violations.length) throw new DomainError("invalid", "Há parâmetros inválidos no perfil.", { violations });
  }

  #profileFields(input: { name: unknown; description?: unknown; ref?: unknown; parameters?: unknown }) {
    return {
      name: text(input.name, "o nome do perfil"),
      description: optionalText(input.description, "a descrição", 500),
      ref: optionalText(input.ref, "a branch"),
      parameters: parameterValues(input.parameters),
    };
  }

  #busyPolicy(value: unknown): BusyPolicy | undefined {
    if (value === undefined || value === null) return undefined;
    if (value !== "queue" && value !== "reject") throw new DomainError("invalid", 'Política inválida: use "queue" (esperar) ou "reject" (recusar).');
    return value;
  }

  #ttl(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 60 || value > 86400) {
      throw new DomainError("invalid", "A validade do lease vai de 60 a 86400 segundos.");
    }
    return value;
  }

  #requireWritable(a: OrgActor): void {
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
  }

  async #unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("conflict", message);
      throw error;
    }
  }

  #scope(a: OrgActor) {
    return { organizationId: a.organization.id, userId: a.user.id };
  }

  #audit(
    sql: Sql,
    a: OrgActor,
    meta: RequestMeta,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: AuditEventInput["outcome"],
    details?: Record<string, unknown>,
  ) {
    return recordAudit(sql, {
      organizationId: a.organization.id,
      actorUserId: a.user.id,
      action,
      targetType,
      targetId,
      outcome,
      correlationId: meta.correlationId,
      ...(details ? { details } : {}),
    });
  }
}

/** Compara refs com ou sem o prefixo refs/heads/ ("main" = "refs/heads/main"). */
function sameRef(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (r: string) => (r.startsWith("refs/") ? r : `refs/heads/${r}`);
  return norm(a) === norm(b);
}
