import { describe, expect, it } from "vitest";
import { coerceParameterValues } from "@painel/contracts";
import { checkConformance, ProviderError, type ConnectionContext } from "@painel/connector-sdk";
import {
  AzureDevOpsHttpError,
  createAzureDevOpsConnector,
  organizationUrl,
  parseYamlParameters,
  translateBuildStatus,
} from "../src/index.ts";

// Dados no formato observado no spike S1, com nomes fictícios.

const SECRET = "valor-secreto-de-teste";
const conn: ConnectionContext = {
  organizationId: "org-teste",
  integrationId: "int-teste",
  endpoint: "https://dev.azure.com/exemplo/",
  credential: { kind: "pat", value: SECRET },
  correlationId: "corr-teste",
};

const YAML_MAIN = `
parameters:
  - name: branchApp
    displayName: 'Branch da aplicação'
    type: string
    default: 'main'
  - name: limparDados
    type: boolean
    default: true
`;

const YAML_TESTES = `${YAML_MAIN}
  - name: navegador
    type: string
    default: chromium
    values: [chromium, firefox, webkit]
  - name: workers
    type: number
    default: 4
  - name: extraSteps
    type: stepList
    default: []
  - name: obrigatorio
    type: string
jobs:
  - job: Testes
    steps:
      - script: echo \${{ parameters.navegador }}
`;

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: RequestRedirect;
}

type Route = (call: Call) => Response | undefined;

function json(data: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function fakeAzure(routes: Route[]) {
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
    return json({ message: "rota não simulada" }, { status: 404 });
  };
  return { connector: createAzureDevOpsConnector({ fetch: fetchImpl }), calls };
}

const definitionRoute: Route = ({ url }) =>
  url.pathname === "/exemplo/proj-1/_apis/build/definitions/381"
    ? json({
        id: 381,
        name: "testes-e2e",
        path: "\\",
        revision: 5,
        project: { id: "proj-1" },
        process: { type: 2, yamlFilename: "azure-pipelines.yml" },
        repository: { id: "repo-1", type: "TfsGit", defaultBranch: "refs/heads/main" },
        _links: { web: { href: "https://dev.azure.com/exemplo/proj-1/_build/definition?definitionId=381" } },
      })
    : undefined;

const yamlRoute: Route = ({ url }) => {
  if (url.pathname !== "/exemplo/proj-1/_apis/git/repositories/repo-1/items") return undefined;
  const branch = url.searchParams.get("versionDescriptor.version");
  if (branch === "main") return json({ content: YAML_MAIN, commitId: "aaa111" });
  if (branch === "testes-maquina") return json({ content: YAML_TESTES, commitId: "bbb222" });
  return json({ message: "branch não existe" }, { status: 404 });
};

describe("conector Azure DevOps", () => {
  it("está conforme o contrato (capacidade declarada = método implementado)", async () => {
    const connector = createAzureDevOpsConnector();
    expect(checkConformance(connector, await connector.capabilities(conn))).toEqual([]);
  });

  it("autentica com PAT em Basic, sem a credencial na URL, e com api-version", async () => {
    const { connector, calls } = fakeAzure([definitionRoute]);
    await connector.getPipeline(conn, "proj-1/381");
    const call = calls[0]!;
    expect(call.headers.authorization).toBe("Basic " + Buffer.from(":" + SECRET).toString("base64"));
    expect(call.url.toString()).not.toContain(SECRET);
    expect(call.url.searchParams.get("api-version")).toBe("7.1");
    expect(call.redirect).toBe("manual");
  });

  it("informa o repositório da pipeline, só com link https", async () => {
    const definition = (url: string) => () =>
      json({ id: 381, name: "testes-e2e", project: { id: "proj-1" }, repository: { id: "repo-1", type: "TfsGit", name: "testes-e2e", url } });
    const ok = await fakeAzure([definition("https://dev.azure.com/exemplo/proj-1/_git/testes-e2e")]).connector.getPipeline(conn, "proj-1/381");
    expect(ok.repository).toEqual({ name: "testes-e2e", url: "https://dev.azure.com/exemplo/proj-1/_git/testes-e2e" });
    const bad = await fakeAzure([definition("javascript:alert(1)")]).connector.getPipeline(conn, "proj-1/381");
    expect(bad.repository).toEqual({ name: "testes-e2e" });
  });

  it("lê os parâmetros do YAML na branch pedida, porque cada branch pode declarar outros (S1, achado 1)", async () => {
    const { connector } = fakeAzure([definitionRoute, yamlRoute]);
    const naPadrao = await connector.getParameters(conn, "proj-1/381");
    const naBranch = await connector.getParameters(conn, "proj-1/381", "refs/heads/testes-maquina");
    expect(naPadrao.map((p) => p.name)).toEqual(["branchApp", "limparDados"]);
    expect(naBranch.map((p) => p.name)).toEqual(["branchApp", "limparDados", "navegador", "workers", "obrigatorio"]);
  });

  it("dispara com os parâmetros como texto e a branch completa", async () => {
    const { connector, calls } = fakeAzure([
      ({ url, method }) =>
        method === "POST" && url.pathname === "/exemplo/proj-1/_apis/pipelines/381/runs" ? json({ id: 900351 }) : undefined,
    ]);
    const run = await connector.triggerRun(
      conn,
      { externalPipelineId: "proj-1/381", ref: "testes-maquina", parameters: { limparDados: false, workers: 2 } },
      "idem-1",
    );
    expect(run).toEqual({ externalPipelineId: "proj-1/381", externalRunId: "900351" });
    expect(calls[0]!.body).toEqual({
      templateParameters: { limparDados: "false", workers: "2" },
      resources: { repositories: { self: { refName: "refs/heads/testes-maquina" } } },
    });
  });

  it("cancela pedindo status cancelling na execução", async () => {
    const { connector, calls } = fakeAzure([
      ({ url, method }) =>
        method === "PATCH" && url.pathname === "/exemplo/proj-1/_apis/build/builds/900351" ? json({ id: 900351 }) : undefined,
    ]);
    await connector.cancelRun!(conn, { externalPipelineId: "proj-1/381", externalRunId: "900351" });
    expect(calls[0]!.body).toEqual({ status: "cancelling" });
  });

  it("traduz a execução e mantém os parâmetros como o Azure guardou", async () => {
    const { connector } = fakeAzure([
      ({ url }) =>
        url.pathname === "/exemplo/proj-1/_apis/build/builds/124796"
          ? json({
              id: 124796,
              status: "completed",
              result: "canceled",
              reason: "schedule",
              queueTime: "2026-11-18T16:16:49Z",
              finishTime: "2026-11-18T18:52:31Z",
              sourceBranch: "refs/heads/testes-maquina",
              sourceVersion: "6c883c1",
              definition: { id: 381 },
              templateParameters: { limparDados: "True", branchApp: "main" },
            })
          : undefined,
    ]);
    const state = await connector.getRun(conn, { externalPipelineId: "proj-1/381", externalRunId: "124796" });
    expect(state).toMatchObject({
      status: "cancelled",
      externalStatus: "completed/canceled",
      startedOutsidePlatform: true,
      ref: "refs/heads/testes-maquina",
      rawParameters: { limparDados: "True", branchApp: "main" },
    });
  });

  it("recusa execução de outra pipeline", async () => {
    const { connector } = fakeAzure([
      ({ url }) => (url.pathname.endsWith("/builds/7") ? json({ id: 7, status: "completed", definition: { id: 999 } }) : undefined),
    ]);
    await expect(connector.getRun(conn, { externalPipelineId: "proj-1/381", externalRunId: "7" })).rejects.toThrow(
      "não pertence",
    );
  });

  it("lista execuções da mais recente até a data pedida, seguindo a paginação", async () => {
    const build = (id: number, queueTime: string) => ({ id, status: "completed", result: "failed", queueTime });
    const { connector, calls } = fakeAzure([
      ({ url }) => {
        if (url.pathname !== "/exemplo/proj-1/_apis/build/builds") return undefined;
        return url.searchParams.get("continuationToken") === "p2"
          ? json({ value: [build(2, "2026-11-17T06:00:00Z"), build(1, "2026-11-10T06:00:00Z")] })
          : json({ value: [build(4, "2026-11-19T06:00:00Z"), build(3, "2026-11-18T06:00:00Z")] }, { headers: { "x-ms-continuationtoken": "p2" } });
      },
    ]);
    const page = await connector.listRuns(conn, "proj-1/381", "2026-11-15T00:00:00Z");
    expect(page.items.map((r) => r.externalRunId)).toEqual(["4", "3", "2"]);
    expect(calls).toHaveLength(2);
  });

  it("lista pipelines um projeto por página", async () => {
    const { connector } = fakeAzure([
      ({ url }) =>
        url.pathname === "/exemplo/_apis/projects"
          ? json({ value: [{ id: "proj-2", name: "Mobile" }, { id: "proj-1", name: "Corporate" }] })
          : undefined,
      ({ url }) =>
        url.pathname === "/exemplo/proj-1/_apis/build/definitions"
          ? json({ value: [{ id: 381, name: "testes-e2e", path: "\\" }, { id: 187, name: "imagem", path: "\\Imagens" }] })
          : undefined,
    ]);
    const page = await connector.listPipelines(conn, {});
    expect(page.items).toEqual([
      { externalId: "proj-1/381", name: "testes-e2e", path: "Corporate" },
      { externalId: "proj-1/187", name: "imagem", path: "Corporate\\Imagens" },
    ]);
    expect(page.nextCursor).toBe("1");
  });

  it("lê os logs na ordem e filtra por estágio", async () => {
    const { connector } = fakeAzure([
      ({ url }) =>
        url.pathname.endsWith("/builds/10/timeline")
          ? json({
              records: [
                { id: "s1", type: "Stage", name: "__default" },
                { id: "j1", parentId: "s1", type: "Job", name: "Testes", log: { id: 3 } },
                { id: "t2", parentId: "j1", type: "Task", name: "Executar", log: { id: 5 } },
                { id: "t1", parentId: "j1", type: "Task", name: "Clonar", log: { id: 4 } },
              ],
            })
          : undefined,
      ({ url }) => {
        const m = /\/builds\/10\/logs\/(\d+)$/.exec(url.pathname);
        return m ? new Response(`log ${m[1]}`, { headers: { "content-type": "text/plain" } }) : undefined;
      },
    ]);
    const run = { externalPipelineId: "proj-1/381", externalRunId: "10" };
    const chunks = [];
    for await (const chunk of connector.getLogs!(conn, run)) chunks.push(chunk);
    expect(chunks).toEqual([
      { stage: "__default", text: "log 4" },
      { stage: "__default", text: "log 5" },
    ]);
    const outro = [];
    for await (const chunk of connector.getLogs!(conn, run, "Outro")) outro.push(chunk);
    expect(outro).toEqual([]);
  });

  it("lista e baixa artefatos sem montar URL fora da organização", async () => {
    const { connector, calls } = fakeAzure([
      ({ url }) =>
        url.pathname.endsWith("/builds/10/artifacts") && !url.searchParams.has("artifactName")
          ? json({ value: [{ name: "playwright report", resource: { properties: { artifactsize: "2048" } } }] })
          : undefined,
      ({ url }) =>
        url.searchParams.get("artifactName") === "playwright report"
          ? new Response("PK", { headers: { "content-type": "application/zip" } })
          : undefined,
    ]);
    const [artifact] = await connector.listArtifacts!(conn, { externalPipelineId: "proj-1/381", externalRunId: "10" });
    expect(artifact).toEqual({ ref: "proj-1/10/playwright%20report", name: "playwright report", sizeBytes: 2048 });
    const stream = await connector.downloadArtifact!(conn, artifact!);
    expect(await new Response(stream).text()).toBe("PK");
    expect(calls[1]!.url.origin).toBe("https://dev.azure.com");
    expect(calls[1]!.redirect).toBe("follow");
  });

  describe("erros", () => {
    it("trata redirecionamento para login como credencial inválida, sem vazar a credencial", async () => {
      const { connector } = fakeAzure([() => new Response(null, { status: 302, headers: { location: "https://login" } })]);
      const error = await connector.getPipeline(conn, "proj-1/381").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AzureDevOpsHttpError);
      expect((error as AzureDevOpsHttpError).status).toBe(401);
      expect(String((error as Error).message)).not.toContain(SECRET);
    });

    it("testConnection aponta a permissão que falta", async () => {
      const { connector } = fakeAzure([
        ({ url }) => (url.pathname === "/exemplo/_apis/projects" ? json({ value: [{ id: "proj-1", name: "A" }] }) : undefined),
        ({ url }) => (url.pathname === "/exemplo/proj-1/_apis/build/definitions" ? json({}, { status: 403 }) : undefined),
      ]);
      expect(await connector.testConnection(conn)).toMatchObject({ ok: false, missingPermissions: ["Build (Read)"] });
    });

    it("guarda Retry-After quando o Azure limita as requisições", async () => {
      const { connector } = fakeAzure([() => json({}, { status: 429, headers: { "retry-after": "30" } })]);
      const error = (await connector.getPipeline(conn, "proj-1/381").catch((e: unknown) => e)) as AzureDevOpsHttpError;
      expect(error.retryAfterSeconds).toBe(30);
    });

    it("recusa endpoint sem https ou com credencial embutida", async () => {
      const { connector } = fakeAzure([]);
      await expect(connector.getPipeline({ ...conn, endpoint: "http://dev.azure.com/x" }, "p/1")).rejects.toThrow("https");
      await expect(connector.getPipeline({ ...conn, endpoint: "https://u:s@dev.azure.com/x" }, "p/1")).rejects.toThrow(
        "credencial",
      );
    });

    it("só envia a credencial para hosts do Azure DevOps (evita vazar o PAT e sondar a rede interna)", async () => {
      const { connector, calls } = fakeAzure([definitionRoute]);
      for (const endpoint of [
        "https://evil.example.com/exemplo",
        "https://dev.azure.com.evil.example/exemplo",
        "https://169.254.169.254/latest",
        "https://dev.azure.com:8443/exemplo",
        "https://dev.azure.com/",
        "https://dev.azure.com/a/b",
      ]) {
        await expect(connector.getPipeline({ ...conn, endpoint }, "proj-1/381")).rejects.toBeInstanceOf(ProviderError);
      }
      expect(calls).toHaveLength(0);
      expect(organizationUrl("https://Exemplo.VisualStudio.com/")).toBe("https://exemplo.visualstudio.com");
      expect(organizationUrl("https://ado.empresa.local/tfs", ["ado.empresa.local"])).toBe("https://ado.empresa.local/tfs");
      expect(() => organizationUrl("https://ado.empresa.local/tfs")).toThrow("fora do Azure DevOps");
    });

    it("falha de rede vira erro 'indisponível', sem detalhe interno", async () => {
      const connector = createAzureDevOpsConnector({ fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND interno")) });
      const error = (await connector.getPipeline(conn, "proj-1/381").catch((e: unknown) => e)) as ProviderError;
      expect(error.kind).toBe("unavailable");
      expect(error.message).not.toContain("ENOTFOUND");
    });

    it("recusa ids malformados antes de chamar a API", async () => {
      const { connector, calls } = fakeAzure([]);
      await expect(connector.getPipeline(conn, "../381")).rejects.toThrow("inválido");
      await expect(connector.getPipeline(conn, "./381")).rejects.toThrow("inválido");
      await expect(connector.downloadArtifact!(conn, { ref: "../10/x", name: "x" })).rejects.toThrow("inválida");
      await expect(connector.getRun(conn, { externalPipelineId: "proj-1/381", externalRunId: "1/../2" })).rejects.toThrow("inválido");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("parseYamlParameters", () => {
  it("traduz tipos, padrões, opções e obrigatoriedade", () => {
    const { parameters, skipped } = parseYamlParameters(YAML_TESTES);
    expect(parameters).toEqual([
      { name: "branchApp", label: "Branch da aplicação", type: "string", default: "main", required: false, scope: "provider" },
      { name: "limparDados", type: "boolean", default: true, required: false, scope: "provider" },
      { name: "navegador", type: "enum", options: ["chromium", "firefox", "webkit"], default: "chromium", required: false, scope: "provider" },
      { name: "workers", type: "number", default: 4, required: false, scope: "provider" },
      { name: "obrigatorio", type: "string", required: true, scope: "provider" },
    ]);
    expect(skipped).toEqual([{ name: "extraSteps", type: "stepList" }]);
  });

  it("YAML sem parâmetros devolve lista vazia", () => {
    expect(parseYamlParameters("steps:\n  - script: echo oi\n").parameters).toEqual([]);
  });

  it("recusa tipo complexo sem padrão, porque não dá para disparar", () => {
    expect(() => parseYamlParameters("parameters:\n  - name: x\n    type: object\n")).toThrow("sem valor padrão");
  });

  it("recusa a forma antiga sem tipos e YAML inválido", () => {
    expect(() => parseYamlParameters("parameters:\n  a: 1\n")).toThrow("forma tipada");
    expect(() => parseYamlParameters("parameters: [\n")).toThrow("YAML inválido");
  });
});

describe("estados e parâmetros vindos do Azure", () => {
  it("aceita os enums em texto e em número (S1, achado 3)", () => {
    expect(translateBuildStatus("completed", "succeeded").status).toBe("succeeded");
    expect(translateBuildStatus(2, 32)).toEqual({ status: "cancelled", externalStatus: "completed/canceled" });
    expect(translateBuildStatus(2, 8).status).toBe("failed");
    expect(translateBuildStatus("completed", "partiallySucceeded")).toEqual({
      status: "succeeded",
      externalStatus: "completed/partiallySucceeded",
    });
    expect(translateBuildStatus("inProgress", "none").status).toBe("running");
    expect(translateBuildStatus(4, 0).status).toBe("cancelling");
    expect(translateBuildStatus("notStarted", undefined).status).toBe("queued");
  });

  it("converte \"True\" e \"true\" para booleano pelo tipo declarado (S1, achado 2)", () => {
    const specs = parseYamlParameters(YAML_TESTES).parameters;
    expect(coerceParameterValues(specs, { limparDados: "True", workers: "8", branchApp: "true", navegador: "firefox" })).toEqual({
      limparDados: true,
      workers: 8,
      branchApp: "true",
      navegador: "firefox",
    });
    expect(coerceParameterValues(specs, { limparDados: "talvez" })).toEqual({ limparDados: "talvez" });
  });
});

describe("escolha de versão e validação antes de executar", () => {
  const refsRoute: Route = ({ url }) => {
    if (url.pathname !== "/exemplo/proj-1/_apis/git/repositories/repo-1/refs") return undefined;
    const filter = url.searchParams.get("filter");
    if (filter === "heads/") return json({ value: [{ name: "refs/heads/main" }, { name: "refs/heads/testes-maquina" }] });
    if (filter === "tags/") return json({ value: [{ name: "refs/tags/master-20250114.9" }, { name: "refs/tags/master-20250114.18" }] });
    return undefined;
  };

  it("lista branches e tags do repositório do YAML, com a ref completa para enviar", async () => {
    const { connector, calls } = fakeAzure([definitionRoute, refsRoute]);
    const refs = await connector.listRefs!(conn, "proj-1/381", { search: "m" });
    // Branches em ordem alfabética, depois as tags mais novas primeiro.
    expect(refs).toEqual([
      { name: "main", ref: "refs/heads/main", kind: "branch" },
      { name: "testes-maquina", ref: "refs/heads/testes-maquina", kind: "branch" },
      { name: "master-20250114.18", ref: "refs/tags/master-20250114.18", kind: "tag" },
      { name: "master-20250114.9", ref: "refs/tags/master-20250114.9", kind: "tag" },
    ]);
    expect(calls.filter((c) => c.url.pathname.endsWith("/refs")).every((c) => c.url.searchParams.get("filterContains") === "m")).toBe(true);
  });

  it("valida no Azure com previewRun, sem criar execução", async () => {
    const { connector, calls } = fakeAzure([
      ({ url, method, body }) =>
        method === "POST" && url.pathname === "/exemplo/proj-1/_apis/pipelines/381/runs" && (body as { previewRun?: boolean }).previewRun
          ? json({ finalYaml: "jobs: []" })
          : undefined,
    ]);
    const ok = await connector.validateRun!(conn, { externalPipelineId: "proj-1/381", ref: "testes-maquina", parameters: { suite: "smoke" } });
    expect(ok).toEqual({ ok: true, problems: [] });
    expect(calls[0]!.body).toEqual({
      previewRun: true,
      templateParameters: { suite: "smoke" },
      resources: { repositories: { self: { refName: "refs/heads/testes-maquina" } } },
    });
  });

  it("devolve os problemas que o Azure aponta, em vez de lançar erro", async () => {
    const { connector } = fakeAzure([
      ({ method }) =>
        method === "POST"
          ? json({ message: "Unexpected parameter 'naoExiste'\nThe 'suite' parameter value 'x' is not a valid value." }, { status: 400 })
          : undefined,
    ]);
    const r = await connector.validateRun!(conn, { externalPipelineId: "proj-1/381", parameters: { naoExiste: 1 } });
    expect(r).toEqual({
      ok: false,
      problems: ["Unexpected parameter 'naoExiste'", "The 'suite' parameter value 'x' is not a valid value."],
    });
  });

  it("credencial recusada na validação continua sendo erro, sem corpo da resposta", async () => {
    const { connector } = fakeAzure([({ method }) => (method === "POST" ? json({ message: "segredo" }, { status: 401 }) : undefined)]);
    await expect(connector.validateRun!(conn, { externalPipelineId: "proj-1/381", parameters: {} })).rejects.toThrow(/401/);
  });
});
