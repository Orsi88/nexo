import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_CAPABILITIES, type ConnectorCapabilities, type ParameterSpec, type PipelineManifest } from "@painel/contracts";
import {
  CONNECTOR_CONTRACT_VERSION,
  ConnectorRegistry,
  NotSupportedError,
  ProviderError,
  type ConnectionContext,
  type PipelineConnector,
} from "@painel/connector-sdk";
import {
  DomainError,
  EnvelopeSecretStore,
  FoundationService,
  OnboardingService,
  parseMasterKey,
  type Actor,
  type RequestMeta,
} from "../src/index.ts";
import { createTestDatabase, FAST_ARGON2, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "../src/testing.ts";

// Incremento 2 contra PostgreSQL real, com RLS: CA-002, CA-003, CA-004, CA-026, CA-030, CA-040.

const meta: RequestMeta = { correlationId: "test-onboarding" };
const PASSWORD = "senha-forte-de-teste-1";
const GOOD_PAT = "pat-valido-1234567890";
const OTHER_PAT = "pat-valido-novo-0987654321";
const ENDPOINT = "https://dev.azure.com/exemplo";

const PARAMS_MAIN: ParameterSpec[] = [
  { name: "branchApp", type: "string", default: "main", required: false, scope: "provider" },
  { name: "limparDados", type: "boolean", default: true, required: false, scope: "provider" },
];
const PARAMS_TESTES: ParameterSpec[] = [
  ...PARAMS_MAIN,
  { name: "navegador", type: "enum", options: ["chromium", "firefox"], default: "chromium", required: false, scope: "provider" },
];

const CAPS: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  read: { ...NO_CAPABILITIES.read, pipelines: true, parameters: true, runs: true, definition: true },
  write: { ...NO_CAPABILITIES.write, triggerRun: true },
};

/** Conector em memória: aceita GOOD_PAT e OTHER_PAT; qualquer outra credencial é recusada. */
function fakeConnector() {
  const seen: ConnectionContext[] = [];
  const state = { failNext: false };
  const guard = (conn: ConnectionContext) => {
    seen.push(conn);
    if (state.failNext) {
      state.failNext = false;
      throw new ProviderError("unavailable", "fora do ar");
    }
    if (conn.credential.value !== GOOD_PAT && conn.credential.value !== OTHER_PAT) throw new ProviderError("auth", "recusada");
  };
  const connector: PipelineConnector = {
    kind: "fake-ci",
    contractVersion: CONNECTOR_CONTRACT_VERSION,
    capabilities: async () => CAPS,
    async testConnection(conn) {
      seen.push(conn);
      if (conn.endpoint !== ENDPOINT) throw new ProviderError("invalid", "endpoint fora do provedor");
      return conn.credential.value === GOOD_PAT || conn.credential.value === OTHER_PAT
        ? { ok: true, identity: "conta de serviço", missingPermissions: [] }
        : { ok: false, missingPermissions: [], message: "credencial recusada pelo provedor" };
    },
    async listPipelines(conn) {
      guard(conn);
      return {
        items: [
          { externalId: "proj-1/381", name: "testes-e2e", path: "Corporate" },
          { externalId: "proj-1/187", name: "imagem", path: "Corporate" },
        ],
      };
    },
    async getPipeline(conn, externalId) {
      guard(conn);
      if (!["proj-1/381", "proj-1/187"].includes(externalId)) throw new ProviderError("not-found", "não existe");
      return { externalId, name: externalId === "proj-1/381" ? "testes-e2e" : "imagem", defaultRef: "refs/heads/main", revision: "5" };
    },
    async getParameters(conn, _externalId, ref) {
      guard(conn);
      return ref === "refs/heads/testes-maquina" ? PARAMS_TESTES : PARAMS_MAIN;
    },
    async getDefinition(conn) {
      guard(conn);
      return { revision: "commit-aaa", format: "yaml", content: "parameters: []", path: "/azure-pipelines.yml" };
    },
    triggerRun: () => Promise.reject(new NotSupportedError("triggerRun", "não usado aqui")),
    getRun: () => Promise.reject(new NotSupportedError("getRun", "não usado aqui")),
    listRuns: () => Promise.reject(new NotSupportedError("listRuns", "não usado aqui")),
  };
  return { connector, seen, state };
}

async function expectError(p: Promise<unknown>, code: DomainError["code"]): Promise<DomainError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("onboarding de pipelines (incremento 2)", () => {
  let t: TestDatabase;
  let foundation: FoundationService;
  let svc: OnboardingService;
  let fake: ReturnType<typeof fakeConnector>;
  let admin: Actor;
  let operator: Actor;
  let outsider: Actor; // admin de outra organização
  let projectId: string;
  let otherProjectId: string;

  async function loginAs(email: string) {
    return (await foundation.login({ email, password: PASSWORD }, meta)).actor;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    foundation = new FoundationService(t.db, { argon2: FAST_ARGON2 });
    fake = fakeConnector();
    const registry = new ConnectorRegistry();
    registry.register(fake.connector);
    const secrets = new EnvelopeSecretStore(t.db, parseMasterKey(Buffer.alloc(32, 9).toString("base64")));
    svc = new OnboardingService(t.db, foundation, secrets, registry);

    const boot = await foundation.bootstrapInstance(
      { adminEmail: "root@exemplo.test", adminName: "Root", organizationName: "Acme", organizationSlug: "acme" },
      meta,
    );
    await foundation.completePasswordReset({ token: boot.link.token, password: PASSWORD }, meta);
    admin = await loginAs("root@exemplo.test");
    const ws = await foundation.createWorkspace(admin, { name: "Qualidade" }, meta);
    projectId = (await foundation.createProject(admin, { workspaceId: ws.id, name: "Corporate" }, meta)).id;
    otherProjectId = (await foundation.createProject(admin, { workspaceId: ws.id, name: "Mobile" }, meta)).id;

    const link = await foundation.inviteMember(admin, { email: "op@exemplo.test", role: "operator", displayName: "Op" }, meta);
    await foundation.acceptInvite({ token: link.token, password: PASSWORD }, meta);
    operator = await loginAs("op@exemplo.test");

    const other = await foundation.createOrganization(admin, { name: "Outra", slug: "outra" }, meta);
    outsider = await foundation.switchOrganization(await loginAs("root@exemplo.test"), other.id, meta);
  });

  afterAll(async () => {
    await t?.drop();
  });

  let integrationId: string;
  let pipelineId: string;

  describe("integração (CA-002, CA-003)", () => {
    it("credencial recusada não vira integração e o erro é compreensível (CA-003)", async () => {
      const error = await expectError(
        svc.createIntegration(admin, { kind: "fake-ci", name: "Azure", endpoint: ENDPOINT, credential: "pat-errado" }, meta),
        "invalid",
      );
      expect(error.message).toBe("credencial recusada pelo provedor");
      expect(await svc.listIntegrations(admin)).toEqual([]);
    });

    it("endpoint fora do provedor é recusado antes de guardar", async () => {
      const error = await expectError(
        svc.createIntegration(admin, { kind: "fake-ci", name: "Azure", endpoint: "https://evil.example", credential: GOOD_PAT }, meta),
        "invalid",
      );
      expect(error.message).toContain("endpoint");
    });

    it("operador não cadastra integração", async () => {
      await expectError(
        svc.createIntegration(operator, { kind: "fake-ci", name: "Azure", endpoint: ENDPOINT, credential: GOOD_PAT }, meta),
        "forbidden",
      );
    });

    it("credencial válida cria a integração já testada (CA-002)", async () => {
      const { integration, check } = await svc.createIntegration(
        admin,
        { kind: "fake-ci", name: "Azure", endpoint: ENDPOINT, credential: GOOD_PAT },
        meta,
      );
      integrationId = integration.id;
      expect(check).toEqual({ ok: true, identity: "conta de serviço", missingPermissions: [] });
      expect(integration).toMatchObject({ kind: "fake-ci", name: "Azure", status: "ok", credentialKind: "pat" });
    });

    it("a credencial nunca aparece em resposta, auditoria ou em texto claro no navegador (RN-017)", async () => {
      const view = JSON.stringify(await svc.getIntegration(admin, integrationId));
      expect(view).not.toContain(GOOD_PAT);
      expect(view).not.toContain("ciphertext");
      const { rows } = await t.admin.query(`SELECT credential::text AS c FROM integrations_integrations`);
      expect(rows[0].c).not.toContain(GOOD_PAT);
      const audit = await t.admin.query(`SELECT details::text AS d FROM audit_events WHERE action LIKE 'integration.%'`);
      expect(audit.rows.length).toBeGreaterThan(0);
      for (const r of audit.rows) expect(r.d).not.toContain("pat-");
      const keys = await t.admin.query(`SELECT wrapped_key::text AS k FROM integrations_data_keys`);
      expect(keys.rows).toHaveLength(1);
    });

    it("nome repetido é conflito", async () => {
      await expectError(
        svc.createIntegration(admin, { kind: "fake-ci", name: "azure", endpoint: ENDPOINT, credential: GOOD_PAT }, meta),
        "conflict",
      );
    });

    it("trocar por credencial recusada mantém a antiga; trocar por válida passa a usar a nova", async () => {
      await expectError(svc.rotateCredential(admin, integrationId, { credential: "pat-revogado" }, meta), "invalid");
      expect((await svc.testIntegration(admin, integrationId, meta)).ok).toBe(true);
      expect(fake.seen.at(-1)!.credential.value).toBe(GOOD_PAT);

      await svc.rotateCredential(admin, integrationId, { credential: OTHER_PAT }, meta);
      await svc.testIntegration(admin, integrationId, meta);
      expect(fake.seen.at(-1)!.credential.value).toBe(OTHER_PAT);
    });

    it("outra organização não enxerga a integração (RLS)", async () => {
      expect(await svc.listIntegrations(outsider)).toEqual([]);
      await expectError(svc.getIntegration(outsider, integrationId), "not-found");
      await expectError(svc.discoverPipelines(outsider, integrationId, {}, meta), "not-found");
    });
  });

  describe("descoberta e vínculo (CA-004, CA-030)", () => {
    it("descobre as pipelines do provedor", async () => {
      const page = await svc.discoverPipelines(admin, integrationId, {}, meta);
      expect(page.items.map((p) => [p.externalId, p.linkedProjectIds])).toEqual([
        ["proj-1/381", []],
        ["proj-1/187", []],
      ]);
    });

    it("importa a pipeline para o projeto, lendo os parâmetros na branch pedida (CA-004)", async () => {
      const detail = await svc.importPipeline(
        admin,
        { projectId, integrationId, externalId: "proj-1/381", ref: "refs/heads/testes-maquina" },
        meta,
      );
      pipelineId = detail.pipeline.id;
      expect(detail.pipeline).toMatchObject({
        projectId,
        name: "testes-e2e",
        parametersRef: "refs/heads/testes-maquina",
        externalRevision: "5",
        definitionRevision: "commit-aaa",
        syncState: "synchronized",
        currentVersion: 1,
      });
      expect(detail.manifest).toMatchObject({ version: 1, source: "discovery" });
      expect(detail.manifest.manifest.parameters.map((p) => p.name)).toEqual(["branchApp", "limparDados", "navegador"]);
      expect(detail.manifest.manifest.review).toEqual({ status: "draft", requiresHumanApproval: true });
      expect(detail.problems).toEqual([]);
    });

    it("a descoberta marca o que já está vinculado; importar de novo no mesmo projeto é conflito", async () => {
      const page = await svc.discoverPipelines(admin, integrationId, {}, meta);
      expect(page.items[0]!.linkedProjectIds).toEqual([projectId]);
      await expectError(svc.importPipeline(admin, { projectId, integrationId, externalId: "proj-1/381" }, meta), "conflict");
    });

    it("pipeline inexistente no provedor é não encontrada", async () => {
      await expectError(svc.importPipeline(admin, { projectId, integrationId, externalId: "proj-1/999" }, meta), "not-found");
    });

    it("leitor e operador consultam a definição sincronizada (CA-030)", async () => {
      const detail = await svc.getPipelineDetail(operator, pipelineId);
      expect(detail.pipeline.capabilities.write.triggerRun).toBe(true);
      expect(detail.integration).toEqual({ id: integrationId, name: "Azure", kind: "fake-ci", status: "ok" });
      expect(await svc.listLinkedPipelines(operator, { projectId })).toHaveLength(1);
    });

    it("operador não importa sem política que permita configurar pipelines", async () => {
      await expectError(svc.importPipeline(operator, { projectId: otherProjectId, integrationId, externalId: "proj-1/381" }, meta), "forbidden");
    });

    it("sincronização com falha guarda o dado e marca como desconhecido (RNF-025)", async () => {
      fake.state.failNext = true;
      await expectError(svc.syncPipeline(admin, pipelineId, {}, meta), "provider");
      const detail = await svc.getPipelineDetail(admin, pipelineId);
      expect(detail.pipeline).toMatchObject({ syncState: "unknown", name: "testes-e2e" });
      expect(detail.pipeline.syncProblem).toContain("não respondeu");

      const synced = await svc.syncPipeline(admin, pipelineId, {}, meta);
      expect(synced.pipeline).toMatchObject({ syncState: "synchronized", syncProblem: null, parametersRef: "refs/heads/testes-maquina" });
    });

    it("não arquiva integração em uso", async () => {
      await expectError(svc.setIntegrationArchived(admin, integrationId, true, meta), "conflict");
    });

    it("outra organização não enxerga a pipeline (RLS)", async () => {
      await expectError(svc.getPipelineDetail(outsider, pipelineId), "not-found");
      expect(await svc.listLinkedPipelines(outsider)).toEqual([]);
    });
  });

  describe("manifesto versionado (CA-026)", () => {
    async function current(): Promise<PipelineManifest> {
      return (await svc.getPipelineDetail(admin, pipelineId)).manifest.manifest;
    }

    it("salva uma versão nova pelo formulário, sem IA, e guarda o histórico", async () => {
      const m = await current();
      const edited: PipelineManifest = {
        ...m,
        parameters: m.parameters.map((p) => (p.name === "branchApp" ? { ...p, label: "Branch da aplicação", required: true } : p)),
        validationRules: [
          {
            id: "smoke-so-chromium",
            message: "Limpeza só no Chromium",
            when: { parameter: "limparDados", equals: true },
            then: { parameter: "navegador", in: ["chromium"] },
          },
        ],
      };
      const detail = await svc.saveManifest(admin, pipelineId, { manifest: edited, expectedVersion: 1, note: "regra do smoke" }, meta);
      expect(detail.manifest).toMatchObject({ version: 2, source: "manual", note: "regra do smoke" });
      expect(detail.pipeline.currentVersion).toBe(2);

      const history = await svc.listManifestVersions(admin, pipelineId);
      expect(history.map((v) => [v.version, v.source])).toEqual([
        [2, "manual"],
        [1, "discovery"],
      ]);
      expect((await svc.getManifestVersion(admin, pipelineId, 1)).manifest.validationRules).toEqual([]);
    });

    it("recusa salvar sobre uma versão que outra pessoa já alterou", async () => {
      const error = await expectError(svc.saveManifest(admin, pipelineId, { manifest: await current(), expectedVersion: 1 }, meta), "conflict");
      expect(error.details).toEqual({ currentVersion: 2 });
    });

    it("recusa parâmetro que o provedor não declara (o disparo seria recusado)", async () => {
      const m = await current();
      const bad = { ...m, parameters: [...m.parameters, { name: "naoExiste", type: "string", required: false, scope: "provider" }] };
      const error = await expectError(svc.saveManifest(admin, pipelineId, { manifest: bad, expectedVersion: 2 }, meta), "invalid");
      expect(error.details?.problems).toEqual([expect.objectContaining({ parameter: "naoExiste", severity: "error" })]);
    });

    it("recusa trocar a pipeline externa ou o projeto pelo manifesto", async () => {
      const m = await current();
      const error = await expectError(
        svc.saveManifest(admin, pipelineId, { manifest: { ...m, pipeline: { ...m.pipeline, externalId: "proj-1/187" } }, expectedVersion: 2 }, meta),
        "invalid",
      );
      expect(error.details).toEqual({ fields: ["pipeline.externalId"] });
    });

    it("recusa manifesto fora do esquema com a lista de problemas", async () => {
      const error = await expectError(svc.saveManifest(admin, pipelineId, { manifest: { schemaVersion: "9" }, expectedVersion: 2 }, meta), "invalid");
      expect(Array.isArray(error.details?.issues)).toBe(true);
    });
  });

  describe("importação de manifesto (CA-040)", () => {
    async function exported(): Promise<PipelineManifest> {
      return (await svc.getPipelineDetail(admin, pipelineId)).manifest.manifest;
    }

    it("pede a integração (com credencial) quando o manifesto cita uma que não existe", async () => {
      const m = { ...(await exported()), provider: { kind: "fake-ci", integrationRef: "Azure de outra instalação" } };
      const error = await expectError(svc.importManifest(admin, { projectId: otherProjectId, manifest: m }, meta), "conflict");
      expect(error.details).toEqual({ missingIntegration: "Azure de outra instalação", kind: "fake-ci" });
    });

    it("manifesto exportado não leva credencial", async () => {
      const text = JSON.stringify(await exported());
      expect(text).not.toContain("pat-");
      expect(text).not.toContain("credential");
    });

    it("importa para outro projeto, reescreve as referências e volta para rascunho", async () => {
      const m = { ...(await exported()), projectRef: "projeto-da-outra-instalacao", review: { status: "approved" as const, requiresHumanApproval: false } };
      const result = await svc.importManifest(admin, { projectId: otherProjectId, manifest: m, ref: "refs/heads/testes-maquina" }, meta);
      expect(result.rewritten).toEqual([{ field: "projectRef", from: "projeto-da-outra-instalacao", to: otherProjectId }]);
      expect(result.detail.pipeline.projectId).toBe(otherProjectId);
      expect(result.detail.manifest).toMatchObject({ version: 1, source: "import" });
      expect(result.detail.manifest.manifest.review).toEqual({ status: "draft", requiresHumanApproval: true });
      expect(result.detail.manifest.manifest.validationRules).toHaveLength(1);
    });
  });

  it("o segredo de uma organização não abre com o contexto de outra", async () => {
    const secrets = new EnvelopeSecretStore(t.db, parseMasterKey(Buffer.alloc(32, 9).toString("base64")));
    const sealed = await secrets.seal(admin.organization!.id, "segredo-da-acme");
    expect(await secrets.open(admin.organization!.id, sealed)).toBe("segredo-da-acme");
    await expect(secrets.open(outsider.organization!.id, sealed)).rejects.toThrow();
  });

  it("chave mestra diferente não abre as chaves de dados guardadas", async () => {
    const wrong = new EnvelopeSecretStore(t.db, parseMasterKey(Buffer.alloc(32, 3).toString("base64")));
    const sealed = await new EnvelopeSecretStore(t.db, parseMasterKey(Buffer.alloc(32, 9).toString("base64"))).seal(admin.organization!.id, "x");
    await expect(wrong.open(admin.organization!.id, sealed)).rejects.toThrow("SECRETS_MASTER_KEY");
  });
});
