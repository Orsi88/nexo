import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OnboardingService } from "@painel/core";
import { actorOf, IdParams, parse, requestMeta as meta } from "./foundation.ts";

// Rotas do incremento 2: integrações, descoberta, vínculo de pipelines e manifesto versionado.
// Sessão, CSRF, origem e tradução de erros vêm do registro da fundação (mesmo servidor).
// A credencial entra só no corpo de POST/PUT e nunca sai em nenhuma resposta (RN-017).

const IntegrationCreate = z.object({
  kind: z.string().max(40),
  name: z.string().max(120),
  endpoint: z.string().max(300),
  credential: z.string().max(2048),
});
const CredentialBody = z.object({ credential: z.string().max(2048) });
const NameBody = z.object({ name: z.string().max(120) });
const Archived = z.object({ includeArchived: z.enum(["true", "false"]).optional() });
const DiscoverQuery = z.object({ cursor: z.string().max(200).optional(), q: z.string().max(100).optional() });
const ImportBody = z.object({
  projectId: z.uuid(),
  integrationId: z.uuid(),
  externalId: z.string().max(200),
  ref: z.string().max(200).optional(),
});
const PipelineList = z.object({
  projectId: z.uuid().optional(),
  q: z.string().max(120).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const SyncBody = z.object({ ref: z.string().max(200).optional() });
const ManifestBody = z.object({ manifest: z.unknown(), expectedVersion: z.number().int(), note: z.string().max(500).optional() });
const ManifestImport = z.object({ projectId: z.uuid(), manifest: z.unknown(), ref: z.string().max(200).optional() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });
// Incremento 4: arquivo da pipeline. O YAML pode passar dos 64 KB padrão do corpo.
const DEFINITION_BODY = { bodyLimit: 600 * 1024 };
const RefQuery = z.object({ ref: z.string().max(200).optional() });
const DefinitionPreview = z.object({ content: z.string().max(520 * 1024), ref: z.string().max(200).optional() });
const DefinitionApply = z.object({
  content: z.string().max(520 * 1024),
  expectedRevision: z.string().max(200),
  mode: z.enum(["commit", "pull-request"]),
  message: z.string().max(2000).optional(),
  ref: z.string().max(200).optional(),
});
const TemplateRender = z.object({ integrationId: z.uuid(), templateId: z.string().max(60), name: z.string().max(120), values: z.record(z.string(), z.unknown()).optional() });
const PipelineCreate = z.object({
  projectId: z.uuid(),
  integrationId: z.uuid(),
  repositoryId: z.string().max(300),
  branch: z.string().max(200),
  path: z.string().max(300),
  name: z.string().max(120),
  content: z.string().max(520 * 1024),
  mode: z.enum(["commit", "pull-request"]),
  message: z.string().max(2000).optional(),
});

export function registerOnboardingRoutes(app: FastifyInstance, svc: OnboardingService): void {
  app.get("/api/connectors", async () => ({ items: svc.connectorKinds() }));

  // ===== Integrações =====
  app.get("/api/integrations", async (req) => {
    const q = parse(Archived, req.query);
    return { items: await svc.listIntegrations(actorOf(req), q.includeArchived === "true") };
  });
  app.post("/api/integrations", async (req, reply) => {
    const body = parse(IntegrationCreate, req.body);
    return reply.code(201).send(await svc.createIntegration(actorOf(req), body, meta(req)));
  });
  app.get("/api/integrations/:id", async (req) => svc.getIntegration(actorOf(req), parse(IdParams, req.params).id));
  app.patch("/api/integrations/:id", async (req) =>
    svc.renameIntegration(actorOf(req), parse(IdParams, req.params).id, parse(NameBody, req.body), meta(req)),
  );
  app.post("/api/integrations/:id/test", async (req) => svc.testIntegration(actorOf(req), parse(IdParams, req.params).id, meta(req)));
  app.put("/api/integrations/:id/credential", async (req) =>
    svc.rotateCredential(actorOf(req), parse(IdParams, req.params).id, parse(CredentialBody, req.body), meta(req)),
  );
  app.post("/api/integrations/:id/archive", async (req) =>
    svc.setIntegrationArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)),
  );
  app.post("/api/integrations/:id/unarchive", async (req) =>
    svc.setIntegrationArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );
  // Descoberta das pipelines do provedor (uma página por chamada).
  app.get("/api/integrations/:id/discover", async (req) => {
    const q = parse(DiscoverQuery, req.query);
    return svc.discoverPipelines(
      actorOf(req),
      parse(IdParams, req.params).id,
      { ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.q ? { search: q.q } : {}) },
      meta(req),
    );
  });

  // ===== Pipelines vinculadas =====
  app.get("/api/pipelines", async (req) => {
    const q = parse(PipelineList, req.query);
    return {
      items: await svc.listLinkedPipelines(actorOf(req), {
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.q ? { q: q.q } : {}),
        includeArchived: q.includeArchived === "true",
      }),
    };
  });
  app.post("/api/pipelines", async (req, reply) => {
    const body = parse(ImportBody, req.body);
    return reply.code(201).send(await svc.importPipeline(actorOf(req), body, meta(req)));
  });
  app.get("/api/pipelines/:id", async (req) => svc.getPipelineDetail(actorOf(req), parse(IdParams, req.params).id));
  app.post("/api/pipelines/:id/sync", async (req) =>
    svc.syncPipeline(actorOf(req), parse(IdParams, req.params).id, parse(SyncBody, req.body), meta(req)),
  );
  app.post("/api/pipelines/:id/archive", async (req) => svc.setPipelineArchived(actorOf(req), parse(IdParams, req.params).id, true, meta(req)));
  app.post("/api/pipelines/:id/unarchive", async (req) =>
    svc.setPipelineArchived(actorOf(req), parse(IdParams, req.params).id, false, meta(req)),
  );

  // ===== Manifesto =====
  app.get("/api/pipelines/:id/manifest/versions", async (req) => ({
    items: await svc.listManifestVersions(actorOf(req), parse(IdParams, req.params).id),
  }));
  app.get("/api/pipelines/:id/manifest/versions/:version", async (req) => {
    const p = parse(VersionParams, req.params);
    return svc.getManifestVersion(actorOf(req), p.id, p.version);
  });
  app.put("/api/pipelines/:id/manifest", async (req) =>
    svc.saveManifest(actorOf(req), parse(IdParams, req.params).id, parse(ManifestBody, req.body), meta(req)),
  );
  // ===== Arquivo da pipeline e criação por modelo (incremento 4) =====
  app.get("/api/pipelines/:id/definition", async (req) =>
    svc.getDefinition(actorOf(req), parse(IdParams, req.params).id, parse(RefQuery, req.query), meta(req)),
  );
  app.post("/api/pipelines/:id/definition/preview", DEFINITION_BODY, async (req) =>
    svc.previewDefinitionChange(actorOf(req), parse(IdParams, req.params).id, parse(DefinitionPreview, req.body), meta(req)),
  );
  app.post("/api/pipelines/:id/definition", DEFINITION_BODY, async (req) =>
    svc.applyDefinitionChange(actorOf(req), parse(IdParams, req.params).id, parse(DefinitionApply, req.body), meta(req)),
  );
  app.get("/api/integrations/:id/repositories", async (req) => ({
    items: await svc.listRepositories(actorOf(req), parse(IdParams, req.params).id, meta(req)),
  }));
  app.get("/api/pipeline-templates", async (req) => ({ items: await svc.pipelineTemplates(actorOf(req)) }));
  app.post("/api/pipeline-templates/render", async (req) => svc.renderPipelineTemplate(actorOf(req), parse(TemplateRender, req.body)));
  app.post("/api/pipelines/create", DEFINITION_BODY, async (req, reply) =>
    reply.code(201).send(await svc.createPipeline(actorOf(req), parse(PipelineCreate, req.body), meta(req))),
  );
  app.post("/api/pipelines/import-manifest", async (req, reply) => {
    const body = parse(ManifestImport, req.body);
    return reply.code(201).send(await svc.importManifest(actorOf(req), body, meta(req)));
  });
}
