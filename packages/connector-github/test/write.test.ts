import { describe, expect, it } from "vitest";
import { ProviderError, type ConnectionContext } from "@painel/connector-sdk";
import { createGitHubConnector } from "../src/index.ts";

// Gravação do workflow (incremento 4) contra respostas simuladas no formato da API do GitHub.

const conn: ConnectionContext = {
  organizationId: "org-teste",
  integrationId: "int-teste",
  endpoint: "https://github.com/exemplo",
  credential: { kind: "pat", value: "github_pat_teste" },
  correlationId: "corr-teste",
};

interface Call {
  method: string;
  url: URL;
  body?: unknown;
}
type Route = (call: Call) => Response | undefined;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function fakeGitHub(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: new URL(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const route of routes) {
      const r = route(call);
      if (r) return r;
    }
    return json({ message: "Not Found" }, 404);
  };
  return { connector: createGitHubConnector({ fetch: fetchImpl }), calls };
}

const P = "/repos/exemplo/testes-web";
const FILE = `${P}/contents/.github/workflows/testes.yml`;
const workflow: Route = ({ url }) =>
  url.pathname === `${P}/actions/workflows/101` ? json({ id: 101, name: "testes", path: ".github/workflows/testes.yml", state: "active", html_url: "https://github.com/x" }) : undefined;
const repo: Route = ({ url }) => (url.pathname === P ? json({ default_branch: "main" }) : undefined);
const putOk: Route = ({ url, method }) =>
  method === "PUT" && url.pathname.startsWith(`${P}/contents/`) ? json({ commit: { sha: "c0ffee", html_url: "https://github.com/exemplo/testes-web/commit/c0ffee" } }, 200) : undefined;

describe("GitHub: gravar o workflow", () => {
  it("commit direto manda o conteúdo em base64 com o sha lido (trava do próprio GitHub)", async () => {
    const { connector, calls } = fakeGitHub([workflow, repo, putOk]);
    const change = await connector.applyDefinitionChange!(conn, { externalPipelineId: "exemplo/testes-web/101", newContent: "name: x\n", justification: "Ajuste" }, "commit", "sha-lido");
    expect(change).toEqual({ mode: "commit", externalRevision: "c0ffee", branch: "main", url: "https://github.com/exemplo/testes-web/commit/c0ffee" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url.pathname).toBe(FILE);
    expect(put.body).toEqual({ message: "Ajuste", content: Buffer.from("name: x\n").toString("base64"), branch: "main", sha: "sha-lido" });
  });

  it("arquivo mudou no GitHub (409): conflito, sem tentar de novo", async () => {
    const { connector, calls } = fakeGitHub([workflow, repo, ({ method }) => (method === "PUT" ? json({ message: "sha mismatch" }, 409) : undefined)]);
    const error = await connector
      .applyDefinitionChange!(conn, { externalPipelineId: "exemplo/testes-web/101", newContent: "x: 1\n", justification: "m" }, "commit", "velho")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("conflict");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("pelo PR: cria a branch a partir da ponta, grava nela e abre o PR", async () => {
    const { connector, calls } = fakeGitHub([
      workflow,
      repo,
      putOk,
      ({ url }) => (url.pathname === `${P}/git/ref/heads/main` ? json({ object: { sha: "ponta-main" } }) : undefined),
      ({ url, method }) => (url.pathname === `${P}/git/refs` && method === "POST" ? json({ ref: "x" }, 201) : undefined),
      ({ url, method }) => (url.pathname === `${P}/pulls` && method === "POST" ? json({ html_url: "https://github.com/exemplo/testes-web/pull/7" }, 201) : undefined),
    ]);
    const change = await connector.applyDefinitionChange!(conn, { externalPipelineId: "exemplo/testes-web/101", newContent: "x: 1\n", justification: "Troca o runner" }, "pull-request", "sha-lido");
    expect(change).toMatchObject({ mode: "pull-request", url: "https://github.com/exemplo/testes-web/pull/7" });
    const ref = calls.find((c) => c.url.pathname === `${P}/git/refs`)!.body as { ref: string; sha: string };
    expect(ref).toEqual({ ref: `refs/heads/${change.branch}`, sha: "ponta-main" });
    expect((calls.find((c) => c.method === "PUT")!.body as { branch: string }).branch).toBe(change.branch);
    expect(calls.find((c) => c.url.pathname === `${P}/pulls`)!.body).toEqual({ title: "Troca o runner", head: change.branch, base: "main", body: "Troca o runner" });
  });

  it("cria workflow novo só em .github/workflows e já devolve a pipeline", async () => {
    const { connector } = fakeGitHub([
      putOk,
      ({ url }) =>
        url.pathname === `${P}/actions/workflows` ? json({ workflows: [{ id: 202, name: "Novos", path: ".github/workflows/novos.yml", state: "active", html_url: "https://github.com/w" }] }) : undefined,
    ]);
    const base = { repositoryId: "exemplo/testes-web", branch: "main", content: "name: Novos\n", name: "Novos", justification: "m", mode: "commit" as const };
    await expect(connector.createPipeline!(conn, { ...base, path: "workflows/novos.yml" })).rejects.toThrow(/\.github\/workflows/);
    const created = await connector.createPipeline!(conn, { ...base, path: ".github/workflows/novos.yml" });
    expect(created.pipeline).toEqual({ externalId: "exemplo/testes-web/202", name: "Novos", path: "testes-web", url: "https://github.com/w" });
  });
});
