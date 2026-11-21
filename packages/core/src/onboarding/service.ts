import { randomUUID } from "node:crypto";
import {
  PipelineManifestSchema,
  type ConnectorCapabilities,
  type ParameterSpec,
  type PipelineManifest,
} from "@painel/contracts";
import {
  NotSupportedError,
  ProviderError,
  type AppliedChange,
  type ConnectionContext,
  type ConnectorRegistry,
  type CreatedPipeline,
  type ExternalPipeline,
  type ExternalRepository,
  type PipelineConnector,
} from "@painel/connector-sdk";
import { lineDiff, yamlProblems, type DefinitionDiff } from "../pipelines/diff.ts";
import { PIPELINE_TEMPLATES, renderTemplate, type PipelineTemplate } from "../pipelines/templates.ts";
import { isUniqueViolation, type Database, type Sql } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import type { SecretStore } from "../shared/secret-store.ts";
import { recordAudit, type AuditEventInput } from "../modules/audit/index.ts";
import { integrations, type ConnectionCheckRecord, type Integration } from "../modules/integrations/index.ts";
import {
  compareWithProvider,
  pipelines,
  type ExternalSnapshot,
  type LinkedPipeline,
  type ManifestSource,
  type ManifestVersion,
  type ParameterProblem,
} from "../modules/pipelines/index.ts";
import { tenancy } from "../modules/tenancy/index.ts";
import type { Actor, FoundationService, OrgActor, RequestMeta } from "../foundation/service.ts";

// Casos de uso do incremento 2: integração com o provedor, descoberta, vínculo de pipeline ao
// projeto e manifesto versionado, tudo sem IA (CA-002, CA-003, CA-004, CA-026, CA-030, CA-040).
// A credencial só existe em texto claro dentro de uma chamada ao conector (RN-017).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CREDENTIAL = 2048;

export interface IntegrationView extends Integration {
  /** Quantas pipelines ativas usam esta integração. */
  pipelineCount?: number;
}

export interface DiscoveredPipeline extends ExternalPipeline {
  /** Projetos desta organização em que a pipeline já está vinculada. */
  linkedProjectIds: string[];
}

export interface PipelineDetail {
  pipeline: LinkedPipeline;
  integration: { id: string; name: string; kind: string; status: Integration["status"] };
  manifest: ManifestVersion;
  /** Diferenças entre o manifesto atual e os parâmetros que o provedor declara (CA-030). */
  problems: ParameterProblem[];
}

export interface DefinitionView {
  pipelineId: string;
  ref: string | null;
  path: string | null;
  format: "yaml" | "json" | "provider";
  content: string;
  /** Trava otimista: devolvida ao gravar. */
  revision: string;
  /** Como dá para gravar neste provedor (vazio = só leitura). */
  modes: Array<"commit" | "pull-request">;
}

export interface DefinitionPreview {
  diff: DefinitionDiff;
  problems: string[];
  revision: string;
}

export interface DefinitionApplied {
  change: AppliedChange;
  /** Pipeline relida depois do commit direto; null no PR (só muda depois do merge). */
  pipeline: PipelineDetail | null;
}

export interface PipelineCreated {
  change: AppliedChange;
  /** Já vinculada ao projeto; null quando foi por PR (vincular depois do merge). */
  pipeline: PipelineDetail | null;
}

const MAX_DEFINITION = 512 * 1024;

function definitionText(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid", "Informe o conteúdo do arquivo.");
  if (value.length > MAX_DEFINITION) throw new DomainError("invalid", "O arquivo passa do limite de 512 KB.");
  return value.endsWith("\n") ? value : `${value}\n`;
}

function changeMode(value: unknown): "commit" | "pull-request" {
  if (value === "commit" || value === "pull-request") return value;
  throw new DomainError("invalid", "Escolha como gravar: commit direto ou pull request.");
}

function commitMessage(value: unknown, fallback: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length > 2000) throw new DomainError("invalid", "A descrição da mudança pode ter no máximo 2000 caracteres.");
  return v || fallback;
}

function optionalRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, "a branch", 200);
}

export interface ManifestImportResult {
  detail: PipelineDetail;
  /** Referências reescritas para o destino (organização e projeto da importação). */
  rewritten: Array<{ field: string; from: string; to: string }>;
}

function text(value: unknown, what: string, max = 120): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new DomainError("invalid", `Informe ${what}.`);
  if (v.length > max) throw new DomainError("invalid", `${what[0]!.toUpperCase()}${what.slice(1)} pode ter no máximo ${max} caracteres.`);
  return v;
}

function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound(what);
  return value;
}

/**
 * Traduz falhas do provedor em erros que o usuário entende. `supplied` = a credencial acabou de
 * ser digitada (erro de entrada); senão é a guardada, que precisa ser atualizada.
 */
export function providerFailure(error: unknown, supplied: boolean): never {
  if (error instanceof NotSupportedError) {
    throw new DomainError("conflict", `O conector não suporta esta operação: ${error.message}`);
  }
  if (!(error instanceof ProviderError)) throw error;
  switch (error.kind) {
    case "auth":
      throw supplied
        ? new DomainError("invalid", "O provedor recusou a credencial: ela está errada, expirou ou foi revogada.")
        : new DomainError("provider", "O provedor recusou a credencial guardada. Atualize a credencial da integração.");
    case "permission":
      throw supplied
        ? new DomainError("invalid", "A credencial não tem permissão para esta operação no provedor.")
        : new DomainError("provider", "A credencial guardada não tem permissão para esta operação no provedor.");
    case "not-found":
      throw new DomainError("not-found", "Não encontrado no provedor, ou a credencial não tem acesso.");
    case "rate-limited":
      throw new DomainError("rate-limited", "O provedor limitou as requisições. Tente de novo em instantes.", {
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    case "unavailable":
      throw new DomainError("provider", "O provedor não respondeu. Tente de novo em instantes.");
    case "conflict":
      throw new DomainError("conflict", "O arquivo mudou no provedor desde que você abriu. Recarregue para ver a versão atual e refaça a alteração.");
    case "invalid":
      // Mensagens montadas pelo próprio conector, sem dado do provedor nem credencial.
      throw new DomainError("invalid", error.message);
  }
}

export class OnboardingService {
  readonly #db: Database;
  readonly #foundation: FoundationService;
  readonly #secrets: SecretStore;
  readonly #connectors: ConnectorRegistry;

  constructor(db: Database, foundation: FoundationService, secrets: SecretStore, connectors: ConnectorRegistry) {
    this.#db = db;
    this.#foundation = foundation;
    this.#secrets = secrets;
    this.#connectors = connectors;
  }

  /** Tipos de provedor disponíveis nesta instalação (RF-013). */
  connectorKinds(): string[] {
    return this.#connectors.kinds();
  }

  // =====================================================================
  // Integrações (CA-002, CA-003)
  // =====================================================================

  /** Testa a credencial antes de guardar: credencial recusada não vira integração (CA-003). */
  async createIntegration(
    actor: Actor,
    input: { kind: unknown; name: unknown; endpoint: unknown; credential: unknown },
    meta: RequestMeta,
  ): Promise<{ integration: Integration; check: ConnectionCheckRecord }> {
    const a = await this.#authorize(actor, "manageIntegrations", meta, "integration.create");
    const kind = text(input.kind, "o tipo de provedor", 40);
    const connector = this.#connector(kind);
    const name = text(input.name, "o nome da integração");
    const endpoint = text(input.endpoint, "o endereço da organização no provedor", 300);
    const credential = this.#credentialText(input.credential);
    const id = randomUUID();

    const check = await this.#check(a, connector, { id, endpoint, credential }, meta);
    if (!check.ok) {
      await this.#audit(a, meta, "integration.create", "integration", null, "failed", {
        kind,
        endpoint,
        missingPermissions: check.missingPermissions,
      });
      throw new DomainError("invalid", check.message ?? "O provedor recusou a conexão.", {
        missingPermissions: check.missingPermissions,
      });
    }

    const sealed = await this.#secrets.seal(a.organization.id, credential);
    const integration = await this.#db.tx(this.#scope(a), async (sql) => {
      const created = await this.#unique(
        () =>
          integrations.insertIntegration(sql, {
            id,
            organizationId: a.organization.id,
            kind,
            name,
            endpoint,
            credentialKind: "pat",
            credential: sealed,
            check,
            createdBy: a.user.id,
          }),
        "Já existe uma integração com esse nome.",
      );
      await this.#auditIn(sql, a, meta, "integration.create", "integration", id, "success", { kind, endpoint });
      return created;
    });
    return { integration, check };
  }

  async listIntegrations(actor: Actor, includeArchived = false): Promise<Integration[]> {
    const a = await this.#authorize(actor, "view");
    return this.#db.tx(this.#scope(a), (sql) => integrations.listIntegrations(sql, a.organization.id, includeArchived));
  }

  async getIntegration(actor: Actor, id: string): Promise<Integration> {
    const a = await this.#authorize(actor, "view");
    return this.#db.tx(this.#scope(a), (sql) => this.#requireIntegration(sql, a, id, false));
  }

  /** Repete o teste com a credencial guardada e registra o resultado (RF-014). */
  async testIntegration(actor: Actor, id: string, meta: RequestMeta): Promise<ConnectionCheckRecord> {
    const a = await this.#authorize(actor, "manageIntegrations", meta, "integration.test");
    const { integration, conn } = await this.#connection(a, id, meta);
    let check: ConnectionCheckRecord;
    try {
      check = toCheckRecord(await this.#connector(integration.kind).testConnection(conn));
    } catch (error) {
      check = failedCheck(error);
    }
    await this.#db.tx(this.#scope(a), async (sql) => {
      await integrations.updateIntegration(sql, a.organization.id, id, { check });
      await this.#auditIn(sql, a, meta, "integration.test", "integration", id, check.ok ? "success" : "failed", {
        missingPermissions: check.missingPermissions,
      });
    });
    return check;
  }

  /** Troca a credencial. A nova é testada antes; se falhar, a antiga continua valendo. */
  async rotateCredential(actor: Actor, id: string, input: { credential: unknown }, meta: RequestMeta): Promise<Integration> {
    const a = await this.#authorize(actor, "manageIntegrations", meta, "integration.credential.rotate");
    const credential = this.#credentialText(input.credential);
    const current = await this.#db.tx(this.#scope(a), (sql) => this.#requireIntegration(sql, a, id, true));
    const check = await this.#check(a, this.#connector(current.kind), { id, endpoint: current.endpoint, credential }, meta);
    if (!check.ok) {
      await this.#audit(a, meta, "integration.credential.rotate", "integration", id, "failed", {
        missingPermissions: check.missingPermissions,
      });
      throw new DomainError("invalid", check.message ?? "O provedor recusou a nova credencial.", {
        missingPermissions: check.missingPermissions,
      });
    }
    const sealed = await this.#secrets.seal(a.organization.id, credential);
    return this.#db.tx(this.#scope(a), async (sql) => {
      const updated = await integrations.updateIntegration(sql, a.organization.id, id, { credential: sealed, check });
      await this.#auditIn(sql, a, meta, "integration.credential.rotate", "integration", id, "success");
      return updated!;
    });
  }

  async renameIntegration(actor: Actor, id: string, input: { name: unknown }, meta: RequestMeta): Promise<Integration> {
    const a = await this.#authorize(actor, "manageIntegrations", meta, "integration.update");
    const name = text(input.name, "o nome da integração");
    return this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requireIntegration(sql, a, id, true);
      const updated = await this.#unique(
        () => integrations.updateIntegration(sql, a.organization.id, id, { name }),
        "Já existe uma integração com esse nome.",
      );
      await this.#auditIn(sql, a, meta, "integration.update", "integration", id, "success", { name });
      return updated!;
    });
  }

  /** Só arquiva integração sem pipelines ativas: senão elas perderiam o acesso ao provedor. */
  async setIntegrationArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<Integration> {
    const action = archived ? "integration.archive" : "integration.unarchive";
    const a = await this.#authorize(actor, "manageIntegrations", meta, action);
    return this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requireIntegration(sql, a, id, false);
      if (archived && (await pipelines.linkedExternalIds(sql, a.organization.id, id)).size > 0) {
        throw new DomainError("conflict", "Há pipelines usando esta integração. Arquive-as antes.");
      }
      const updated = await this.#unique(
        () => integrations.updateIntegration(sql, a.organization.id, id, { archived }),
        "Já existe uma integração ativa com esse nome.",
      );
      await this.#auditIn(sql, a, meta, action, "integration", id, "success");
      return updated!;
    });
  }

  // =====================================================================
  // Descoberta e vínculo (CA-004)
  // =====================================================================

  async discoverPipelines(
    actor: Actor,
    integrationId: string,
    query: { cursor?: string; search?: string },
    meta: RequestMeta,
  ): Promise<{ items: DiscoveredPipeline[]; nextCursor?: string }> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.discover");
    const { integration, conn } = await this.#connection(a, integrationId, meta);
    let page;
    try {
      page = await this.#connector(integration.kind).listPipelines(conn, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.search?.trim() ? { search: query.search.trim().slice(0, 100) } : {}),
      });
    } catch (error) {
      providerFailure(error, false);
    }
    const linked = await this.#db.tx(this.#scope(a), (sql) => pipelines.linkedExternalIds(sql, a.organization.id, integrationId));
    const items = page.items.map((p) => ({ ...p, linkedProjectIds: linked.get(p.externalId) ?? [] }));
    return page.nextCursor ? { items, nextCursor: page.nextCursor } : { items };
  }

  /**
   * Vincula uma pipeline do provedor a um projeto. A versão 1 do manifesto sai da descoberta:
   * parâmetros como o provedor declara, em rascunho, esperando revisão humana.
   * `ref`: branch de onde ler os parâmetros (o YAML muda por branch; S1, achado 1).
   */
  async importPipeline(
    actor: Actor,
    input: { projectId: unknown; integrationId: unknown; externalId: unknown; ref?: unknown },
    meta: RequestMeta,
  ): Promise<PipelineDetail> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.import");
    this.#requireWritable(a);
    const projectId = uuid(input.projectId, "Projeto");
    const integrationId = uuid(input.integrationId, "Integração");
    const externalId = text(input.externalId, "a pipeline do provedor", 200);
    const ref = input.ref === undefined || input.ref === null || input.ref === "" ? undefined : text(input.ref, "a branch", 200);

    await this.#db.tx(this.#scope(a), (sql) => this.#requireActiveProject(sql, a, projectId));
    const { integration, conn } = await this.#connection(a, integrationId, meta);
    const snapshot = await this.#snapshot(this.#connector(integration.kind), conn, externalId, ref);
    const manifest = this.#discoveryManifest(a, projectId, integration, externalId, snapshot);

    return this.#createLinked(a, meta, { projectId, integration, externalId, snapshot, manifest, source: "discovery" }, "pipeline.import");
  }

  async listLinkedPipelines(actor: Actor, filter: { projectId?: string; q?: string; includeArchived?: boolean } = {}): Promise<LinkedPipeline[]> {
    const a = await this.#authorize(actor, "view");
    if (filter.projectId !== undefined) uuid(filter.projectId, "Projeto");
    return this.#db.tx(this.#scope(a), (sql) => pipelines.listPipelines(sql, a.organization.id, filter));
  }

  /** Dados sincronizados, origem, revisão, capacidades e manifesto atual (CA-030). */
  async getPipelineDetail(actor: Actor, id: string): Promise<PipelineDetail> {
    const a = await this.#authorize(actor, "view");
    return this.#db.tx(this.#scope(a), (sql) => this.#detail(sql, a, uuid(id, "Pipeline")));
  }

  /** Busca de novo no provedor. Se falhar, o dado guardado fica marcado como desconhecido (RNF-025). */
  async syncPipeline(actor: Actor, id: string, input: { ref?: unknown }, meta: RequestMeta): Promise<PipelineDetail> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.sync");
    const pipelineId = uuid(id, "Pipeline");
    const current = await this.#db.tx(this.#scope(a), async (sql) => {
      const p = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
      if (!p) throw notFound("Pipeline");
      if (p.archivedAt) throw new DomainError("conflict", "A pipeline está arquivada.");
      return p;
    });
    const ref =
      input.ref === undefined || input.ref === null || input.ref === "" ? (current.parametersRef ?? undefined) : text(input.ref, "a branch", 200);
    const { integration, conn } = await this.#connection(a, current.integrationId, meta);
    let snapshot: ExternalSnapshot;
    try {
      snapshot = await this.#snapshot(this.#connector(integration.kind), conn, current.externalId, ref);
    } catch (error) {
      const message = error instanceof DomainError ? error.message : "falha ao sincronizar";
      await this.#db.tx(this.#scope(a), async (sql) => {
        await pipelines.markSyncProblem(sql, a.organization.id, pipelineId, message);
        await this.#auditIn(sql, a, meta, "pipeline.sync", "pipeline", pipelineId, "failed", { problem: message });
      });
      throw error;
    }
    return this.#db.tx(this.#scope(a), async (sql) => {
      await pipelines.updateSnapshot(sql, a.organization.id, pipelineId, snapshot);
      await this.#auditIn(sql, a, meta, "pipeline.sync", "pipeline", pipelineId, "success", {
        externalRevision: snapshot.externalRevision ?? null,
        definitionRevision: snapshot.definitionRevision ?? null,
        parametersRef: snapshot.parametersRef ?? null,
      });
      return this.#detail(sql, a, pipelineId);
    });
  }

  async setPipelineArchived(actor: Actor, id: string, archived: boolean, meta: RequestMeta): Promise<LinkedPipeline> {
    const action = archived ? "pipeline.archive" : "pipeline.unarchive";
    const a = await this.#authorize(actor, "configurePipelines", meta, action);
    const pipelineId = uuid(id, "Pipeline");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const updated = await this.#unique(
        () => pipelines.setArchived(sql, a.organization.id, pipelineId, archived),
        "Esta pipeline já está vinculada a este projeto.",
      );
      if (!updated) throw notFound("Pipeline");
      await this.#auditIn(sql, a, meta, action, "pipeline", pipelineId, "success");
      return updated;
    });
  }

  // =====================================================================
  // Manifesto versionado (CA-026, CA-040)
  // =====================================================================

  /**
   * Salva uma versão nova do manifesto pelo formulário ou pela API (CA-026). `expectedVersion` é a
   * versão que o usuário editou: se outra pessoa salvou antes, recusa em vez de sobrescrever.
   */
  async saveManifest(
    actor: Actor,
    id: string,
    input: { manifest: unknown; expectedVersion: unknown; note?: unknown },
    meta: RequestMeta,
  ): Promise<PipelineDetail> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.manifest.save");
    this.#requireWritable(a);
    const pipelineId = uuid(id, "Pipeline");
    if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion)) {
      throw new DomainError("invalid", "Informe expectedVersion: a versão do manifesto que você editou.");
    }
    const expectedVersion = input.expectedVersion;
    const note = input.note === undefined || input.note === null || input.note === "" ? undefined : text(input.note, "a nota", 500);
    const manifest = parseManifest(input.manifest);

    return this.#db.tx(this.#scope(a), async (sql) => {
      const p = await pipelines.getPipelineForUpdate(sql, a.organization.id, pipelineId);
      if (!p) throw notFound("Pipeline");
      if (p.archivedAt) throw new DomainError("conflict", "A pipeline está arquivada.");
      if (p.currentVersion !== expectedVersion) {
        throw new DomainError("conflict", `O manifesto mudou desde que você abriu (versão atual: ${p.currentVersion}). Recarregue e refaça a alteração.`, {
          currentVersion: p.currentVersion,
        });
      }
      const integration = await integrations.getIntegration(sql, a.organization.id, p.integrationId);
      const expected = this.#identity(a, p.projectId, integration!, p.externalId);
      const mismatched = identityMismatches(manifest, expected);
      if (mismatched.length) {
        throw new DomainError("invalid", "O manifesto não pode trocar a organização, o projeto, a integração ou a pipeline externa.", {
          fields: mismatched.map((m) => m.field),
        });
      }
      requireCompatible(manifest.parameters, p.externalParameters);
      await pipelines.insertVersion(sql, {
        organizationId: a.organization.id,
        pipelineId,
        version: p.currentVersion + 1,
        manifest,
        source: "manual",
        ...(note ? { note } : {}),
        createdBy: a.user.id,
      });
      await this.#auditIn(sql, a, meta, "pipeline.manifest.save", "pipeline", pipelineId, "success", {
        version: p.currentVersion + 1,
        parameters: manifest.parameters.length,
      });
      return this.#detail(sql, a, pipelineId);
    });
  }

  async listManifestVersions(actor: Actor, id: string): Promise<Array<Omit<ManifestVersion, "manifest">>> {
    const a = await this.#authorize(actor, "view");
    const pipelineId = uuid(id, "Pipeline");
    return this.#db.tx(this.#scope(a), async (sql) => {
      if (!(await pipelines.getPipeline(sql, a.organization.id, pipelineId))) throw notFound("Pipeline");
      return pipelines.listVersions(sql, a.organization.id, pipelineId);
    });
  }

  async getManifestVersion(actor: Actor, id: string, version: number): Promise<ManifestVersion> {
    const a = await this.#authorize(actor, "view");
    const pipelineId = uuid(id, "Pipeline");
    if (!Number.isInteger(version) || version < 1) throw notFound("Versão");
    return this.#db.tx(this.#scope(a), async (sql) => {
      const v = await pipelines.getVersion(sql, a.organization.id, pipelineId, version);
      if (!v) throw notFound("Versão");
      return v;
    });
  }

  /**
   * Importa um manifesto (de outra instalação, de um arquivo) para um projeto (CA-040).
   * Valida esquema e referências; a credencial nunca vem no manifesto: a integração citada em
   * provider.integrationRef precisa já existir aqui, cadastrada com a credencial à parte.
   */
  async importManifest(
    actor: Actor,
    input: { projectId: unknown; manifest: unknown; ref?: unknown },
    meta: RequestMeta,
  ): Promise<ManifestImportResult> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.manifest.import");
    this.#requireWritable(a);
    const projectId = uuid(input.projectId, "Projeto");
    const manifest = parseManifest(input.manifest);
    const ref = input.ref === undefined || input.ref === null || input.ref === "" ? undefined : text(input.ref, "a branch", 200);

    const integration = await this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requireActiveProject(sql, a, projectId);
      const found = await integrations.getIntegrationByName(sql, a.organization.id, manifest.provider.integrationRef);
      if (!found) {
        throw new DomainError(
          "conflict",
          `A integração "${manifest.provider.integrationRef}" não existe nesta organização. Cadastre-a, com a credencial, e importe de novo.`,
          { missingIntegration: manifest.provider.integrationRef, kind: manifest.provider.kind },
        );
      }
      if (found.kind !== manifest.provider.kind) {
        throw new DomainError("invalid", `A integração "${found.name}" é do tipo ${found.kind}, e o manifesto pede ${manifest.provider.kind}.`);
      }
      return found;
    });

    // A pipeline externa precisa existir e ser acessível com a credencial da integração.
    const { conn } = await this.#connection(a, integration.id, meta);
    const snapshot = await this.#snapshot(this.#connector(integration.kind), conn, manifest.pipeline.externalId, ref);
    requireCompatible(manifest.parameters, snapshot.externalParameters);

    const target = this.#identity(a, projectId, integration, manifest.pipeline.externalId);
    const rewritten = identityMismatches(manifest, target).filter((m) => m.field === "organizationRef" || m.field === "projectRef");
    const final: PipelineManifest = {
      ...manifest,
      organizationRef: target.organizationRef,
      projectRef: target.projectRef,
      provider: { kind: integration.kind, integrationRef: integration.name },
      // Manifesto importado sempre volta para revisão humana nesta instalação.
      review: { status: "draft", requiresHumanApproval: true },
    };
    const detail = await this.#createLinked(
      a,
      meta,
      { projectId, integration, externalId: manifest.pipeline.externalId, snapshot, manifest: final, source: "import" },
      "pipeline.manifest.import",
    );
    return { detail, rewritten };
  }

  // =====================================================================
  // Incremento 8: base e gravação do onboarding assistido por IA (FLX-008)
  // =====================================================================

  /**
   * O que a descoberta automática lê da pipeline: é o ponto de partida da IA e o que a proposta
   * precisa respeitar (parâmetros reais do provedor). Não grava nada.
   */
  async assistBaseline(
    actor: Actor,
    input: { projectId: unknown; integrationId: unknown; externalId: unknown; ref?: unknown },
    meta: RequestMeta,
  ): Promise<{ manifest: PipelineManifest; providerParameters: string[]; ref: string | null; pipelineName: string; integrationKind: string; linkedPipelineId: string | null }> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "assist.session.start");
    const projectId = uuid(input.projectId, "Projeto");
    const integrationId = uuid(input.integrationId, "Integração");
    const externalId = text(input.externalId, "a pipeline do provedor", 200);
    const ref = input.ref === undefined || input.ref === null || input.ref === "" ? undefined : text(input.ref, "a branch", 200);
    await this.#db.tx(this.#scope(a), (sql) => this.#requireActiveProject(sql, a, projectId));
    const { integration, conn } = await this.#connection(a, integrationId, meta);
    const snapshot = await this.#snapshot(this.#connector(integration.kind), conn, externalId, ref);
    const linkedPipelineId = await this.#db.tx(this.#scope(a), async (sql) => {
      const list = await pipelines.listPipelines(sql, a.organization.id, { projectId });
      return list.find((p) => p.integrationId === integrationId && p.externalId === externalId && !p.archivedAt)?.id ?? null;
    });
    return {
      manifest: this.#discoveryManifest(a, projectId, integration, externalId, snapshot),
      providerParameters: snapshot.externalParameters.map((p) => p.name),
      ref: snapshot.parametersRef ?? null,
      pipelineName: snapshot.name,
      integrationKind: integration.kind,
      linkedPipelineId,
    };
  }

  /**
   * Grava a configuração aprovada por uma pessoa depois da sessão assistida (RF-181, RF-182,
   * RN-041, CA-044). Passa pela mesma validação do caminho manual, com os parâmetros lidos de novo
   * do provedor agora. Pipeline ainda não vinculada: vincula com o manifesto como versão 1;
   * já vinculada: grava uma versão nova. A origem fica "assist" no histórico.
   */
  async applyAssistedManifest(
    actor: Actor,
    input: { projectId: string; integrationId: string; externalId: string; ref: string | null; manifest: unknown; note?: string },
    meta: RequestMeta,
  ): Promise<PipelineDetail> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "assist.session.apply");
    this.#requireWritable(a);
    const parsed = parseManifest(input.manifest);
    const { integration, conn } = await this.#connection(a, input.integrationId, meta);
    const snapshot = await this.#snapshot(this.#connector(integration.kind), conn, input.externalId, input.ref ?? undefined);
    const target = this.#identity(a, input.projectId, integration, input.externalId);
    const manifest: PipelineManifest = {
      ...parsed,
      organizationRef: target.organizationRef,
      projectRef: target.projectRef,
      provider: { kind: integration.kind, integrationRef: integration.name },
      pipeline: { externalId: input.externalId, displayName: parsed.pipeline.displayName },
      // Aprovação é um passo humano separado, na tela de configuração (§19.5).
      review: { status: "draft", requiresHumanApproval: true },
    };
    requireCompatible(manifest.parameters, snapshot.externalParameters);
    const note = input.note ? input.note.slice(0, 500) : "Configuração proposta pela IA e revisada por uma pessoa";

    const existing = await this.#db.tx(this.#scope(a), async (sql) => {
      const list = await pipelines.listPipelines(sql, a.organization.id, { projectId: input.projectId });
      return list.find((p) => p.integrationId === integration.id && p.externalId === input.externalId && !p.archivedAt);
    });
    if (!existing) {
      return this.#createLinked(a, meta, { projectId: input.projectId, integration, externalId: input.externalId, snapshot, manifest, source: "assist" }, "pipeline.assist.apply");
    }
    return this.#db.tx(this.#scope(a), async (sql) => {
      const p = await pipelines.getPipelineForUpdate(sql, a.organization.id, existing.id);
      if (!p) throw notFound("Pipeline");
      await pipelines.insertVersion(sql, {
        organizationId: a.organization.id,
        pipelineId: p.id,
        version: p.currentVersion + 1,
        manifest,
        source: "assist",
        note,
        createdBy: a.user.id,
      });
      await this.#auditIn(sql, a, meta, "pipeline.assist.apply", "pipeline", p.id, "success", { version: p.currentVersion + 1, parameters: manifest.parameters.length });
      return this.#detail(sql, a, p.id);
    });
  }

  // =====================================================================
  // Incremento 4: arquivo da pipeline (ver, alterar com diff, criar por modelo)
  // =====================================================================

  /** YAML atual da pipeline numa branch, com a revisão que serve de trava ao gravar. */
  async getDefinition(actor: Actor, id: string, input: { ref?: unknown }, meta: RequestMeta): Promise<DefinitionView> {
    const a = await this.#authorize(actor, "view");
    const { pipeline, connector, conn } = await this.#pipelineConnection(a, id, meta);
    if (!connector.getDefinition) throw new DomainError("conflict", "O provedor desta pipeline não permite ler o arquivo pela plataforma.");
    const ref = optionalRef(input.ref);
    try {
      const snap = await connector.getDefinition(conn, pipeline.externalId, ref);
      const caps = await connector.capabilities(conn);
      const modes: Array<"commit" | "pull-request"> = [];
      if (connector.applyDefinitionChange && caps.write.definitionViaCommit) modes.push("commit");
      if (connector.applyDefinitionChange && caps.write.definitionViaPullRequest) modes.push("pull-request");
      return { pipelineId: pipeline.id, ref: ref ?? null, path: snap.path ?? null, format: snap.format, content: snap.content, revision: snap.revision, modes };
    } catch (error) {
      providerFailure(error, false);
    }
  }

  /** Diferença e problemas de sintaxe da mudança proposta. Nada é gravado. */
  async previewDefinitionChange(actor: Actor, id: string, input: { content: unknown; ref?: unknown }, meta: RequestMeta): Promise<DefinitionPreview> {
    await this.#authorize(actor, "configurePipelines");
    const content = definitionText(input.content);
    const current = await this.getDefinition(actor, id, { ref: input.ref }, meta);
    return { diff: lineDiff(current.content, content), problems: yamlProblems(content), revision: current.revision };
  }

  /**
   * Grava o YAML: commit direto ou PR, como a pessoa escolher (PR não é obrigatório). A gravação
   * só acontece se o arquivo ainda estiver na revisão que ela viu (RN-043, CA-032).
   */
  async applyDefinitionChange(
    actor: Actor,
    id: string,
    input: { content: unknown; expectedRevision: unknown; mode: unknown; message?: unknown; ref?: unknown },
    meta: RequestMeta,
  ): Promise<DefinitionApplied> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.definition.change");
    this.#requireWritable(a);
    const content = definitionText(input.content);
    const problems = yamlProblems(content);
    if (problems.length) throw new DomainError("invalid", "O YAML tem problemas de sintaxe.", { problems });
    const mode = changeMode(input.mode);
    const expectedRevision = text(input.expectedRevision, "a revisão lida", 200);
    const message = commitMessage(input.message, "Alteração da pipeline pelo Nexo");
    const ref = optionalRef(input.ref);
    const { pipeline, connector, conn } = await this.#pipelineConnection(a, id, meta);
    if (!connector.applyDefinitionChange) throw new DomainError("conflict", "O provedor desta pipeline não permite gravar o arquivo pela plataforma.");
    let change: AppliedChange;
    try {
      change = await connector.applyDefinitionChange(
        conn,
        { externalPipelineId: pipeline.externalId, newContent: content, justification: message, ...(ref ? { branch: ref } : {}) },
        mode,
        expectedRevision,
      );
    } catch (error) {
      await this.#audit(a, meta, "pipeline.definition.change", "pipeline", pipeline.id, "failed", { mode, problem: error instanceof Error ? error.message.slice(0, 200) : "erro" });
      providerFailure(error, false);
    }
    await this.#audit(a, meta, "pipeline.definition.change", "pipeline", pipeline.id, "success", {
      mode,
      externalRevision: change.externalRevision,
      ...(change.url ? { url: change.url } : {}),
    });
    // Commit direto: os parâmetros podem ter mudado; relê do provedor (falha aqui não desfaz a gravação).
    let detail: PipelineDetail | null = null;
    if (mode === "commit") detail = await this.syncPipeline(actor, pipeline.id, {}, meta).catch(() => null);
    return { change, pipeline: detail };
  }

  /** Repositórios onde a integração pode criar o arquivo de uma pipeline nova. */
  async listRepositories(actor: Actor, integrationId: string, meta: RequestMeta): Promise<ExternalRepository[]> {
    const a = await this.#authorize(actor, "configurePipelines");
    const { integration, conn } = await this.#connection(a, integrationId, meta);
    const connector = this.#connector(integration.kind);
    if (!connector.listRepositories) throw new DomainError("conflict", "Este provedor não permite criar pipelines pela plataforma.");
    try {
      return await connector.listRepositories(conn);
    } catch (error) {
      providerFailure(error, false);
    }
  }

  async pipelineTemplates(actor: Actor): Promise<PipelineTemplate[]> {
    await this.#authorize(actor, "view");
    return PIPELINE_TEMPLATES;
  }

  /** Monta o YAML a partir do modelo, para a pessoa revisar (e editar) antes de criar. */
  async renderPipelineTemplate(
    actor: Actor,
    input: { integrationId: unknown; templateId: unknown; name: unknown; values?: unknown },
  ): Promise<{ content: string; path: string; problems: string[] }> {
    const a = await this.#authorize(actor, "configurePipelines");
    const integrationId = uuid(input.integrationId, "Integração");
    const integration = await this.#db.tx(this.#scope(a), (sql) => this.#requireIntegration(sql, a, integrationId, true));
    if (integration.kind !== "azure-devops" && integration.kind !== "github") throw new DomainError("invalid", "Ainda não há modelos para este provedor.");
    const values = input.values && typeof input.values === "object" && !Array.isArray(input.values) ? (input.values as Record<string, unknown>) : {};
    const rendered = renderTemplate(integration.kind, text(input.templateId, "o modelo", 60), text(input.name, "o nome da pipeline", 120), values);
    return { ...rendered, problems: yamlProblems(rendered.content) };
  }

  /**
   * Cria a pipeline: grava o arquivo (commit ou PR) e, no commit direto, registra no provedor e já
   * vincula ao projeto. Pelo PR, a pipeline passa a existir depois do merge e é vinculada pela descoberta.
   */
  async createPipeline(
    actor: Actor,
    input: {
      projectId: unknown;
      integrationId: unknown;
      repositoryId: unknown;
      branch: unknown;
      path: unknown;
      name: unknown;
      content: unknown;
      mode: unknown;
      message?: unknown;
    },
    meta: RequestMeta,
  ): Promise<PipelineCreated> {
    const a = await this.#authorize(actor, "configurePipelines", meta, "pipeline.create");
    this.#requireWritable(a);
    const projectId = uuid(input.projectId, "Projeto");
    const repositoryId = text(input.repositoryId, "o repositório", 300);
    const branch = text(input.branch, "a branch", 200);
    const path = text(input.path, "o caminho do arquivo", 300);
    if (path.split("/").some((p) => p === ".." || p === ".")) throw new DomainError("invalid", "Caminho do arquivo inválido.");
    if (!/\.ya?ml$/i.test(path)) throw new DomainError("invalid", "O arquivo precisa terminar em .yml ou .yaml.");
    const name = text(input.name, "o nome da pipeline", 120);
    const content = definitionText(input.content);
    const problems = yamlProblems(content);
    if (problems.length) throw new DomainError("invalid", "O YAML tem problemas de sintaxe.", { problems });
    const mode = changeMode(input.mode);
    const message = commitMessage(input.message, `Cria a pipeline ${name} pelo Nexo`);

    await this.#db.tx(this.#scope(a), (sql) => this.#requireActiveProject(sql, a, projectId));
    const { integration, conn } = await this.#connection(a, text(input.integrationId, "a integração", 60), meta);
    const connector = this.#connector(integration.kind);
    if (!connector.createPipeline) throw new DomainError("conflict", "Este provedor não permite criar pipelines pela plataforma.");
    let created: CreatedPipeline;
    try {
      created = await connector.createPipeline(conn, { repositoryId, branch, path, content, name, justification: message, mode });
    } catch (error) {
      await this.#audit(a, meta, "pipeline.create", "pipeline", null, "failed", { name, mode, problem: error instanceof Error ? error.message.slice(0, 200) : "erro" });
      providerFailure(error, false);
    }
    await this.#audit(a, meta, "pipeline.create", "pipeline", null, "success", {
      name,
      mode,
      externalRevision: created.change.externalRevision,
      ...(created.change.url ? { url: created.change.url } : {}),
    });
    if (!created.pipeline) return { change: created.change, pipeline: null };
    // Já existe no provedor: vincula como a descoberta faria.
    const snapshot = await this.#snapshot(connector, conn, created.pipeline.externalId, branch);
    const manifest = this.#discoveryManifest(a, projectId, integration, created.pipeline.externalId, snapshot);
    const detail = await this.#createLinked(a, meta, { projectId, integration, externalId: created.pipeline.externalId, snapshot, manifest, source: "discovery" }, "pipeline.import");
    return { change: created.change, pipeline: detail };
  }

  async #pipelineConnection(a: OrgActor, id: string, meta: RequestMeta) {
    const pipelineId = uuid(id, "Pipeline");
    const pipeline = await this.#db.tx(this.#scope(a), async (sql) => {
      const p = await pipelines.getPipeline(sql, a.organization.id, pipelineId);
      if (!p) throw notFound("Pipeline");
      if (p.archivedAt) throw new DomainError("conflict", "A pipeline está arquivada.");
      return p;
    });
    const { integration, conn } = await this.#connection(a, pipeline.integrationId, meta);
    return { pipeline, integration, connector: this.#connector(integration.kind), conn };
  }

  // =====================================================================
  // Apoio
  // =====================================================================

  async #authorize(actor: Actor, operation: Parameters<FoundationService["authorize"]>[1], meta?: RequestMeta, action?: string) {
    return this.#foundation.authorize(actor, operation, meta, action);
  }

  #requireWritable(a: OrgActor): void {
    if (a.organization.archived) throw new DomainError("conflict", "A organização está arquivada e só permite leitura.");
  }

  #connector(kind: string): PipelineConnector {
    try {
      return this.#connectors.get(kind);
    } catch {
      throw new DomainError("invalid", `Tipo de provedor desconhecido. Disponíveis: ${this.#connectors.kinds().join(", ")}.`);
    }
  }

  #credentialText(value: unknown): string {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) throw new DomainError("invalid", "Informe a credencial (PAT).");
    if (v.length > MAX_CREDENTIAL || /\s/.test(v)) throw new DomainError("invalid", "Credencial em formato inválido.");
    return v;
  }

  /** Testa uma credencial digitada agora. Erros de rede/endpoint viram resposta, não exceção. */
  async #check(
    a: OrgActor,
    connector: PipelineConnector,
    target: { id: string; endpoint: string; credential: string },
    meta: RequestMeta,
  ): Promise<ConnectionCheckRecord> {
    const conn: ConnectionContext = {
      organizationId: a.organization.id,
      integrationId: target.id,
      endpoint: target.endpoint,
      credential: { kind: "pat", value: target.credential },
      correlationId: meta.correlationId,
    };
    try {
      return toCheckRecord(await connector.testConnection(conn));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "invalid") {
        return { ok: false, missingPermissions: [], message: error.message };
      }
      return failedCheck(error);
    }
  }

  /** Abre a credencial guardada só para esta chamada. */
  async #connection(a: OrgActor, integrationId: string, meta: RequestMeta): Promise<{ integration: Integration; conn: ConnectionContext }> {
    const id = uuid(integrationId, "Integração");
    const { integration, sealed } = await this.#db.tx(this.#scope(a), async (sql) => {
      const found = await this.#requireIntegration(sql, a, id, true);
      return { integration: found, sealed: (await integrations.getSealedCredential(sql, a.organization.id, id))! };
    });
    const value = await this.#secrets.open(a.organization.id, sealed);
    return {
      integration,
      conn: {
        organizationId: a.organization.id,
        integrationId: id,
        endpoint: integration.endpoint,
        credential: { kind: integration.credentialKind, value },
        correlationId: meta.correlationId,
      },
    };
  }

  async #snapshot(connector: PipelineConnector, conn: ConnectionContext, externalId: string, ref: string | undefined): Promise<ExternalSnapshot> {
    try {
      const capabilities: ConnectorCapabilities = await connector.capabilities(conn);
      const detail = await connector.getPipeline(conn, externalId);
      const parametersRef = ref ?? detail.defaultRef;
      const externalParameters: ParameterSpec[] = capabilities.read.parameters
        ? await connector.getParameters(conn, externalId, parametersRef)
        : [];
      const definition = capabilities.read.definition && connector.getDefinition ? await connector.getDefinition(conn, externalId) : undefined;
      const snapshot: ExternalSnapshot = { name: detail.name.slice(0, 200), capabilities, externalParameters };
      if (detail.url) snapshot.externalUrl = detail.url;
      if (detail.path) snapshot.externalPath = detail.path;
      if (detail.repository) {
        snapshot.repositoryName = detail.repository.name.slice(0, 200);
        if (detail.repository.url?.startsWith("https://")) snapshot.repositoryUrl = detail.repository.url;
      }
      if (detail.defaultRef) snapshot.defaultRef = detail.defaultRef;
      if (parametersRef) snapshot.parametersRef = parametersRef;
      if (detail.revision) snapshot.externalRevision = detail.revision;
      if (definition) snapshot.definitionRevision = definition.revision;
      return snapshot;
    } catch (error) {
      providerFailure(error, false);
    }
  }

  #identity(a: OrgActor, projectId: string, integration: Pick<Integration, "kind" | "name">, externalId: string) {
    return {
      organizationRef: a.organization.slug,
      projectRef: projectId,
      kind: integration.kind,
      integrationRef: integration.name,
      externalId,
    };
  }

  #discoveryManifest(a: OrgActor, projectId: string, integration: Integration, externalId: string, s: ExternalSnapshot): PipelineManifest {
    return PipelineManifestSchema.parse({
      schemaVersion: "1",
      organizationRef: a.organization.slug,
      projectRef: projectId,
      provider: { kind: integration.kind, integrationRef: integration.name },
      pipeline: { externalId, displayName: s.name },
      parameters: s.externalParameters,
      validationRules: [],
      executionResources: [],
      reports: [],
      review: { status: "draft", requiresHumanApproval: true },
    });
  }

  async #createLinked(
    a: OrgActor,
    meta: RequestMeta,
    input: {
      projectId: string;
      integration: Integration;
      externalId: string;
      snapshot: ExternalSnapshot;
      manifest: PipelineManifest;
      source: ManifestSource;
    },
    action: string,
  ): Promise<PipelineDetail> {
    const id = randomUUID();
    return this.#db.tx(this.#scope(a), async (sql) => {
      await this.#requireActiveProject(sql, a, input.projectId);
      await this.#unique(
        () =>
          pipelines.insertPipeline(
            sql,
            {
              id,
              organizationId: a.organization.id,
              projectId: input.projectId,
              integrationId: input.integration.id,
              externalId: input.externalId,
              createdBy: a.user.id,
            },
            input.snapshot,
          ),
        "Esta pipeline já está vinculada a este projeto.",
      );
      await pipelines.insertVersion(sql, {
        organizationId: a.organization.id,
        pipelineId: id,
        version: 1,
        manifest: input.manifest,
        source: input.source,
        createdBy: a.user.id,
      });
      await this.#auditIn(sql, a, meta, action, "pipeline", id, "success", {
        projectId: input.projectId,
        integrationId: input.integration.id,
        externalId: input.externalId,
        parametersRef: input.snapshot.parametersRef ?? null,
      });
      return this.#detail(sql, a, id);
    });
  }

  async #detail(sql: Sql, a: OrgActor, id: string): Promise<PipelineDetail> {
    const pipeline = await pipelines.getPipeline(sql, a.organization.id, id);
    if (!pipeline) throw notFound("Pipeline");
    const integration = await integrations.getIntegration(sql, a.organization.id, pipeline.integrationId);
    const manifest = await pipelines.getVersion(sql, a.organization.id, id, pipeline.currentVersion);
    return {
      pipeline,
      integration: { id: integration!.id, name: integration!.name, kind: integration!.kind, status: integration!.status },
      manifest: manifest!,
      problems: compareWithProvider(manifest!.manifest.parameters, pipeline.externalParameters),
    };
  }

  async #requireIntegration(sql: Sql, a: OrgActor, id: string, active: boolean): Promise<Integration> {
    const found = UUID.test(id) ? await integrations.getIntegration(sql, a.organization.id, id) : undefined;
    if (!found) throw notFound("Integração");
    if (active && found.archivedAt) throw new DomainError("conflict", "A integração está arquivada.");
    return found;
  }

  async #requireActiveProject(sql: Sql, a: OrgActor, projectId: string): Promise<void> {
    const project = await tenancy.getProject(sql, a.organization.id, projectId);
    if (!project) throw notFound("Projeto");
    if (project.archivedAt) throw new DomainError("conflict", "O projeto está arquivado.");
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

  #auditIn(
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

  #audit(
    a: OrgActor,
    meta: RequestMeta,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: AuditEventInput["outcome"],
    details?: Record<string, unknown>,
  ) {
    return this.#db.tx(this.#scope(a), (sql) => this.#auditIn(sql, a, meta, action, targetType, targetId, outcome, details));
  }
}

function toCheckRecord(check: { ok: boolean; identity?: string; missingPermissions: string[]; message?: string }): ConnectionCheckRecord {
  const out: ConnectionCheckRecord = { ok: check.ok, missingPermissions: [...check.missingPermissions] };
  if (check.identity) out.identity = check.identity.slice(0, 200);
  if (check.message) out.message = check.message.slice(0, 500);
  return out;
}

/** Falha de teste de conexão, numa mensagem segura para guardar e mostrar. */
function failedCheck(error: unknown): ConnectionCheckRecord {
  try {
    providerFailure(error, true);
  } catch (mapped) {
    if (mapped instanceof DomainError) return { ok: false, missingPermissions: [], message: mapped.message };
    throw mapped;
  }
}

function parseManifest(input: unknown): PipelineManifest {
  const parsed = PipelineManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("invalid", "Manifesto inválido.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

function identityMismatches(
  m: PipelineManifest,
  expected: { organizationRef: string; projectRef: string; kind: string; integrationRef: string; externalId: string },
): Array<{ field: string; from: string; to: string }> {
  const pairs: Array<[string, string, string]> = [
    ["organizationRef", m.organizationRef, expected.organizationRef],
    ["projectRef", m.projectRef, expected.projectRef],
    ["provider.kind", m.provider.kind, expected.kind],
    ["provider.integrationRef", m.provider.integrationRef, expected.integrationRef],
    ["pipeline.externalId", m.pipeline.externalId, expected.externalId],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field, from, to }));
}

function requireCompatible(manifest: readonly ParameterSpec[], provider: readonly ParameterSpec[]): void {
  const errors = compareWithProvider(manifest, provider).filter((p) => p.severity === "error");
  if (errors.length) {
    throw new DomainError("invalid", "O manifesto não bate com os parâmetros que a pipeline do provedor declara.", { problems: errors });
  }
}
