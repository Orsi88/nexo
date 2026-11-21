import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_CAPABILITIES, type ConnectorCapabilities } from "@painel/contracts";
import { CONNECTOR_CONTRACT_VERSION, ConnectorRegistry, ProviderError, type PipelineConnector } from "@painel/connector-sdk";
import { DomainError, EnvelopeSecretStore, FoundationService, OnboardingService, parseMasterKey, renderTemplate, type Actor, type RequestMeta } from "../src/index.ts";
import { createTestDatabase, FAST_ARGON2, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "../src/testing.ts";

// Incremento 4 contra PostgreSQL real: ler o YAML, prévia com diff, gravar com trava otimista,
// criar pipeline por modelo e vincular, auditoria e permissões.

const meta: RequestMeta = { correlationId: "test-definition" };
const PASSWORD = "senha-forte-de-teste-1";
const CAPS: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  read: { ...NO_CAPABILITIES.read, pipelines: true, parameters: true, runs: true, definition: true },
  write: { ...NO_CAPABILITIES.write, triggerRun: true, definitionViaCommit: true, definitionViaPullRequest: true },
};

function fakeRepo() {
  const files = new Map<string, { content: string; revision: number }>([["proj/1", { content: "trigger: none\nsteps: []\n", revision: 1 }]]);
  const pipelinesById = new Map<string, string>([["proj/1", "testes-e2e"]]);
  let next = 2;
  const connector: PipelineConnector = {
    kind: "fake-repo",
    contractVersion: CONNECTOR_CONTRACT_VERSION,
    capabilities: async () => CAPS,
    testConnection: async () => ({ ok: true, missingPermissions: [] }),
    listPipelines: async () => ({ items: [...pipelinesById].map(([externalId, name]) => ({ externalId, name })) }),
    getPipeline: async (_c, externalId) => ({ externalId, name: pipelinesById.get(externalId) ?? "?", defaultRef: "refs/heads/main" }),
    getParameters: async () => [],
    triggerRun: async () => ({ externalPipelineId: "proj/1", externalRunId: "1" }),
    getRun: async () => {
      throw new ProviderError("not-found", "x");
    },
    listRuns: async () => ({ items: [] }),
    getDefinition: async (_c, externalId) => {
      const f = files.get(externalId)!;
      return { revision: `rev-${f.revision}`, format: "yaml", content: f.content, path: "pipelines/testes.yml" };
    },
    async applyDefinitionChange(_c, change, mode, expectedRevision) {
      const f = files.get(change.externalPipelineId)!;
      if (`rev-${f.revision}` !== expectedRevision) throw new ProviderError("conflict", "mudou");
      if (mode === "commit") files.set(change.externalPipelineId, { content: change.newContent, revision: f.revision + 1 });
      return mode === "commit"
        ? { mode, externalRevision: `commit-${f.revision + 1}`, branch: "main" }
        : { mode, externalRevision: "commit-pr", branch: "nexo/alteracao-1", url: "https://exemplo.test/pr/1" };
    },
    listRepositories: async () => [{ id: "proj/repo", name: "testes", scope: "proj", defaultBranch: "main" }],
    async createPipeline(_c, req) {
      if (req.mode !== "commit") return { change: { mode: req.mode, externalRevision: "c", url: "https://exemplo.test/pr/2" } };
      const externalId = `proj/${next++}`;
      files.set(externalId, { content: req.content, revision: 1 });
      pipelinesById.set(externalId, req.name);
      return { change: { mode: "commit", externalRevision: "c" }, pipeline: { externalId, name: req.name } };
    },
  };
  return { connector, files };
}

async function expectError(p: Promise<unknown>, code: DomainError["code"]) {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("arquivo da pipeline e criação por modelo (incremento 4)", () => {
  let t: TestDatabase;
  let foundation: FoundationService;
  let svc: OnboardingService;
  let fake: ReturnType<typeof fakeRepo>;
  let admin: Actor;
  let reader: Actor;
  let projectId: string;
  let integrationId: string;
  let pipelineId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    foundation = new FoundationService(t.db, { argon2: FAST_ARGON2 });
    fake = fakeRepo();
    const registry = new ConnectorRegistry();
    registry.register(fake.connector);
    svc = new OnboardingService(t.db, foundation, new EnvelopeSecretStore(t.db, parseMasterKey(Buffer.alloc(32, 3).toString("base64"))), registry);
    const boot = await foundation.bootstrapInstance({ adminEmail: "root@exemplo.test", adminName: "Root", organizationName: "Acme", organizationSlug: "acme" }, meta);
    await foundation.completePasswordReset({ token: boot.link.token, password: PASSWORD }, meta);
    admin = (await foundation.login({ email: "root@exemplo.test", password: PASSWORD }, meta)).actor;
    const ws = await foundation.createWorkspace(admin, { name: "Qualidade" }, meta);
    projectId = (await foundation.createProject(admin, { workspaceId: ws.id, name: "Portal" }, meta)).id;
    const link = await foundation.inviteMember(admin, { email: "leitor@exemplo.test", role: "reader", displayName: "Leitor" }, meta);
    await foundation.acceptInvite({ token: link.token, password: PASSWORD }, meta);
    reader = (await foundation.login({ email: "leitor@exemplo.test", password: PASSWORD }, meta)).actor;
    const { integration } = await svc.createIntegration(admin, { kind: "fake-repo", name: "Repo", endpoint: "https://dev.azure.com/exemplo", credential: "pat-valido-1234567890" }, meta);
    integrationId = integration.id;
    pipelineId = (await svc.importPipeline(admin, { projectId, integrationId, externalId: "proj/1" }, meta)).pipeline.id;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("lê o YAML com a revisão e diz como dá para gravar", async () => {
    const d = await svc.getDefinition(reader, pipelineId, {}, meta);
    expect(d).toMatchObject({ content: "trigger: none\nsteps: []\n", revision: "rev-1", path: "pipelines/testes.yml", modes: ["commit", "pull-request"] });
  });

  it("a prévia mostra a diferença e os problemas, sem gravar", async () => {
    const p = await svc.previewDefinitionChange(admin, pipelineId, { content: "trigger: none\nsteps: [\n" }, meta);
    expect(p.diff.changed).toBe(true);
    expect(p.problems.length).toBeGreaterThan(0);
    expect(fake.files.get("proj/1")!.revision).toBe(1);
    await expectError(svc.previewDefinitionChange(reader, pipelineId, { content: "a: 1" }, meta), "forbidden");
  });

  it("grava por commit direto e recusa quem leu uma versão velha (CA-032)", async () => {
    const content = "trigger: none\npool:\n  name: maquina-testes\nsteps: []\n";
    await expectError(svc.applyDefinitionChange(admin, pipelineId, { content: "a: [", expectedRevision: "rev-1", mode: "commit" }, meta), "invalid");
    const done = await svc.applyDefinitionChange(admin, pipelineId, { content, expectedRevision: "rev-1", mode: "commit", message: "Usa a máquina de testes" }, meta);
    expect(done.change).toMatchObject({ mode: "commit", externalRevision: "commit-2" });
    expect(done.pipeline?.pipeline.id).toBe(pipelineId);
    expect(fake.files.get("proj/1")!.content).toBe(content);
    const stale = await expectError(svc.applyDefinitionChange(admin, pipelineId, { content: "trigger: none\n", expectedRevision: "rev-1", mode: "commit" }, meta), "conflict");
    expect(stale.message).toMatch(/mudou no provedor/);
    await expectError(svc.applyDefinitionChange(reader, pipelineId, { content, expectedRevision: "rev-2", mode: "commit" }, meta), "forbidden");
  });

  it("pelo PR o arquivo não muda até o merge e o link volta para a tela", async () => {
    const done = await svc.applyDefinitionChange(admin, pipelineId, { content: "trigger: none\n", expectedRevision: "rev-2", mode: "pull-request" }, meta);
    expect(done).toMatchObject({ change: { mode: "pull-request", url: "https://exemplo.test/pr/1" }, pipeline: null });
    expect(fake.files.get("proj/1")!.revision).toBe(2);
  });

  it("monta pelo modelo, cria no provedor e já vincula ao projeto", async () => {
    // O provedor de teste não tem modelos próprios: recusa, e o YAML vem do modelo do Azure.
    await expectError(svc.renderPipelineTemplate(admin, { integrationId, templateId: "playwright", name: "E2E Portal" }), "invalid");
    const rendered = renderTemplate("azure-devops", "playwright", "E2E Portal", { withMode: true });
    expect(await svc.listRepositories(admin, integrationId, meta)).toHaveLength(1);
    const created = await svc.createPipeline(
      admin,
      { projectId, integrationId, repositoryId: "proj/repo", branch: "main", path: rendered.path, name: "E2E Portal", content: rendered.content, mode: "commit" },
      meta,
    );
    expect(created.pipeline?.pipeline).toMatchObject({ name: "E2E Portal", projectId });
    const byPr = await svc.createPipeline(
      admin,
      { projectId, integrationId, repositoryId: "proj/repo", branch: "main", path: "pipelines/outra.yml", name: "Outra", content: rendered.content, mode: "pull-request" },
      meta,
    );
    expect(byPr).toMatchObject({ pipeline: null, change: { url: "https://exemplo.test/pr/2" } });
    await expectError(
      svc.createPipeline(admin, { projectId, integrationId, repositoryId: "r", branch: "main", path: "../fora.yml", name: "x", content: "a: 1", mode: "commit" }, meta),
      "invalid",
    );
  });

  it("tudo fica na auditoria", async () => {
    const events = await foundation.listAudit(admin, {}, meta);
    const actions = events.map((e: { action: string }) => e.action);
    expect(actions).toContain("pipeline.definition.change");
    expect(actions).toContain("pipeline.create");
  });
});
