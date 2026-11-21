import type { ConnectorCapabilities } from "@painel/contracts";
import {
  CONNECTOR_CONTRACT_VERSION,
  NotSupportedError,
  ProviderError,
  type ConnectionContext,
  type CreatedPipeline,
  type ExternalRepository,
  type DefinitionSnapshot,
  type ExternalArtifact,
  type ExternalPipeline,
  type ExternalPipelineDetail,
  type ExternalRef,
  type ExternalRunRef,
  type ExternalRunState,
  type LogChunk,
  type PipelineConnector,
} from "@painel/connector-sdk";
import { AzureDevOpsClient, AzureDevOpsHttpError, seg, type FetchLike } from "./http.ts";
import { parseYamlParameters } from "./parameters.ts";
import { startedByProvider, translateBuildStatus } from "./status.ts";
import { branchHead, toRepository, writeFile, type AzRepository } from "./write.ts";

export { AzureDevOpsHttpError, organizationUrl } from "./http.ts";
export { ParameterParseError, parseYamlParameters } from "./parameters.ts";
export { translateBuildStatus } from "./status.ts";

// Conector Azure DevOps Pipelines (RF-012).
// Cada capacidade "true" foi confirmada com chamadas reais no spike S1 (docs/spikes/S1-azure-devops.md),
// exceto a gravação do YAML (incremento 4), coberta por testes com respostas gravadas e a validar
// com o PAT real (precisa de Code: Read & Write). Ainda não: agendas (só as do designer aparecem na API)
// e service hooks (dependem de teste com PAT).

export const AZURE_DEVOPS_CAPABILITIES: ConnectorCapabilities = {
  read: {
    pipelines: true,
    parameters: true,
    runs: true,
    logs: true,
    artifacts: true,
    schedules: false,
    definition: true,
  },
  write: {
    triggerRun: true,
    cancelRun: true,
    definitionViaApi: false,
    definitionViaCommit: true,
    definitionViaPullRequest: true,
  },
  events: { webhooks: false },
};

/** Execuções lidas por chamada de listRuns; acima disso, nextCursor sinaliza que há mais. */
const MAX_RUNS_PER_LIST = 500;

// --- Identificadores -------------------------------------------------------------------------
// externalId de pipeline: "<id do projeto>/<id da definição>". O nome do projeto pode mudar; o id não.

function pipelineId(projectId: string, definitionId: number | string): string {
  return `${projectId}/${definitionId}`;
}

// O projeto entra no caminho da URL: "." e ".." subiriam de nível depois de normalizado.
const PROJECT = "((?!\\.{1,2}/)[A-Za-z0-9][A-Za-z0-9._-]{0,99})";
const PIPELINE_ID = new RegExp(`^${PROJECT}/(\\d{1,10})$`);
const ARTIFACT_REF = new RegExp(`^${PROJECT}/(\\d{1,10})/([^/]+)$`);

function parsePipelineId(externalId: string): { project: string; definitionId: number } {
  const match = PIPELINE_ID.exec(externalId);
  if (!match) throw new Error(`id de pipeline Azure DevOps inválido: ${externalId}`);
  return { project: match[1]!, definitionId: Number(match[2]) };
}

function parseRunId(run: ExternalRunRef): { project: string; definitionId: number; buildId: number } {
  const { project, definitionId } = parsePipelineId(run.externalPipelineId);
  if (!/^\d{1,10}$/.test(run.externalRunId)) throw new Error(`id de execução Azure DevOps inválido: ${run.externalRunId}`);
  return { project, definitionId, buildId: Number(run.externalRunId) };
}

function artifactRef(project: string, buildId: number, name: string): string {
  return `${project}/${buildId}/${encodeURIComponent(name)}`;
}

function parseArtifactRef(ref: string): { project: string; buildId: number; name: string } {
  const match = ARTIFACT_REF.exec(ref);
  if (!match) throw new Error(`referência de artefato Azure DevOps inválida: ${ref}`);
  return { project: match[1]!, buildId: Number(match[2]), name: decodeURIComponent(match[3]!) };
}

/** Só links https viram link na interface (nada de javascript: ou http vindo do provedor). */
function safeWebUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function fullRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

// --- Formas das respostas (só os campos usados) ----------------------------------------------

interface AzProject {
  id: string;
  name: string;
}
interface AzDefinitionRef {
  id: number;
  name: string;
  path?: string;
  revision?: number;
  project?: { id: string };
  _links?: { web?: { href?: string } };
}
interface AzDefinition extends AzDefinitionRef {
  process?: { type?: number; yamlFilename?: string };
  repository?: { id?: string; type?: string; name?: string; url?: string; defaultBranch?: string };
}
interface AzBuild {
  id: number;
  status?: unknown;
  result?: unknown;
  reason?: unknown;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  definition?: { id?: number };
  templateParameters?: Record<string, unknown>;
  buildNumber?: string;
  tags?: unknown;
}
interface AzList<T> {
  count?: number;
  value: T[];
}

function toRunState(projectId: string, build: AzBuild, definitionId: number): ExternalRunState {
  const { status, externalStatus } = translateBuildStatus(build.status, build.result);
  const state: ExternalRunState = {
    externalPipelineId: pipelineId(projectId, definitionId),
    externalRunId: String(build.id),
    externalStatus,
    status,
  };
  if (build.queueTime) state.queuedAt = build.queueTime;
  if (build.startTime) state.startedAt = build.startTime;
  if (build.finishTime) state.finishedAt = build.finishTime;
  if (build.sourceVersion) state.sourceRevision = build.sourceVersion;
  if (build.sourceBranch) state.ref = build.sourceBranch;
  // A pipeline pode trocar o número e pôr tags durante a execução (S1, achados 4 e 7): é onde
  // muitas marcam a versão do pacote testado. Por isso são relidos a cada acompanhamento.
  if (typeof build.buildNumber === "string" && build.buildNumber) state.runNumber = build.buildNumber.slice(0, 200);
  if (Array.isArray(build.tags)) state.tags = build.tags.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 200)).slice(0, 50);
  const outside = startedByProvider(build.reason);
  if (outside !== undefined) state.startedOutsidePlatform = outside;
  if (build.templateParameters) {
    state.rawParameters = Object.fromEntries(
      Object.entries(build.templateParameters).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
  }
  return state;
}

export interface AzureDevOpsConnectorOptions {
  /** Injetável nos testes; em produção, o fetch global. */
  fetch?: FetchLike;
  /** Hosts de Azure DevOps Server aceitos além de dev.azure.com e *.visualstudio.com. */
  extraHosts?: readonly string[];
}

export function createAzureDevOpsConnector(options: AzureDevOpsConnectorOptions = {}): PipelineConnector {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const client = (conn: ConnectionContext) => new AzureDevOpsClient(conn, fetchImpl, options.extraHosts);

  async function getDefinitionRecord(conn: ConnectionContext, externalId: string): Promise<AzDefinition> {
    const { project, definitionId } = parsePipelineId(externalId);
    const { data } = await client(conn).json<AzDefinition>(`/${seg(project)}/_apis/build/definitions/${definitionId}`, {
      operation: "getPipeline",
    });
    return data;
  }

  async function readYaml(
    conn: ConnectionContext,
    externalId: string,
    ref: string | undefined,
    operation: string,
  ): Promise<{ content: string; commitId: string; path: string }> {
    const { project } = parsePipelineId(externalId);
    const definition = await getDefinitionRecord(conn, externalId);
    if (definition.process?.type !== 2 || !definition.process.yamlFilename) {
      throw new NotSupportedError(operation, "pipeline clássica (designer), sem YAML");
    }
    if (definition.repository?.type !== "TfsGit" || !definition.repository.id) {
      throw new NotSupportedError(operation, `YAML fora do Azure Repos (${definition.repository?.type ?? "desconhecido"})`);
    }
    const branch = ref ?? definition.repository.defaultBranch;
    if (!branch) throw new Error(`${operation}: pipeline sem branch padrão e nenhuma ref informada`);
    const path = "/" + definition.process.yamlFilename.replace(/^\/+/, "");
    const { data } = await client(conn).json<{ content?: string; commitId?: string }>(
      `/${seg(project)}/_apis/git/repositories/${seg(definition.repository.id)}/items`,
      {
        operation,
        query: {
          path,
          "versionDescriptor.version": branchName(branch),
          "versionDescriptor.versionType": "branch",
          includeContent: "true",
          $format: "json",
        },
      },
    );
    if (typeof data.content !== "string" || !data.commitId) {
      throw new Error(`${operation}: resposta sem conteúdo do YAML`);
    }
    return { content: data.content, commitId: data.commitId, path };
  }

  return {
    kind: "azure-devops",
    contractVersion: CONNECTOR_CONTRACT_VERSION,

    capabilities: async () => AZURE_DEVOPS_CAPABILITIES,

    async testConnection(conn) {
      const api = client(conn);
      let projects: AzProject[];
      try {
        projects = (await api.json<AzList<AzProject>>("/_apis/projects", { operation: "testConnection", query: { $top: 1 } }))
          .data.value;
      } catch (error) {
        if (error instanceof AzureDevOpsHttpError) {
          return { ok: false, missingPermissions: error.status === 403 ? ["Project and Team (Read)"] : [], message: error.message };
        }
        throw error;
      }
      const first = projects[0];
      if (!first) {
        return { ok: false, missingPermissions: [], message: "a credencial não enxerga nenhum projeto nesta organização" };
      }
      try {
        await api.json(`/${seg(first.id)}/_apis/build/definitions`, { operation: "testConnection", query: { $top: 1 } });
      } catch (error) {
        if (error instanceof AzureDevOpsHttpError && error.status === 403) {
          return { ok: false, missingPermissions: ["Build (Read)"], message: error.message };
        }
        throw error;
      }
      return { ok: true, missingPermissions: [] };
    },

    // Uma página por projeto: cursor é o índice do projeto na lista.
    async listPipelines(conn, query) {
      const api = client(conn);
      const projects: AzProject[] = [];
      let continuation: string | undefined;
      do {
        const page = await api.json<AzList<AzProject>>("/_apis/projects", {
          operation: "listPipelines",
          query: { $top: 100, continuationToken: continuation },
        });
        projects.push(...page.data.value);
        continuation = page.continuation;
      } while (continuation);
      projects.sort((a, b) => a.name.localeCompare(b.name));

      const index = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isInteger(index) || index < 0) throw new Error("cursor inválido");
      const project = projects[index];
      if (!project) return { items: [] };

      const items: ExternalPipeline[] = [];
      continuation = undefined;
      do {
        const page: { data: AzList<AzDefinitionRef>; continuation?: string } = await api.json<AzList<AzDefinitionRef>>(`/${seg(project.id)}/_apis/build/definitions`, {
          operation: "listPipelines",
          query: {
            $top: 200,
            name: query.search ? `*${query.search}*` : undefined,
            queryOrder: "definitionNameAscending",
            continuationToken: continuation,
          },
        });
        for (const d of page.data.value) {
          const item: ExternalPipeline = { externalId: pipelineId(project.id, d.id), name: d.name };
          const path = d.path && d.path !== "\\" ? `${project.name}${d.path}` : project.name;
          item.path = path;
          if (d._links?.web?.href) item.url = d._links.web.href;
          items.push(item);
        }
        continuation = page.continuation;
      } while (continuation);

      return index + 1 < projects.length ? { items, nextCursor: String(index + 1) } : { items };
    },

    async getPipeline(conn, externalId) {
      const { project } = parsePipelineId(externalId);
      const d = await getDefinitionRecord(conn, externalId);
      const detail: ExternalPipelineDetail = { externalId: pipelineId(d.project?.id ?? project, d.id), name: d.name };
      if (d.path) detail.path = d.path;
      if (d._links?.web?.href) detail.url = d._links.web.href;
      if (d.repository?.defaultBranch) detail.defaultRef = d.repository.defaultBranch;
      if (d.revision !== undefined) detail.revision = String(d.revision);
      if (d.repository?.name) {
        const url = safeWebUrl(d.repository.url);
        detail.repository = url ? { name: d.repository.name, url } : { name: d.repository.name };
      }
      detail.raw = {
        processType: d.process?.type === 2 ? "yaml" : "classic",
        yamlPath: d.process?.yamlFilename,
        repositoryType: d.repository?.type,
        repositoryId: d.repository?.id,
      };
      return detail;
    },

    // O YAML pode declarar parâmetros diferentes em cada branch (S1, achado 1): passe a ref da execução.
    async getParameters(conn, externalId, ref) {
      const { content } = await readYaml(conn, externalId, ref, "getParameters");
      return parseYamlParameters(content).parameters;
    },

    async getDefinition(conn, externalId, ref): Promise<DefinitionSnapshot> {
      const { content, commitId, path } = await readYaml(conn, externalId, ref, "getDefinition");
      return { revision: commitId, format: "yaml", content, path };
    },

    // Grava o YAML (commit direto ou PR). A trava: o arquivo ainda está no commit lido, e a
    // branch ainda aponta para a ponta lida no momento da gravação (a API de pushes confere).
    async applyDefinitionChange(conn, change, mode, expectedRevision) {
      if (mode === "api") throw new NotSupportedError("applyDefinitionChange", "o Azure DevOps grava o YAML pelo repositório");
      const operation = "applyDefinitionChange";
      const { project } = parsePipelineId(change.externalPipelineId);
      const definition = await getDefinitionRecord(conn, change.externalPipelineId);
      const current = await readYaml(conn, change.externalPipelineId, change.branch, operation);
      if (current.commitId !== expectedRevision) throw new ProviderError("conflict", `${operation}: o YAML mudou desde a leitura`);
      const repo = { project, repositoryId: definition.repository!.id! };
      const branch = change.branch ?? definition.repository!.defaultBranch!;
      const api = client(conn);
      const head = await branchHead(api, repo, branch, operation);
      if (!head) throw new ProviderError("not-found", `${operation}: a branch ${branchName(branch)} não existe mais`);
      return writeFile(api, repo, operation, {
        branch,
        base: head,
        path: current.path,
        content: change.newContent,
        changeType: "edit",
        justification: change.justification,
        mode,
      });
    },

    async listRepositories(conn): Promise<ExternalRepository[]> {
      const api = client(conn);
      const { data } = await api.json<AzList<AzProject>>("/_apis/projects", { operation: "listRepositories", query: { $top: 200 } });
      const out: ExternalRepository[] = [];
      for (const project of data.value) {
        const repos = await api.json<AzList<AzRepository>>(`/${seg(project.id)}/_apis/git/repositories`, { operation: "listRepositories" });
        for (const r of repos.data.value) if (!r.isDisabled) out.push(toRepository(r, project));
        if (out.length >= 500) break;
      }
      return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    },

    // Pipeline nova: grava o YAML e, no commit direto, registra a pipeline apontando para ele.
    // Pelo PR, a pipeline só é registrada depois do merge (o arquivo ainda não está na branch).
    async createPipeline(conn, request): Promise<CreatedPipeline> {
      const operation = "createPipeline";
      const m = /^([^/]+)\/([^/]+)$/.exec(request.repositoryId);
      if (!m) throw new ProviderError("invalid", `${operation}: repositório inválido`);
      const repo = { project: m[1]!, repositoryId: m[2]! };
      const api = client(conn);
      const head = await branchHead(api, repo, request.branch, operation);
      if (!head) throw new ProviderError("invalid", `${operation}: a branch ${branchName(request.branch)} não existe no repositório`);
      const path = "/" + request.path.replace(/^\/+/, "");
      const change = await writeFile(api, repo, operation, {
        branch: request.branch,
        base: head,
        path,
        content: request.content,
        changeType: "add",
        justification: request.justification,
        mode: request.mode,
      });
      if (request.mode !== "commit") return { change };
      const { data } = await api.json<{ id: number; name: string; folder?: string; _links?: { web?: { href?: string } } }>(`/${seg(repo.project)}/_apis/pipelines`, {
        method: "POST",
        operation,
        body: { name: request.name, folder: "\\", configuration: { type: "yaml", path, repository: { id: repo.repositoryId, type: "azureReposGit" } } },
      });
      const pipeline: ExternalPipeline = { externalId: pipelineId(repo.project, data.id), name: data.name };
      if (data._links?.web?.href) pipeline.url = data._links.web.href;
      return { change, pipeline };
    },

    // Branches e tags do repositório do YAML (Azure Repos). Busca por trecho do nome.
    async listRefs(conn, externalId, query): Promise<ExternalRef[]> {
      const { project } = parsePipelineId(externalId);
      const definition = await getDefinitionRecord(conn, externalId);
      if (definition.repository?.type !== "TfsGit" || !definition.repository.id) {
        throw new NotSupportedError("listRefs", `repositório fora do Azure Repos (${definition.repository?.type ?? "desconhecido"})`);
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const search = query.search?.trim().slice(0, 100) || undefined;
      const api = client(conn);
      const read = async (filter: "heads/" | "tags/", kind: ExternalRef["kind"]) => {
        const { data } = await api.json<AzList<{ name: string }>>(
          `/${seg(project)}/_apis/git/repositories/${seg(definition.repository!.id!)}/refs`,
          { operation: "listRefs", query: { filter, filterContains: search, $top: limit } },
        );
        const prefix = `refs/${filter}`;
        return data.value
          .filter((r) => r.name.startsWith(prefix))
          .map((r): ExternalRef => ({ name: r.name.slice(prefix.length), ref: r.name, kind }));
      };
      const [branches, tags] = await Promise.all([read("heads/", "branch"), read("tags/", "tag")]);
      // Branches primeiro (são o caso comum); tags mais novas primeiro, que costumam ser versões.
      tags.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      return [...branches.sort((a, b) => a.name.localeCompare(b.name)), ...tags].slice(0, limit);
    },

    // Prévia do próprio Azure (S1): recusa parâmetro desconhecido e tipo inválido e resolve o YAML,
    // sem criar execução.
    async validateRun(conn, request) {
      const { project, definitionId } = parsePipelineId(request.externalPipelineId);
      const body: Record<string, unknown> = {
        previewRun: true,
        templateParameters: Object.fromEntries(Object.entries(request.parameters).map(([k, v]) => [k, String(v)])),
      };
      if (request.ref) body.resources = { repositories: { self: { refName: fullRef(request.ref) } } };
      const response = await client(conn).raw(`/${seg(project)}/_apis/pipelines/${definitionId}/runs`, {
        method: "POST",
        operation: "validateRun",
        body,
        acceptStatus: [400],
      });
      if (response.ok) return { ok: true, problems: [] };
      const data = (await response.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof data.message === "string" ? data.message : "o Azure DevOps recusou os parâmetros";
      // Só a primeira linha útil de cada problema, curta: a mensagem fala do YAML e dos parâmetros.
      const problems = message
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 5)
        .map((l) => l.slice(0, 300));
      return { ok: false, problems };
    },

    // O Azure DevOps não aceita chave de idempotência; quem evita disparo duplicado é a plataforma,
    // que registra a intenção antes de chamar o conector (módulo execution).
    async triggerRun(conn, request, _idempotencyKey) {
      const { project, definitionId } = parsePipelineId(request.externalPipelineId);
      const body: Record<string, unknown> = {
        templateParameters: Object.fromEntries(Object.entries(request.parameters).map(([k, v]) => [k, String(v)])),
      };
      if (request.ref) body.resources = { repositories: { self: { refName: fullRef(request.ref) } } };
      const { data } = await client(conn).json<{ id: number }>(`/${seg(project)}/_apis/pipelines/${definitionId}/runs`, {
        method: "POST",
        operation: "triggerRun",
        body,
      });
      return { externalPipelineId: request.externalPipelineId, externalRunId: String(data.id) };
    },

    async getRun(conn, run) {
      const { project, definitionId, buildId } = parseRunId(run);
      const { data } = await client(conn).json<AzBuild>(`/${seg(project)}/_apis/build/builds/${buildId}`, {
        operation: "getRun",
      });
      if (data.definition?.id !== undefined && data.definition.id !== definitionId) {
        throw new Error(`execução ${buildId} não pertence à pipeline ${run.externalPipelineId}`);
      }
      return toRunState(project, data, definitionId);
    },

    // Mais recentes primeiro, pela hora de entrada na fila; para quando passa de `since`.
    async listRuns(conn, externalId, since) {
      const { project, definitionId } = parsePipelineId(externalId);
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) throw new Error(`data inválida: ${since}`);
      const api = client(conn);
      const items: ExternalRunState[] = [];
      let continuation: string | undefined;
      do {
        const page = await api.json<AzList<AzBuild>>(`/${seg(project)}/_apis/build/builds`, {
          operation: "listRuns",
          query: { definitions: definitionId, queryOrder: "queueTimeDescending", $top: 100, continuationToken: continuation },
        });
        for (const build of page.data.value) {
          if (build.queueTime && Date.parse(build.queueTime) < sinceMs) return { items };
          items.push(toRunState(project, build, definitionId));
          if (items.length >= MAX_RUNS_PER_LIST) {
            return { items, nextCursor: build.queueTime ?? String(build.id) };
          }
        }
        continuation = page.continuation;
      } while (continuation);
      return { items };
    },

    async cancelRun(conn, run) {
      const { project, buildId } = parseRunId(run);
      await client(conn).json(`/${seg(project)}/_apis/build/builds/${buildId}`, {
        method: "PATCH",
        operation: "cancelRun",
        body: { status: "cancelling" },
      });
    },

    // Logs na ordem da timeline, cada trecho marcado com o estágio a que pertence.
    async *getLogs(conn, run, stage): AsyncIterable<LogChunk> {
      const { project, buildId } = parseRunId(run);
      const api = client(conn);
      const { data } = await api.json<{
        records?: Array<{ id: string; parentId?: string; type?: string; name?: string; order?: number; log?: { id?: number } }>;
      }>(`/${seg(project)}/_apis/build/builds/${buildId}/timeline`, { operation: "getLogs" });
      const records = data.records ?? [];
      const byId = new Map(records.map((r) => [r.id, r]));
      const stageOf = (id: string | undefined): string | undefined => {
        for (let r = id ? byId.get(id) : undefined, guard = 0; r && guard < 20; r = r.parentId ? byId.get(r.parentId) : undefined, guard++) {
          if (r.type === "Stage") return r.name;
        }
        return undefined;
      };
      const withLogs = records
        .filter((r) => r.log?.id !== undefined && r.type === "Task")
        .sort((a, b) => (a.log!.id! - b.log!.id!));
      for (const record of withLogs) {
        const recordStage = stageOf(record.id);
        if (stage !== undefined && recordStage !== stage) continue;
        const response = await api.raw(
          `/${seg(project)}/_apis/build/builds/${buildId}/logs/${record.log!.id}`,
          { operation: "getLogs" },
          "text/plain",
        );
        const chunk: LogChunk = { text: await response.text() };
        if (recordStage) chunk.stage = recordStage;
        yield chunk;
      }
    },

    async listArtifacts(conn, run): Promise<ExternalArtifact[]> {
      const { project, buildId } = parseRunId(run);
      const { data } = await client(conn).json<
        AzList<{ name: string; resource?: { properties?: { artifactsize?: string } } }>
      >(`/${seg(project)}/_apis/build/builds/${buildId}/artifacts`, { operation: "listArtifacts" });
      return data.value.map((a) => {
        const artifact: ExternalArtifact = { ref: artifactRef(project, buildId, a.name), name: a.name };
        const size = Number(a.resource?.properties?.artifactsize);
        if (Number.isFinite(size) && size >= 0) artifact.sizeBytes = size;
        return artifact;
      });
    },

    // Baixa o artefato como zip (o Azure redireciona para o armazenamento dele).
    async downloadArtifact(conn, artifact) {
      const { project, buildId, name } = parseArtifactRef(artifact.ref);
      const response = await client(conn).raw(
        `/${seg(project)}/_apis/build/builds/${buildId}/artifacts`,
        { operation: "downloadArtifact", query: { artifactName: name, $format: "zip" }, followRedirects: true },
        "application/zip",
      );
      if (!response.body) throw new Error("downloadArtifact: resposta sem conteúdo");
      return response.body;
    },
  };
}
