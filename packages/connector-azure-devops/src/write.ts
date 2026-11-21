import { ProviderError, type AppliedChange, type ExternalRepository } from "@painel/connector-sdk";
import { seg, type AzureDevOpsClient } from "./http.ts";

// Gravação no Azure Repos (incremento 4): commit direto com trava otimista, ou branch nova + PR.
// Usa a API de pushes: a gravação só acontece se a branch ainda aponta para o commit lido.

const ZERO = "0000000000000000000000000000000000000000";

export const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");
export const fullRef = (ref: string) => (ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);

/** Primeira linha da justificativa, como título do PR. */
const titleOf = (text: string) => (text.split("\n")[0] ?? "").trim().slice(0, 200) || "Alteração pelo Nexo";

/** Nome de branch para o PR: legível e único. */
export function changeBranchName(prefix: "alteracao" | "nova-pipeline"): string {
  return `nexo/${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  // Só a primeira linha e curta: a mensagem do Azure diz o motivo (arquivo já existe, branch protegida...).
  return typeof body.message === "string" ? body.message.split("\n")[0]!.slice(0, 240) : `Azure DevOps respondeu ${response.status}`;
}

export interface RepoRef {
  project: string;
  repositoryId: string;
}

export async function branchHead(api: AzureDevOpsClient, repo: RepoRef, branch: string, operation: string): Promise<string | undefined> {
  const { data } = await api.json<{ value: Array<{ name: string; objectId: string }> }>(
    `/${seg(repo.project)}/_apis/git/repositories/${seg(repo.repositoryId)}/refs`,
    { operation, query: { filter: `heads/${branchName(branch)}` } },
  );
  return data.value.find((r) => r.name === fullRef(branch))?.objectId;
}

export async function repositoryWebUrl(api: AzureDevOpsClient, repo: RepoRef, operation: string): Promise<string | undefined> {
  const { data } = await api.json<{ webUrl?: string }>(`/${seg(repo.project)}/_apis/git/repositories/${seg(repo.repositoryId)}`, { operation });
  return data.webUrl;
}

/** Um commit com um arquivo. `base` é o commit de onde a branch parte (trava otimista). */
export async function pushFile(
  api: AzureDevOpsClient,
  repo: RepoRef,
  operation: string,
  change: { branch: string; base: string; path: string; content: string; changeType: "add" | "edit"; message: string },
): Promise<string> {
  const response = await api.raw(`/${seg(repo.project)}/_apis/git/repositories/${seg(repo.repositoryId)}/pushes`, {
    method: "POST",
    operation,
    acceptStatus: [400, 409],
    body: {
      refUpdates: [{ name: fullRef(change.branch), oldObjectId: change.base || ZERO }],
      commits: [
        {
          comment: change.message.slice(0, 2000),
          changes: [{ changeType: change.changeType, item: { path: change.path }, newContent: { content: change.content, contentType: "rawtext" } }],
        },
      ],
    },
  });
  if (response.status === 409) throw new ProviderError("conflict", `${operation}: a branch mudou no Azure DevOps desde a leitura`);
  if (response.status === 400) throw new ProviderError("invalid", `${operation}: o Azure DevOps recusou a gravação: ${await errorMessage(response)}`);
  const data = (await response.json()) as { commits?: Array<{ commitId?: string }> };
  const commit = data.commits?.[0]?.commitId;
  if (!commit) throw new Error(`${operation}: resposta sem o commit gravado`);
  return commit;
}

export async function openPullRequest(
  api: AzureDevOpsClient,
  repo: RepoRef,
  operation: string,
  pr: { source: string; target: string; justification: string },
): Promise<{ id: number; url?: string }> {
  const response = await api.raw(`/${seg(repo.project)}/_apis/git/repositories/${seg(repo.repositoryId)}/pullrequests`, {
    method: "POST",
    operation,
    acceptStatus: [400, 409],
    body: { sourceRefName: fullRef(pr.source), targetRefName: fullRef(pr.target), title: titleOf(pr.justification), description: pr.justification.slice(0, 4000) },
  });
  if (!response.ok) throw new ProviderError("invalid", `${operation}: o Azure DevOps não abriu o PR: ${await errorMessage(response)}`);
  const data = (await response.json()) as { pullRequestId: number };
  const web = await repositoryWebUrl(api, repo, operation).catch(() => undefined);
  return web ? { id: data.pullRequestId, url: `${web}/pullrequest/${data.pullRequestId}` } : { id: data.pullRequestId };
}

/** Grava o arquivo: commit direto na branch, ou numa branch nova com PR para ela. */
export async function writeFile(
  api: AzureDevOpsClient,
  repo: RepoRef,
  operation: string,
  input: { branch: string; base: string; path: string; content: string; changeType: "add" | "edit"; justification: string; mode: "commit" | "pull-request" },
): Promise<AppliedChange> {
  const target = branchName(input.branch);
  if (input.mode === "commit") {
    const commit = await pushFile(api, repo, operation, { ...input, branch: target, message: input.justification });
    const web = await repositoryWebUrl(api, repo, operation).catch(() => undefined);
    return { mode: "commit", externalRevision: commit, branch: target, ...(web ? { url: `${web}/commit/${commit}` } : {}) };
  }
  const source = changeBranchName(input.changeType === "add" ? "nova-pipeline" : "alteracao");
  const commit = await pushFile(api, repo, operation, { ...input, branch: source, message: input.justification });
  const pr = await openPullRequest(api, repo, operation, { source, target, justification: input.justification });
  return { mode: "pull-request", externalRevision: commit, branch: source, ...(pr.url ? { url: pr.url } : {}) };
}

export interface AzRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  isDisabled?: boolean;
  project?: { id: string; name: string };
}

export function toRepository(r: AzRepository, project: { id: string; name: string }): ExternalRepository {
  const out: ExternalRepository = { id: `${project.id}/${r.id}`, name: r.name, scope: project.name };
  if (r.defaultBranch) out.defaultBranch = branchName(r.defaultBranch);
  if (r.webUrl) out.url = r.webUrl;
  return out;
}
