import type { ConnectorCapabilities, ParameterSpec } from "@painel/contracts";

// Contrato dos conectores (§10.1 da especificação, ampliado por §18 e Q-007). Versão: 1.
// Métodos opcionais ausentes significam "não suportado" e precisam bater com capabilities()
// (verificado por checkConformance). Nunca simular suporte: RN-024, RN-044, CA-023, CA-041.

export const CONNECTOR_CONTRACT_VERSION = "1";

/** Contexto de uma chamada. A credencial vem decifrada só durante a chamada e nunca vai para log (RN-017). */
export interface ConnectionContext {
  organizationId: string;
  integrationId: string;
  endpoint: string;
  credential: { kind: string; value: string };
  correlationId: string;
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ConnectionCheck {
  ok: boolean;
  identity?: string;
  missingPermissions: string[];
  message?: string;
}

export interface ExternalPipeline {
  externalId: string;
  name: string;
  path?: string;
  url?: string;
}

export interface ExternalPipelineDetail extends ExternalPipeline {
  defaultRef?: string;
  /** Repositório onde mora a definição (e normalmente o código testado). url sempre https. */
  repository?: { name: string; url?: string };
  revision?: string;
  raw?: unknown;
}

export interface TriggerRequest {
  externalPipelineId: string;
  ref?: string;
  parameters: Record<string, string | number | boolean>;
}

/** Branch ou tag do repositório da pipeline, para escolher a versão a executar. */
export interface ExternalRef {
  /** Nome curto para mostrar (ex.: testes-maquina). */
  name: string;
  /** Ref completa para enviar ao provedor (ex.: refs/heads/testes-maquina). */
  ref: string;
  kind: "branch" | "tag";
}

/** Resultado da validação feita pelo próprio provedor antes de disparar. */
export interface RunValidation {
  ok: boolean;
  /** Mensagens do provedor, curtas e sem credencial. */
  problems: string[];
}

export interface ExternalRunRef {
  externalPipelineId: string;
  externalRunId: string;
}

export interface ExternalRunState extends ExternalRunRef {
  externalStatus: string;
  /** Estado já traduzido pelo conector para o vocabulário da plataforma. */
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unknown";
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  sourceRevision?: string;
  agentOrPool?: string;
  /** Execução iniciada fora da plataforma (RF-052). */
  startedOutsidePlatform?: boolean;
  /** Número/nome da execução no provedor. Pode mudar durante a execução (a identidade é o id). */
  runNumber?: string;
  /** Marcadores que a pipeline pôs na execução (ex.: a versão do pacote testado). */
  tags?: string[];
  /** Ref (branch) usada pela execução; a definição e os parâmetros podem variar por ref. */
  ref?: string;
  /**
   * Valores de parâmetros como o provedor os guardou, sem tipo. O provedor pode gravar o mesmo
   * booleano como "True" ou "true"; quem tem o ParameterSpec converte (coerceParameterValues).
   */
  rawParameters?: Record<string, string>;
}

export interface LogChunk {
  stage?: string;
  text: string;
}

export interface ExternalArtifact {
  ref: string;
  name: string;
  sizeBytes?: number;
}

export interface ExternalSchedule {
  ref: string;
  cron: string;
  timeZone?: string;
  enabled: boolean;
}

export interface DefinitionSnapshot {
  revision: string;
  format: "yaml" | "json" | "provider";
  content: string;
  path?: string;
}

export interface DefinitionChange {
  externalPipelineId: string;
  newContent: string;
  /** Vira a mensagem do commit e a descrição do PR. */
  justification: string;
  /** Branch do arquivo; sem ela, a branch padrão da pipeline. */
  branch?: string;
}

export interface ChangePreview {
  diff: string;
  valid: boolean;
  problems: string[];
}

export interface AppliedChange {
  mode: "api" | "commit" | "pull-request";
  externalRevision: string;
  url?: string;
  /** Branch onde a mudança foi gravada (no PR, a branch criada para ele). */
  branch?: string;
}

/** Repositório onde dá para criar o arquivo de uma pipeline nova. */
export interface ExternalRepository {
  /** Id opaco para o conector (inclui o projeto/dono). */
  id: string;
  name: string;
  /** Projeto (Azure) ou dono (GitHub). */
  scope: string;
  defaultBranch?: string;
  url?: string;
}

export interface NewPipelineRequest {
  repositoryId: string;
  branch: string;
  /** Caminho do arquivo no repositório (ex.: pipelines/testes.yml ou .github/workflows/testes.yml). */
  path: string;
  content: string;
  name: string;
  justification: string;
  mode: "commit" | "pull-request";
}

export interface CreatedPipeline {
  change: AppliedChange;
  /** A pipeline já existe no provedor; ausente quando ela só passa a existir depois do merge do PR. */
  pipeline?: ExternalPipeline;
}

export interface ProviderEvent {
  externalEventId: string;
  type: "run.started" | "run.updated" | "run.completed" | "definition.changed";
  run?: ExternalRunRef;
}

export interface PipelineConnector {
  readonly kind: string;
  readonly contractVersion: typeof CONNECTOR_CONTRACT_VERSION;

  capabilities(conn: ConnectionContext): Promise<ConnectorCapabilities>;
  testConnection(conn: ConnectionContext): Promise<ConnectionCheck>;
  listPipelines(conn: ConnectionContext, query: { cursor?: string; search?: string }): Promise<Page<ExternalPipeline>>;
  getPipeline(conn: ConnectionContext, externalId: string): Promise<ExternalPipelineDetail>;
  getParameters(conn: ConnectionContext, externalId: string, ref?: string): Promise<ParameterSpec[]>;
  triggerRun(conn: ConnectionContext, request: TriggerRequest, idempotencyKey: string): Promise<ExternalRunRef>;
  getRun(conn: ConnectionContext, run: ExternalRunRef): Promise<ExternalRunState>;
  listRuns(conn: ConnectionContext, externalId: string, since: string): Promise<Page<ExternalRunState>>;

  cancelRun?(conn: ConnectionContext, run: ExternalRunRef): Promise<void>;
  /** Branches e tags do repositório da pipeline, filtradas por `search`. */
  listRefs?(conn: ConnectionContext, externalId: string, query: { search?: string; limit?: number }): Promise<ExternalRef[]>;
  /** Pede ao provedor para validar o pedido sem executar (parâmetros, tipos, YAML resolvido). */
  validateRun?(conn: ConnectionContext, request: TriggerRequest): Promise<RunValidation>;
  getLogs?(conn: ConnectionContext, run: ExternalRunRef, stage?: string): AsyncIterable<LogChunk>;
  listArtifacts?(conn: ConnectionContext, run: ExternalRunRef): Promise<ExternalArtifact[]>;
  downloadArtifact?(conn: ConnectionContext, artifact: ExternalArtifact): Promise<ReadableStream<Uint8Array>>;
  getSchedules?(conn: ConnectionContext, externalId: string): Promise<ExternalSchedule[]>;
  /** YAML da pipeline numa branch (padrão: a da pipeline). `revision` serve de trava otimista. */
  getDefinition?(conn: ConnectionContext, externalId: string, ref?: string): Promise<DefinitionSnapshot>;
  proposeDefinitionChange?(conn: ConnectionContext, change: DefinitionChange): Promise<ChangePreview>;
  /** expectedRevision é a trava otimista contra sobrescrever alteração de terceiros (RN-043, CA-032). */
  applyDefinitionChange?(
    conn: ConnectionContext,
    change: DefinitionChange,
    mode: AppliedChange["mode"],
    expectedRevision: string,
  ): Promise<AppliedChange>;
  /** Repositórios onde a credencial pode criar arquivos de pipeline. */
  listRepositories?(conn: ConnectionContext): Promise<ExternalRepository[]>;
  /** Grava o arquivo novo (commit ou PR) e, quando dá, registra a pipeline no provedor. */
  createPipeline?(conn: ConnectionContext, request: NewPipelineRequest): Promise<CreatedPipeline>;
  /** Valida assinatura e traduz o webhook; null quando o evento não interessa. */
  parseWebhook?(headers: Record<string, string>, body: string, secret: string): Promise<ProviderEvent | null>;
}

/** Erro padrão quando uma operação não é suportada ou ainda não foi implementada. */
export class NotSupportedError extends Error {
  readonly operation: string;
  constructor(operation: string, reason: string) {
    super(`${operation}: ${reason}`);
    this.name = "NotSupportedError";
    this.operation = operation;
  }
}

/**
 * Falha ao falar com o provedor, numa categoria que a plataforma entende sem conhecer o provedor.
 * A mensagem não carrega credencial nem corpo de resposta (RN-017, RNF-033).
 */
/** "conflict": o arquivo mudou no provedor desde a leitura (trava otimista, RN-043). */
export type ProviderErrorKind = "auth" | "permission" | "not-found" | "rate-limited" | "unavailable" | "invalid" | "conflict";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterSeconds?: number;
  constructor(kind: ProviderErrorKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
