import { ProviderError, type AppliedChange } from "@painel/connector-sdk";
import { readErrorMessage, type GitHubClient } from "./http.ts";

// Gravação no repositório do GitHub (incremento 4). A API de conteúdo já tem trava otimista: a
// gravação de um arquivo existente exige o `sha` lido, e o GitHub recusa (409) se ele mudou.

const seg = (v: string) => encodeURIComponent(v);
const filePath = (path: string) => path.replace(/^\/+/, "").split("/").map(seg).join("/");
const titleOf = (text: string) => (text.split("\n")[0] ?? "").trim().slice(0, 200) || "Alteração pelo Nexo";

export function changeBranchName(prefix: "alteracao" | "nova-pipeline"): string {
  return `nexo/${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function defaultBranch(api: GitHubClient, owner: string, repo: string, operation: string): Promise<string> {
  return (await api.json<{ default_branch: string }>(`/repos/${seg(owner)}/${seg(repo)}`, { operation })).data.default_branch;
}

async function branchHead(api: GitHubClient, owner: string, repo: string, branch: string, operation: string): Promise<string> {
  const response = await api.raw(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${branch.split("/").map(seg).join("/")}`, { operation, acceptStatus: [404] });
  if (response.status === 404) throw new ProviderError("invalid", `${operation}: a branch ${branch} não existe no repositório`);
  return ((await response.json()) as { object: { sha: string } }).object.sha;
}

async function putFile(
  api: GitHubClient,
  owner: string,
  repo: string,
  operation: string,
  f: { path: string; content: string; message: string; branch: string; sha?: string },
): Promise<{ commit: string; url?: string }> {
  const response = await api.raw(`/repos/${seg(owner)}/${seg(repo)}/contents/${filePath(f.path)}`, {
    method: "PUT",
    operation,
    acceptStatus: [409, 422],
    body: { message: f.message.slice(0, 2000), content: Buffer.from(f.content, "utf8").toString("base64"), branch: f.branch, ...(f.sha ? { sha: f.sha } : {}) },
  });
  if (response.status === 409) throw new ProviderError("conflict", `${operation}: o arquivo mudou no GitHub desde a leitura`);
  if (response.status === 422) {
    const message = await readErrorMessage(response);
    // Sem sha e o arquivo já existe: o GitHub responde 422 pedindo o sha.
    throw new ProviderError("invalid", `${operation}: ${f.sha ? "o GitHub recusou a gravação" : "já existe um arquivo nesse caminho, ou o GitHub recusou a gravação"}: ${message}`);
  }
  const data = (await response.json()) as { commit: { sha: string; html_url?: string } };
  return data.commit.html_url ? { commit: data.commit.sha, url: data.commit.html_url } : { commit: data.commit.sha };
}

/** Grava o arquivo: commit direto na branch, ou numa branch nova com PR para ela. */
export async function writeFile(
  api: GitHubClient,
  owner: string,
  repo: string,
  operation: string,
  input: { branch: string; path: string; content: string; sha?: string; justification: string; mode: "commit" | "pull-request" },
): Promise<AppliedChange> {
  const file = { path: input.path, content: input.content, message: input.justification, ...(input.sha ? { sha: input.sha } : {}) };
  if (input.mode === "commit") {
    const done = await putFile(api, owner, repo, operation, { ...file, branch: input.branch });
    return { mode: "commit", externalRevision: done.commit, branch: input.branch, ...(done.url ? { url: done.url } : {}) };
  }
  const source = changeBranchName(input.sha ? "alteracao" : "nova-pipeline");
  const base = await branchHead(api, owner, repo, input.branch, operation);
  await api.json(`/repos/${seg(owner)}/${seg(repo)}/git/refs`, { method: "POST", operation, body: { ref: `refs/heads/${source}`, sha: base } });
  const done = await putFile(api, owner, repo, operation, { ...file, branch: source });
  const response = await api.raw(`/repos/${seg(owner)}/${seg(repo)}/pulls`, {
    method: "POST",
    operation,
    acceptStatus: [422],
    body: { title: titleOf(input.justification), head: source, base: input.branch, body: input.justification.slice(0, 4000) },
  });
  if (response.status === 422) throw new ProviderError("invalid", `${operation}: o GitHub não abriu o PR: ${await readErrorMessage(response)}`);
  const pr = (await response.json()) as { html_url: string };
  return { mode: "pull-request", externalRevision: done.commit, branch: source, url: pr.html_url };
}
