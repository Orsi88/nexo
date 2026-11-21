import { describe, expect, it } from "vitest";
import { checkConformance, NotSupportedError, ProviderError, type ConnectionContext } from "@painel/connector-sdk";
import { createGitHubConnector, GitHubHttpError, parseEndpoint, parseWorkflowInputs, translateRunStatus } from "../src/index.ts";

// Respostas no formato observado no spike S4 (API real do GitHub), com nomes fictícios.

const SECRET = "github_pat_valor-secreto-de-teste";
const conn: ConnectionContext = {
  organizationId: "org-teste",
  integrationId: "int-teste",
  endpoint: "https://github.com/exemplo",
  credential: { kind: "pat", value: SECRET },
  correlationId: "corr-teste",
};

const WORKFLOW_MAIN = `
name: testes
on:
  push:
  workflow_dispatch:
    inputs:
      navegador:
        description: Navegador dos testes
        type: choice
        options: [chromium, firefox]
        default: chromium
      repeticoes:
        type: number
        default: 1
      gerarRelatorio:
        type: boolean
        default: "true"
      ambiente:
        type: environment
        required: true
jobs:
  testes:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
const WORKFLOW_SEM_DISPARO = `
name: ci
on: [push, pull_request]
jobs: {}
`;

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: RequestRedirect;
}
type Route = (call: Call) => Response | undefined;

function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(init.status === 204 ? null : JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function fakeGitHub(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
  return { connector: createGitHubConnector({ fetch: fetchImpl }), calls };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const P = "/repos/exemplo/testes-web";

const reposRoute: Route = ({ url }) =>
  url.pathname === "/user/repos"
    ? json([
        { name: "testes-web", full_name: "exemplo/testes-web", owner: { login: "exemplo" }, html_url: "https://github.com/exemplo/testes-web", default_branch: "main" },
        { name: "antigo", full_name: "exemplo/antigo", owner: { login: "exemplo" }, html_url: "https://github.com/exemplo/antigo", default_branch: "main", archived: true },
        { name: "de-outro", full_name: "outra/de-outro", owner: { login: "outra" }, html_url: "https://github.com/outra/de-outro", default_branch: "main" },
      ])
    : undefined;
const workflowRoute: Route = ({ url }) =>
  url.pathname === `${P}/actions/workflows/101`
    ? json({ id: 101, name: "testes", path: ".github/workflows/testes.yml", state: "active", html_url: "https://github.com/exemplo/testes-web/blob/main/.github/workflows/testes.yml" })
    : undefined;
const repoRoute: Route = ({ url }) =>
  url.pathname === P ? json({ name: "testes-web", full_name: "exemplo/testes-web", owner: { login: "exemplo" }, html_url: "https://github.com/exemplo/testes-web", default_branch: "main" }) : undefined;
const fileRoute: Route = ({ url }) => {
  if (url.pathname !== `${P}/contents/.github/workflows/testes.yml`) return undefined;
  const ref = url.searchParams.get("ref");
  if (ref === "sem-disparo") return json({ encoding: "base64", content: b64(WORKFLOW_SEM_DISPARO), sha: "bbb" });
  return json({ encoding: "base64", content: b64(WORKFLOW_MAIN), sha: "aaa111" });
};

const run = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  workflow_id: 101,
  run_number: 42,
  event: "workflow_dispatch",
  status: "in_progress",
  conclusion: null,
  head_branch: "main",
  head_sha: "abc123",
  created_at: "2026-01-10T10:00:00Z",
  run_started_at: "2026-01-10T10:00:05Z",
  updated_at: "2026-01-10T10:03:00Z",
  ...over,
});

describe("conector GitHub Actions", () => {
  it("declara só o que implementa (conformidade do contrato)", async () => {
    const { connector } = fakeGitHub([]);
    expect(checkConformance(connector, await connector.capabilities(conn))).toEqual([]);
  });

  it("autentica com Bearer, sem a credencial na URL, e com a versão da API", async () => {
    const { connector, calls } = fakeGitHub([reposRoute, ({ url }) => (url.pathname === `${P}/actions/workflows` ? json({ total_count: 1, workflows: [] }) : undefined)]);
    expect(await connector.testConnection(conn)).toEqual({ ok: true, identity: "1 repositório(s) de exemplo", missingPermissions: [] });
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(c.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(c.url.toString()).not.toContain(SECRET);
      expect(c.redirect).toBe("manual");
    }
  });

  it("teste de conexão diz qual permissão falta, sem expor o corpo da resposta", async () => {
    const { connector } = fakeGitHub([reposRoute, ({ url }) => (url.pathname.endsWith("/actions/workflows") ? json({ message: SECRET }, { status: 403 }) : undefined)]);
    const check = await connector.testConnection(conn);
    expect(check).toMatchObject({ ok: false, missingPermissions: ["Actions (Read)"] });
    expect(JSON.stringify(check)).not.toContain(SECRET);
  });

  it("credencial sem nenhum repositório do dono é recusada com motivo", async () => {
    const { connector } = fakeGitHub([({ url }) => (url.pathname === "/user/repos" ? json([]) : undefined)]);
    expect(await connector.testConnection(conn)).toMatchObject({ ok: false, message: "a credencial não enxerga nenhum repositório de exemplo" });
  });

  it("lista workflows ativos por repositório do dono, ignorando arquivados e de outros donos", async () => {
    const { connector } = fakeGitHub([
      reposRoute,
      ({ url }) =>
        url.pathname === `${P}/actions/workflows`
          ? json({
              workflows: [
                { id: 101, name: "testes", path: ".github/workflows/testes.yml", state: "active", html_url: "u1" },
                { id: 102, name: "velho", path: ".github/workflows/velho.yml", state: "disabled_manually", html_url: "u2" },
              ],
            })
          : undefined,
    ]);
    expect(await connector.listPipelines(conn, {})).toEqual({ items: [{ externalId: "exemplo/testes-web/101", name: "testes", path: "testes-web", url: "u1" }] });
  });

  it("lê a pipeline com a branch padrão e o repositório", async () => {
    const { connector } = fakeGitHub([workflowRoute, repoRoute]);
    expect(await connector.getPipeline(conn, "exemplo/testes-web/101")).toMatchObject({
      name: "testes",
      defaultRef: "refs/heads/main",
      repository: { name: "testes-web", url: "https://github.com/exemplo/testes-web" },
    });
  });

  it("lê as entradas do workflow_dispatch na branch pedida", async () => {
    const { connector, calls } = fakeGitHub([workflowRoute, fileRoute]);
    const params = await connector.getParameters(conn, "exemplo/testes-web/101", "refs/heads/feature/x");
    expect(params.map((p) => [p.name, p.type])).toEqual([
      ["navegador", "enum"],
      ["repeticoes", "number"],
      ["gerarRelatorio", "boolean"],
      ["ambiente", "string"],
    ]);
    expect(calls.at(-1)!.url.searchParams.get("ref")).toBe("feature/x");
  });

  it("dispara com return_run_details e devolve o id da execução (S4)", async () => {
    const { connector, calls } = fakeGitHub([
      workflowRoute,
      ({ url, method }) => (method === "POST" && url.pathname === `${P}/actions/workflows/101/dispatches` ? json({ workflow_run_id: 9001 }) : undefined),
    ]);
    const ref = await connector.triggerRun(conn, { externalPipelineId: "exemplo/testes-web/101", ref: "refs/heads/main", parameters: { repeticoes: 2, gerarRelatorio: true } }, "idem");
    expect(ref).toEqual({ externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" });
    expect(calls.at(-1)!.body).toEqual({ ref: "main", inputs: { repeticoes: "2", gerarRelatorio: "true" }, return_run_details: true });
  });

  it("disparo recusado (422) vira erro com a explicação do GitHub", async () => {
    const { connector } = fakeGitHub([
      workflowRoute,
      ({ method }) => (method === "POST" ? json({ message: "Workflow does not have 'workflow_dispatch' trigger" }, { status: 422 }) : undefined),
    ]);
    const error = await connector.triggerRun(conn, { externalPipelineId: "exemplo/testes-web/101", ref: "main", parameters: {} }, "idem").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("invalid");
    expect((error as Error).message).toContain("workflow_dispatch");
  });

  it("GitHub que não devolve o id (204) é declarado como não suportado, sem adivinhar a execução", async () => {
    const { connector } = fakeGitHub([workflowRoute, ({ method }) => (method === "POST" ? json(null, { status: 204 }) : undefined)]);
    await expect(connector.triggerRun(conn, { externalPipelineId: "exemplo/testes-web/101", ref: "main", parameters: {} }, "idem")).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("acompanha a execução e confere que ela é do workflow certo", async () => {
    const { connector } = fakeGitHub([({ url }) => (url.pathname === `${P}/actions/runs/9001` ? json(run({ status: "completed", conclusion: "failure" })) : undefined)]);
    expect(await connector.getRun(conn, { externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" })).toMatchObject({
      status: "failed",
      externalStatus: "completed/failure",
      runNumber: "42",
      ref: "refs/heads/main",
      sourceRevision: "abc123",
      finishedAt: "2026-01-10T10:03:00Z",
      startedOutsidePlatform: false,
    });
    await expect(connector.getRun(conn, { externalPipelineId: "exemplo/testes-web/555", externalRunId: "9001" })).rejects.toThrow(/não pertence/);
  });

  it("lista execuções desde uma data; push e PR contam como de fora", async () => {
    const { connector, calls } = fakeGitHub([
      ({ url }) =>
        url.pathname === `${P}/actions/workflows/101/runs`
          ? json({ workflow_runs: [run({ id: 3, event: "push", created_at: "2026-01-10T12:00:00Z" }), run({ id: 2, event: "pull_request", created_at: "2026-01-09T12:00:00Z" })] })
          : undefined,
    ]);
    const page = await connector.listRuns(conn, "exemplo/testes-web/101", "2026-01-09T00:00:00Z");
    expect(page.items.map((r) => [r.externalRunId, r.startedOutsidePlatform])).toEqual([
      ["3", true],
      ["2", true],
    ]);
    expect(calls[0]!.url.searchParams.get("created")).toBe(">=2026-01-09T00:00:00.000Z");
  });

  it("cancela; execução já terminada é recusada com motivo claro", async () => {
    const ok = fakeGitHub([({ url, method }) => (method === "POST" && url.pathname === `${P}/actions/runs/9001/cancel` ? json({}, { status: 202 }) : undefined)]);
    await ok.connector.cancelRun!(conn, { externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" });
    const done = fakeGitHub([({ method }) => (method === "POST" ? json({ message: "Cannot cancel a workflow run that is completed." }, { status: 409 }) : undefined)]);
    await expect(done.connector.cancelRun!(conn, { externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" })).rejects.toThrow("a execução já terminou no GitHub");
  });

  it("logs por job, seguindo o redirecionamento e sem códigos de cor do terminal", async () => {
    const { connector, calls } = fakeGitHub([
      ({ url }) => (url.pathname === `${P}/actions/runs/9001/jobs` ? json({ jobs: [{ id: 7, name: "testes" }, { id: 8, name: "ainda-na-fila" }] }) : undefined),
      ({ url }) => (url.pathname === `${P}/actions/jobs/7/logs` ? new Response("\u001b[36;1mnpm test\u001b[0m\n93 passed\n", { status: 200 }) : undefined),
    ]);
    const chunks = [];
    for await (const c of connector.getLogs!(conn, { externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" })) chunks.push(c);
    expect(chunks).toEqual([{ stage: "testes", text: "npm test\n93 passed\n" }]);
    expect(calls.find((c) => c.url.pathname.endsWith("/jobs/7/logs"))!.redirect).toBe("follow");
  });

  it("artefatos não expirados, com ref para baixar depois", async () => {
    const { connector } = fakeGitHub([
      ({ url }) =>
        url.pathname === `${P}/actions/runs/9001/artifacts`
          ? json({ artifacts: [{ id: 55, name: "test-results", size_in_bytes: 3889 }, { id: 56, name: "velho", expired: true }] })
          : undefined,
    ]);
    expect(await connector.listArtifacts!(conn, { externalPipelineId: "exemplo/testes-web/101", externalRunId: "9001" })).toEqual([
      { ref: "exemplo/testes-web/55", name: "test-results", sizeBytes: 3889 },
    ]);
  });

  it("limite de requisições vira rate-limited com o tempo de espera", async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const { connector } = fakeGitHub([() => json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })]);
    const error = await connector.getPipeline(conn, "exemplo/testes-web/101").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubHttpError);
    expect((error as GitHubHttpError).kind).toBe("rate-limited");
    expect((error as GitHubHttpError).retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("endereço da integração", () => {
  it("aceita github.com/<dono> e recusa o resto (o servidor manda a credencial para lá)", () => {
    expect(parseEndpoint("https://github.com/exemplo")).toEqual({ apiBase: "https://api.github.com", owner: "exemplo", webBase: "https://github.com" });
    expect(() => parseEndpoint("http://github.com/exemplo")).toThrow(/https/);
    expect(() => parseEndpoint("https://github.com/exemplo/repo")).toThrow(/usuário ou organização/);
    expect(() => parseEndpoint("https://evil.example/exemplo")).toThrow(/fora do GitHub/);
    expect(() => parseEndpoint("https://token@github.com/exemplo")).toThrow(/credencial/);
    expect(parseEndpoint("https://git.empresa.local/time", ["git.empresa.local"]).apiBase).toBe("https://git.empresa.local/api/v3");
  });
});

describe("entradas de workflow_dispatch", () => {
  it("workflow sem workflow_dispatch: não dá para disparar de fora", () => {
    expect(parseWorkflowInputs(WORKFLOW_SEM_DISPARO)).toEqual({ dispatchable: false, inputs: [] });
    expect(parseWorkflowInputs("on: workflow_dispatch\njobs: {}")).toEqual({ dispatchable: true, inputs: [] });
  });

  it("traduz tipos, padrões, obrigatórios e descrição", () => {
    const { inputs } = parseWorkflowInputs(WORKFLOW_MAIN);
    expect(inputs).toEqual([
      { name: "navegador", label: "Navegador dos testes", required: false, scope: "provider", type: "enum", options: ["chromium", "firefox"], default: "chromium" },
      { name: "repeticoes", required: false, scope: "provider", type: "number", default: 1 },
      { name: "gerarRelatorio", required: false, scope: "provider", type: "boolean", default: true },
      { name: "ambiente", required: true, scope: "provider", type: "string" },
    ]);
  });

  it("choice sem opções é recusado em vez de virar um campo que não funciona", () => {
    expect(() => parseWorkflowInputs("on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice\n")).toThrow(/options/);
  });
});

describe("estados do GitHub", () => {
  it("traduz status + conclusion; o que não diz se passou fica desconhecido", () => {
    expect(translateRunStatus("queued", null).status).toBe("queued");
    expect(translateRunStatus("waiting", null).status).toBe("queued");
    expect(translateRunStatus("in_progress", null).status).toBe("running");
    expect(translateRunStatus("completed", "success").status).toBe("succeeded");
    expect(translateRunStatus("completed", "timed_out").status).toBe("failed");
    expect(translateRunStatus("completed", "cancelled").status).toBe("cancelled");
    expect(translateRunStatus("completed", "skipped").status).toBe("unknown");
  });
});
