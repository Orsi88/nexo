import { describe, expect, it } from "vitest";
import { ProviderError, type ConnectionContext } from "@painel/connector-sdk";
import { createAzureDevOpsConnector } from "../src/index.ts";

// Gravação do YAML (incremento 4) contra respostas simuladas no formato da API do Azure DevOps.

const conn: ConnectionContext = {
  organizationId: "org-teste",
  integrationId: "int-teste",
  endpoint: "https://dev.azure.com/exemplo/",
  credential: { kind: "pat", value: "pat-de-teste" },
  correlationId: "corr-teste",
};

interface Call {
  method: string;
  url: URL;
  body?: unknown;
}
type Route = (call: Call) => Response | undefined;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function fakeAzure(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: new URL(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const route of routes) {
      const r = route(call);
      if (r) return r;
    }
    return json({ message: "rota não simulada" }, 404);
  };
  return { connector: createAzureDevOpsConnector({ fetch: fetchImpl }), calls };
}

const REPO = "/exemplo/proj-1/_apis/git/repositories/repo-1";
const definition: Route = ({ url }) =>
  url.pathname === "/exemplo/proj-1/_apis/build/definitions/381"
    ? json({
        id: 381,
        name: "testes-e2e",
        process: { type: 2, yamlFilename: "pipelines/testes.yml" },
        repository: { id: "repo-1", type: "TfsGit", defaultBranch: "refs/heads/main" },
      })
    : undefined;
const items =
  (commitId: string): Route =>
  ({ url }) =>
    url.pathname === `${REPO}/items` ? json({ content: "trigger: none\n", commitId }) : undefined;
const refs: Route = ({ url }) => (url.pathname === `${REPO}/refs` ? json({ value: [{ name: "refs/heads/main", objectId: "head-main" }] }) : undefined);
const repo: Route = ({ url, method }) => (url.pathname === REPO && method === "GET" ? json({ webUrl: "https://dev.azure.com/exemplo/proj-1/_git/testes" }) : undefined);
const pushOk: Route = ({ url, method }) => (url.pathname === `${REPO}/pushes` && method === "POST" ? json({ commits: [{ commitId: "novo-commit" }] }, 201) : undefined);

describe("Azure DevOps: gravar o YAML", () => {
  it("commit direto parte da ponta atual da branch e edita o arquivo da pipeline", async () => {
    const { connector, calls } = fakeAzure([definition, items("rev-1"), refs, repo, pushOk]);
    const change = await connector.applyDefinitionChange!(
      conn,
      { externalPipelineId: "proj-1/381", newContent: "trigger: none\npool: x\n", justification: "Ajusta o pool" },
      "commit",
      "rev-1",
    );
    expect(change).toEqual({ mode: "commit", externalRevision: "novo-commit", branch: "main", url: "https://dev.azure.com/exemplo/proj-1/_git/testes/commit/novo-commit" });
    const push = calls.find((c) => c.url.pathname.endsWith("/pushes"))!;
    expect(push.body).toEqual({
      refUpdates: [{ name: "refs/heads/main", oldObjectId: "head-main" }],
      commits: [
        {
          comment: "Ajusta o pool",
          changes: [{ changeType: "edit", item: { path: "/pipelines/testes.yml" }, newContent: { content: "trigger: none\npool: x\n", contentType: "rawtext" } }],
        },
      ],
    });
  });

  it("recusa se o arquivo mudou desde a leitura, sem gravar nada (trava otimista)", async () => {
    const { connector, calls } = fakeAzure([definition, items("rev-2"), refs, pushOk]);
    const error = await connector
      .applyDefinitionChange!(conn, { externalPipelineId: "proj-1/381", newContent: "x: 1\n", justification: "m" }, "commit", "rev-1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("conflict");
    expect(calls.some((c) => c.url.pathname.endsWith("/pushes"))).toBe(false);
  });

  it("a branch andou entre a leitura e a gravação: o Azure responde 409 e vira conflito", async () => {
    const { connector } = fakeAzure([definition, items("rev-1"), refs, ({ url }) => (url.pathname.endsWith("/pushes") ? json({ message: "TF401028" }, 409) : undefined)]);
    await expect(
      connector.applyDefinitionChange!(conn, { externalPipelineId: "proj-1/381", newContent: "x: 1\n", justification: "m" }, "commit", "rev-1"),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("pelo PR: cria uma branch nova a partir da ponta e abre o PR para a branch da pipeline", async () => {
    const { connector, calls } = fakeAzure([
      definition,
      items("rev-1"),
      refs,
      repo,
      pushOk,
      ({ url, method }) => (url.pathname === `${REPO}/pullrequests` && method === "POST" ? json({ pullRequestId: 42 }, 201) : undefined),
    ]);
    const change = await connector.applyDefinitionChange!(
      conn,
      { externalPipelineId: "proj-1/381", newContent: "x: 1\n", justification: "Troca o agente\n\nDetalhes" },
      "pull-request",
      "rev-1",
    );
    expect(change.mode).toBe("pull-request");
    expect(change.url).toBe("https://dev.azure.com/exemplo/proj-1/_git/testes/pullrequest/42");
    expect(change.branch).toMatch(/^nexo\/alteracao-\d{8}-[a-z0-9]+$/);
    const push = calls.find((c) => c.url.pathname.endsWith("/pushes"))!.body as { refUpdates: Array<{ name: string; oldObjectId: string }> };
    expect(push.refUpdates[0]).toEqual({ name: `refs/heads/${change.branch}`, oldObjectId: "head-main" });
    const pr = calls.find((c) => c.url.pathname.endsWith("/pullrequests"))!.body;
    expect(pr).toEqual({ sourceRefName: `refs/heads/${change.branch}`, targetRefName: "refs/heads/main", title: "Troca o agente", description: "Troca o agente\n\nDetalhes" });
  });

  it("cria pipeline nova: adiciona o arquivo e registra a pipeline apontando para ele", async () => {
    const { connector, calls } = fakeAzure([
      refs,
      repo,
      pushOk,
      ({ url, method }) =>
        url.pathname === "/exemplo/proj-1/_apis/pipelines" && method === "POST"
          ? json({ id: 500, name: "Testes novos", _links: { web: { href: "https://dev.azure.com/exemplo/proj-1/_build/definition?definitionId=500" } } })
          : undefined,
    ]);
    const created = await connector.createPipeline!(conn, {
      repositoryId: "proj-1/repo-1",
      branch: "main",
      path: "pipelines/novos.yml",
      content: "trigger: none\n",
      name: "Testes novos",
      justification: "Cria pela plataforma",
      mode: "commit",
    });
    expect(created.pipeline).toEqual({ externalId: "proj-1/500", name: "Testes novos", url: "https://dev.azure.com/exemplo/proj-1/_build/definition?definitionId=500" });
    const push = calls.find((c) => c.url.pathname.endsWith("/pushes"))!.body as { commits: Array<{ changes: Array<{ changeType: string; item: { path: string } }> }> };
    expect(push.commits[0]!.changes[0]).toMatchObject({ changeType: "add", item: { path: "/pipelines/novos.yml" } });
    const create = calls.find((c) => c.url.pathname.endsWith("/_apis/pipelines"))!.body;
    expect(create).toEqual({ name: "Testes novos", folder: "\\", configuration: { type: "yaml", path: "/pipelines/novos.yml", repository: { id: "repo-1", type: "azureReposGit" } } });
  });

  it("arquivo que já existe vira erro claro, com o motivo do Azure", async () => {
    const { connector } = fakeAzure([refs, ({ url }) => (url.pathname.endsWith("/pushes") ? json({ message: "TF402455: o item já existe" }, 400) : undefined)]);
    await expect(
      connector.createPipeline!(conn, { repositoryId: "proj-1/repo-1", branch: "main", path: "a.yml", content: "x: 1\n", name: "a", justification: "m", mode: "commit" }),
    ).rejects.toThrow(/já existe/);
  });
});
