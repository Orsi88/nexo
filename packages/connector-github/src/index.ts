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
import { GitHubClient, GitHubHttpError, readErrorMessage, seg, type FetchLike } from "./http.ts";
import { parseWorkflowInputs } from "./inputs.ts";
import { defaultBranch, writeFile } from "./write.ts";

export { GitHubHttpError, parseEndpoint } from "./http.ts";
export { parseWorkflowInputs, WorkflowParseError } from "./inputs.ts";

// Conector GitHub Actions. Cada capacidade "true" foi confirmada com chamadas reais no spike S4
// (docs/spikes/S4-github-actions.md): o disparo com return_run_details devolve o id da execução,
// cancelamento, jobs, logs e artefatos. Ainda não: agendamentos e edição do workflow.
//
// Identificadores:
//   pipeline  = "<dono>/<repositório>/<id do workflow>"  (o id não muda se o arquivo for renomeado)
//   execução  = id da execução (workflow run)
//   artefato  = "<dono>/<repositório>/<id do artefato>"

export const GITHUB_CAPABILITIES: ConnectorCapabilities = {
  read: { pipelines: true, parameters: true, runs: true, logs: true, artifacts: true, schedules: false, definition: true },
  write: { triggerRun: true, cancelRun: true, definitionViaApi: false, definitionViaCommit: true, definitionViaPullRequest: true },
  events: { webhooks: false },
};

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})";
const PIPELINE_ID = new RegExp(`^(${NAME})/(${NAME})/(\\d{1,12})$`);
const ARTIFACT_REF = new RegExp(`^(${NAME})/(${NAME})/(\\d{1,15})$`);
const MAX_RUNS_PER_LIST = 500;

function parsePipelineId(externalId: string): { owner: string; repo: string; workflowId: number } {
  const m = PIPELINE_ID.exec(externalId);
  if (!m || m[2] === "." || m[2] === "..") throw new Error(`id de workflow GitHub inválido: ${externalId}`);
  return { owner: m[1]!, repo: m[2]!, workflowId: Number(m[3]) };
}

function parseRunId(run: ExternalRunRef): { owner: string; repo: string; workflowId: number; runId: number } {
  const p = parsePipelineId(run.externalPipelineId);
  if (!/^\d{1,15}$/.test(run.externalRunId)) throw new Error(`id de execução GitHub inválido: ${run.externalRunId}`);
  return { ...p, runId: Number(run.externalRunId) };
}

/** Branch curta ("main") a partir de "main" ou "refs/heads/main"; tags vão como estão. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

// Códigos de cor do terminal nos logs do GitHub: removidos antes de mostrar.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

interface GhRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  default_branch: string;
  archived?: boolean;
}
interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
}
interface GhRun {
  id: number;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  display_title?: string;
}

/** Estado do GitHub (status + conclusion) para o vocabulário da plataforma. */
export function translateRunStatus(status: string | null, conclusion: string | null): { status: ExternalRunState["status"]; externalStatus: string } {
  const externalStatus = conclusion ? `${status}/${conclusion}` : (status ?? "desconhecido");
  if (status !== "completed") {
    if (status === "in_progress") return { status: "running", externalStatus };
    // queued, waiting, requested, pending: ainda esperando máquina ou aprovação.
    if (status && ["queued", "waiting", "requested", "pending"].includes(status)) return { status: "queued", externalStatus };
    return { status: "unknown", externalStatus };
  }
  switch (conclusion) {
    case "success":
      return { status: "succeeded", externalStatus };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { status: "failed", externalStatus };
    case "cancelled":
      return { status: "cancelled", externalStatus };
    default:
      // skipped, neutral, stale, action_required: terminou sem dizer se passou.
      return { status: "unknown", externalStatus };
  }
}

function toRunState(externalPipelineId: string, run: GhRun): ExternalRunState {
  const { status, externalStatus } = translateRunStatus(run.status, run.conclusion);
  const state: ExternalRunState = {
    externalPipelineId,
    externalRunId: String(run.id),
    externalStatus,
    status,
    queuedAt: run.created_at,
    sourceRevision: run.head_sha,
    runNumber: String(run.run_number),
    // Disparo manual (pela aba Actions ou pelo Nexo) é workflow_dispatch; push, PR e agenda vêm de fora.
    startedOutsidePlatform: run.event !== "workflow_dispatch",
  };
  if (run.run_started_at) state.startedAt = run.run_started_at;
  if (run.status === "completed") state.finishedAt = run.updated_at;
  if (run.head_branch) state.ref = `refs/heads/${run.head_branch}`;
  return state;
}

export interface GitHubConnectorOptions {
  /** Injetável nos testes; em produção, o fetch global. */
  fetch?: FetchLike;
  /** Hosts de GitHub Enterprise Server aceitos além de github.com. */
  extraHosts?: readonly string[];
}

export function createGitHubConnector(options: GitHubConnectorOptions = {}): PipelineConnector {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const client = (conn: ConnectionContext) => new GitHubClient(conn, fetchImpl, options.extraHosts);

  /** Repositórios do dono da integração que a credencial enxerga, em ordem alfabética. */
  async function accessibleRepos(api: GitHubClient, operation: string): Promise<GhRepo[]> {
    const repos: GhRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data, next } = await api.json<GhRepo[]>("/user/repos", { operation, query: { per_page: 100, page, sort: "full_name" } });
      repos.push(...data.filter((r) => r.owner.login.toLowerCase() === api.owner.toLowerCase() && !r.archived));
      if (!next) break;
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function workflow(api: GitHubClient, owner: string, repo: string, workflowId: number, operation: string) {
    return (await api.json<GhWorkflow>(`/repos/${seg(owner)}/${seg(repo)}/actions/workflows/${workflowId}`, { operation })).data;
  }

  async function fileAt(api: GitHubClient, owner: string, repo: string, path: string, ref: string | undefined, operation: string) {
    const { data } = await api.json<{ content?: string; encoding?: string; sha: string }>(`/repos/${seg(owner)}/${seg(repo)}/contents/${path.split("/").map(seg).join("/")}`, {
      operation,
      query: { ref: ref ? shortRef(ref) : undefined },
    });
    if (data.encoding !== "base64" || typeof data.content !== "string") throw new Error(`${operation}: conteúdo do workflow indisponível`);
    return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
  }

  return {
    kind: "github",
    contractVersion: CONNECTOR_CONTRACT_VERSION,

    capabilities: async () => GITHUB_CAPABILITIES,

    async testConnection(conn) {
      const api = client(conn);
      let repos: GhRepo[];
      try {
        repos = await accessibleRepos(api, "testConnection");
      } catch (error) {
        if (error instanceof GitHubHttpError) return { ok: false, missingPermissions: [], message: error.message };
        throw error;
      }
      const first = repos[0];
      if (!first) {
        return {
          ok: false,
          missingPermissions: ["Repository access"],
          message: `a credencial não enxerga nenhum repositório de ${api.owner}`,
        };
      }
      try {
        await api.json(`/repos/${seg(first.owner.login)}/${seg(first.name)}/actions/workflows`, { operation: "testConnection", query: { per_page: 1 } });
      } catch (error) {
        if (error instanceof GitHubHttpError && (error.status === 403 || error.status === 404)) {
          return { ok: false, missingPermissions: ["Actions (Read)"], message: error.message };
        }
        throw error;
      }
      return { ok: true, identity: `${repos.length} repositório(s) de ${api.owner}`, missingPermissions: [] };
    },

    // Uma página por repositório: cursor é o índice do repositório na lista (como os projetos no Azure).
    async listPipelines(conn, query) {
      const api = client(conn);
      const repos = await accessibleRepos(api, "listPipelines");
      const index = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isInteger(index) || index < 0) throw new Error("cursor inválido");
      const repo = repos[index];
      if (!repo) return { items: [] };
      const { data } = await api.json<{ workflows: GhWorkflow[] }>(`/repos/${seg(repo.owner.login)}/${seg(repo.name)}/actions/workflows`, {
        operation: "listPipelines",
        query: { per_page: 100 },
      });
      const search = query.search?.trim().toLowerCase();
      const items: ExternalPipeline[] = data.workflows
        .filter((w) => w.state === "active")
        .filter((w) => !search || `${repo.name} ${w.name} ${w.path}`.toLowerCase().includes(search))
        .map((w) => ({ externalId: `${repo.owner.login}/${repo.name}/${w.id}`, name: w.name, path: repo.name, url: w.html_url }));
      return index + 1 < repos.length ? { items, nextCursor: String(index + 1) } : { items };
    },

    async getPipeline(conn, externalId) {
      const { owner, repo, workflowId } = parsePipelineId(externalId);
      const api = client(conn);
      const [wf, r] = await Promise.all([
        workflow(api, owner, repo, workflowId, "getPipeline"),
        api.json<GhRepo>(`/repos/${seg(owner)}/${seg(repo)}`, { operation: "getPipeline" }).then((x) => x.data),
      ]);
      const detail: ExternalPipelineDetail = {
        externalId,
        name: wf.name,
        path: repo,
        url: wf.html_url,
        defaultRef: `refs/heads/${r.default_branch}`,
        repository: { name: r.name, url: r.html_url },
        raw: { workflowPath: wf.path, state: wf.state },
      };
      return detail;
    },

    // As entradas podem mudar de branch para branch: lê o arquivo do workflow na ref pedida.
    async getParameters(conn, externalId, ref) {
      const { owner, repo, workflowId } = parsePipelineId(externalId);
      const api = client(conn);
      const wf = await workflow(api, owner, repo, workflowId, "getParameters");
      const { content } = await fileAt(api, owner, repo, wf.path, ref, "getParameters");
      return parseWorkflowInputs(content).inputs;
    },

    async getDefinition(conn, externalId, ref): Promise<DefinitionSnapshot> {
      const { owner, repo, workflowId } = parsePipelineId(externalId);
      const api = client(conn);
      const wf = await workflow(api, owner, repo, workflowId, "getDefinition");
      const { content, sha } = await fileAt(api, owner, repo, wf.path, ref, "getDefinition");
      return { revision: sha, format: "yaml", content, path: wf.path };
    },

    // Grava o workflow. A trava é o sha do arquivo lido: o GitHub recusa se ele mudou.
    async applyDefinitionChange(conn, change, mode, expectedRevision) {
      if (mode === "api") throw new NotSupportedError("applyDefinitionChange", "o GitHub grava o workflow pelo repositório");
      const operation = "applyDefinitionChange";
      const { owner, repo, workflowId } = parsePipelineId(change.externalPipelineId);
      const api = client(conn);
      const wf = await workflow(api, owner, repo, workflowId, operation);
      const branch = change.branch ? shortRef(change.branch) : await defaultBranch(api, owner, repo, operation);
      return writeFile(api, owner, repo, operation, { branch, path: wf.path, content: change.newContent, sha: expectedRevision, justification: change.justification, mode });
    },

    async listRepositories(conn): Promise<ExternalRepository[]> {
      const api = client(conn);
      return (await accessibleRepos(api, "listRepositories")).map((r) => ({
        id: `${r.owner.login}/${r.name}`,
        name: r.name,
        scope: r.owner.login,
        defaultBranch: r.default_branch,
        url: r.html_url,
      }));
    },

    // Workflow novo em .github/workflows. No commit direto o GitHub já o lista; pelo PR, só depois do merge.
    async createPipeline(conn, request): Promise<CreatedPipeline> {
      const operation = "createPipeline";
      const m = new RegExp(`^(${NAME})/(${NAME})$`).exec(request.repositoryId);
      if (!m) throw new ProviderError("invalid", `${operation}: repositório inválido`);
      const [owner, repo] = [m[1]!, m[2]!];
      const path = request.path.replace(/^\/+/, "");
      if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(path)) {
        throw new ProviderError("invalid", `${operation}: no GitHub o arquivo precisa ficar em .github/workflows/ e terminar em .yml`);
      }
      const api = client(conn);
      const change = await writeFile(api, owner, repo, operation, { branch: shortRef(request.branch), path, content: request.content, justification: request.justification, mode: request.mode });
      if (request.mode !== "commit") return { change };
      const { data } = await api.json<{ workflows: GhWorkflow[] }>(`/repos/${seg(owner)}/${seg(repo)}/actions/workflows`, { operation, query: { per_page: 100 } });
      const wf = data.workflows.find((w) => w.path === path);
      return wf ? { change, pipeline: { externalId: `${owner}/${repo}/${wf.id}`, name: wf.name, path: repo, url: wf.html_url } } : { change };
    },

    async listRefs(conn, externalId, query): Promise<ExternalRef[]> {
      const { owner, repo } = parsePipelineId(externalId);
      const api = client(conn);
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const search = query.search?.trim().toLowerCase();
      const [branches, tags] = await Promise.all([
        api.json<Array<{ name: string }>>(`/repos/${seg(owner)}/${seg(repo)}/branches`, { operation: "listRefs", query: { per_page: 100 } }),
        api.json<Array<{ name: string }>>(`/repos/${seg(owner)}/${seg(repo)}/tags`, { operation: "listRefs", query: { per_page: 100 } }),
      ]);
      const match = (n: string) => !search || n.toLowerCase().includes(search);
      const b = branches.data.filter((x) => match(x.name)).map((x): ExternalRef => ({ name: x.name, ref: `refs/heads/${x.name}`, kind: "branch" }));
      const t = tags.data.filter((x) => match(x.name)).map((x): ExternalRef => ({ name: x.name, ref: `refs/tags/${x.name}`, kind: "tag" }));
      b.sort((x, y) => x.name.localeCompare(y.name));
      t.sort((x, y) => y.name.localeCompare(x.name, undefined, { numeric: true }));
      return [...b, ...t].slice(0, limit);
    },

    // Confirmado no S4: com return_run_details o GitHub responde 200 com workflow_run_id.
    async triggerRun(conn, request, _idempotencyKey) {
      const { owner, repo, workflowId } = parsePipelineId(request.externalPipelineId);
      const api = client(conn);
      const wf = await workflow(api, owner, repo, workflowId, "triggerRun");
      const ref = request.ref ? shortRef(request.ref) : (await api.json<GhRepo>(`/repos/${seg(owner)}/${seg(repo)}`, { operation: "triggerRun" })).data.default_branch;
      const response = await api.raw(`/repos/${seg(owner)}/${seg(repo)}/actions/workflows/${workflowId}/dispatches`, {
        method: "POST",
        operation: "triggerRun",
        body: {
          ref,
          inputs: Object.fromEntries(Object.entries(request.parameters).map(([k, v]) => [k, String(v)])),
          return_run_details: true,
        },
        acceptStatus: [422],
      });
      if (response.status === 422) {
        // Entrada recusada ou workflow sem workflow_dispatch nessa ref: a mensagem do GitHub diz qual.
        throw new ProviderError("invalid", `o GitHub recusou o disparo de "${wf.name}": ${await readErrorMessage(response)}`);
      }
      const body = response.status === 204 ? {} : ((await response.json().catch(() => ({}))) as { workflow_run_id?: number });
      if (!body.workflow_run_id) {
        // GitHub Enterprise antigo responde 204 sem o id: não dá para saber qual execução é a nossa.
        throw new NotSupportedError("triggerRun", "este GitHub não devolve o id da execução disparada (return_run_details)");
      }
      return { externalPipelineId: request.externalPipelineId, externalRunId: String(body.workflow_run_id) };
    },

    async getRun(conn, run) {
      const { owner, repo, workflowId, runId } = parseRunId(run);
      const { data } = await client(conn).json<GhRun>(`/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}`, { operation: "getRun" });
      if (data.workflow_id !== workflowId) throw new Error(`execução ${runId} não pertence ao workflow ${run.externalPipelineId}`);
      return toRunState(run.externalPipelineId, data);
    },

    // Mais recentes primeiro; para quando passa de `since`.
    async listRuns(conn, externalId, since) {
      const { owner, repo, workflowId } = parsePipelineId(externalId);
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) throw new Error(`data inválida: ${since}`);
      const api = client(conn);
      const items: ExternalRunState[] = [];
      for (let page = 1; page <= 5; page++) {
        const { data, next } = await api.json<{ workflow_runs: GhRun[] }>(`/repos/${seg(owner)}/${seg(repo)}/actions/workflows/${workflowId}/runs`, {
          operation: "listRuns",
          query: { per_page: 100, page, created: `>=${new Date(sinceMs).toISOString()}` },
        });
        for (const r of data.workflow_runs) {
          if (Date.parse(r.created_at) < sinceMs) return { items };
          items.push(toRunState(externalId, r));
          if (items.length >= MAX_RUNS_PER_LIST) return { items, nextCursor: r.created_at };
        }
        if (!next) break;
      }
      return { items };
    },

    async cancelRun(conn, run) {
      const { owner, repo, runId } = parseRunId(run);
      const response = await client(conn).raw(`/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}/cancel`, {
        method: "POST",
        operation: "cancelRun",
        acceptStatus: [409],
      });
      // 409: a execução já terminou; não há o que cancelar (o acompanhamento traz o estado final).
      if (response.status === 409) throw new ProviderError("invalid", "a execução já terminou no GitHub");
    },

    // Um trecho por job, na ordem do GitHub, marcado com o nome do job.
    async *getLogs(conn, run, stage): AsyncIterable<LogChunk> {
      const { owner, repo, runId } = parseRunId(run);
      const api = client(conn);
      const { data } = await api.json<{ jobs: Array<{ id: number; name: string }> }>(`/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}/jobs`, {
        operation: "getLogs",
        query: { per_page: 100 },
      });
      for (const job of data.jobs) {
        if (stage !== undefined && job.name !== stage) continue;
        let text: string;
        try {
          const response = await api.raw(`/repos/${seg(owner)}/${seg(repo)}/actions/jobs/${job.id}/logs`, { operation: "getLogs", followRedirects: true }, "*/*");
          text = (await response.text()).replace(ANSI, "");
        } catch (error) {
          // Job que ainda não começou (ou cujo log expirou) não tem log: segue para o próximo.
          if (error instanceof GitHubHttpError && error.status === 404) continue;
          throw error;
        }
        yield { stage: job.name, text };
      }
    },

    async listArtifacts(conn, run): Promise<ExternalArtifact[]> {
      const { owner, repo, runId } = parseRunId(run);
      const { data } = await client(conn).json<{ artifacts: Array<{ id: number; name: string; size_in_bytes?: number; expired?: boolean }> }>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}/artifacts`,
        { operation: "listArtifacts", query: { per_page: 100 } },
      );
      return data.artifacts
        .filter((a) => !a.expired)
        .map((a) => {
          const out: ExternalArtifact = { ref: `${owner}/${repo}/${a.id}`, name: a.name };
          if (typeof a.size_in_bytes === "number" && a.size_in_bytes >= 0) out.sizeBytes = a.size_in_bytes;
          return out;
        });
    },

    // Baixa o artefato como zip (o GitHub redireciona para o armazenamento dele).
    async downloadArtifact(conn, artifact) {
      const m = ARTIFACT_REF.exec(artifact.ref);
      if (!m) throw new Error(`artefato GitHub inválido: ${artifact.ref}`);
      const response = await client(conn).raw(`/repos/${seg(m[1]!)}/${seg(m[2]!)}/actions/artifacts/${m[3]}/zip`, { operation: "downloadArtifact", followRedirects: true }, "*/*");
      if (!response.body) throw new Error("downloadArtifact: resposta sem conteúdo");
      return response.body;
    },
  };
}
