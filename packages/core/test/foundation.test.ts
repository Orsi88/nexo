import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError, FoundationService, type Actor, type RequestMeta } from "../src/index.ts";
import { createTestDatabase, FAST_ARGON2, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "../src/testing.ts";

// Incremento 1 (Fundação) contra PostgreSQL real, com RLS ativa: CA-001, CA-020, CA-024, RNF-026, RF-140.

const meta: RequestMeta = { correlationId: "test", ip: "127.0.0.1" };
const PASSWORD = "senha-forte-de-teste-1";

async function expectError(p: Promise<unknown>, code: DomainError["code"]) {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("fundação (incremento 1)", () => {
  let t: TestDatabase;
  let svc: FoundationService;
  let root: Actor; // admin da instância e da organização "acme"
  let acmeId: string;

  async function loginAs(email: string, password = PASSWORD) {
    return (await svc.login({ email, password }, meta)).actor;
  }

  /** Convida, aceita com senha e entra. */
  async function newMember(by: Actor, email: string, role: string) {
    const link = await svc.inviteMember(by, { email, role, displayName: email }, meta);
    await svc.acceptInvite({ token: link.token, password: PASSWORD }, meta);
    return loginAs(email);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    svc = new FoundationService(t.db, { argon2: FAST_ARGON2 });
    const boot = await svc.bootstrapInstance(
      { adminEmail: "root@exemplo.test", adminName: "Root", organizationName: "Acme", organizationSlug: "acme" },
      meta,
    );
    acmeId = boot.organizationId;
    await svc.completePasswordReset({ token: boot.link.token, password: PASSWORD }, meta);
    root = await loginAs("root@exemplo.test");
  });

  afterAll(async () => {
    await t?.drop();
  });

  describe("instalação e login", () => {
    it("o bootstrap cria admin da instância e admin da primeira organização", () => {
      expect(root.user.isInstanceAdmin).toBe(true);
      expect(root.organization).toMatchObject({ id: acmeId, role: "admin", slug: "acme" });
    });

    it("o bootstrap só roda uma vez", async () => {
      await expectError(
        svc.bootstrapInstance({ adminEmail: "x@exemplo.test", adminName: "X", organizationName: "X", organizationSlug: "x" }, meta),
        "conflict",
      );
    });

    it("o link de definição de senha é de uso único", async () => {
      const link = await svc.issuePasswordReset(root, { email: "root@exemplo.test" }, meta);
      await svc.completePasswordReset({ token: link.token, password: PASSWORD }, meta);
      await expectError(svc.completePasswordReset({ token: link.token, password: PASSWORD }, meta), "invalid");
    });

    it("senha errada e e-mail inexistente recebem a mesma resposta", async () => {
      const a = await svc.login({ email: "root@exemplo.test", password: "errada-errada" }, meta).catch((e: Error) => e.message);
      const b = await svc.login({ email: "ninguem@exemplo.test", password: "errada-errada" }, meta).catch((e: Error) => e.message);
      expect(a).toBe(b);
    });

    it("bloqueia a conta depois de 5 falhas seguidas, mesmo com a senha certa (RNF-026)", async () => {
      await newMember(root, "alvo@exemplo.test", "reader");
      for (let i = 0; i < 5; i++) await expectError(svc.login({ email: "alvo@exemplo.test", password: "chute-errado" }, meta), "unauthenticated");
      await expectError(svc.login({ email: "alvo@exemplo.test", password: PASSWORD }, meta), "unauthenticated");
    });

    it("senha curta é recusada", async () => {
      await expectError(svc.changePassword(root, { currentPassword: PASSWORD, newPassword: "curta" }, meta), "invalid");
    });

    it("trocar a senha encerra as outras sessões (RF-132)", async () => {
      const u = await newMember(root, "troca@exemplo.test", "reader");
      const { token: other } = await svc.login({ email: "troca@exemplo.test", password: PASSWORD }, meta);
      await svc.changePassword(u, { currentPassword: PASSWORD, newPassword: "outra-senha-forte-2" }, meta);
      expect(await svc.resolveSession(other)).toBeUndefined();
    });

    it("logout invalida o token", async () => {
      const { token, actor } = await svc.login({ email: "root@exemplo.test", password: PASSWORD }, meta);
      expect(await svc.resolveSession(token)).toBeDefined();
      await svc.logout(actor, meta);
      expect(await svc.resolveSession(token)).toBeUndefined();
    });
  });

  describe("organizações e isolamento", () => {
    let globexId: string;
    let globexProjectId: string;

    beforeAll(async () => {
      const globex = await svc.createOrganization(root, { name: "Globex", slug: "globex" }, meta);
      globexId = globex.id;
      const inGlobex = await svc.switchOrganization(root, globexId, meta);
      const ws = await svc.createWorkspace(inGlobex, { name: "Sistemas" }, meta);
      globexProjectId = (await svc.createProject(inGlobex, { workspaceId: ws.id, name: "Secreto" }, meta)).id;
      root = await svc.switchOrganization(inGlobex, acmeId, meta);
    });

    it("CA-001: a organização criada fica isolada das demais", async () => {
      const ws = await svc.listWorkspaces(root);
      expect(ws.every((w) => w.organizationId === acmeId)).toBe(true);
      expect((await svc.listProjects(root)).map((p) => p.name)).not.toContain("Secreto");
    });

    it("só o admin da instância cria organizações", async () => {
      const admin = await newMember(root, "admin2@exemplo.test", "admin");
      await expectError(svc.createOrganization(admin, { name: "Nova", slug: "nova" }, meta), "forbidden");
    });

    it("identificador de organização é único", async () => {
      await expectError(svc.createOrganization(root, { name: "Outra Acme", slug: "acme" }, meta), "conflict");
    });

    it("CA-020: usuário de outra organização recebe 404 e a tentativa é auditada", async () => {
      const outsider = await newMember(root, "fora@exemplo.test", "admin");
      await expectError(svc.getProject(outsider, globexProjectId), "not-found");
      await expectError(svc.switchOrganization(outsider, globexId, meta), "not-found");
      const { rows } = await t.admin.query(
        `SELECT outcome FROM audit_events WHERE action = 'session.organization.switch' AND actor_user_id = $1`,
        [outsider.user.id],
      );
      expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    });

    it("CA-024: trocar de organização atualiza dados e papel", async () => {
      const link = await svc.switchOrganization(root, globexId, meta).then(async (g) => {
        const l = await svc.inviteMember(g, { email: "duplo@exemplo.test", role: "reader" }, meta);
        root = await svc.switchOrganization(g, acmeId, meta);
        return l;
      });
      await svc.acceptInvite({ token: link.token, password: PASSWORD }, meta);
      const inAcmeLink = await svc.inviteMember(root, { email: "duplo@exemplo.test", role: "manager" }, meta);
      let duplo = await loginAs("duplo@exemplo.test");
      await svc.acceptInvite({ token: inAcmeLink.token }, meta, duplo);

      expect((await svc.listMyOrganizations(duplo)).map((o) => [o.slug, o.role])).toEqual([
        ["acme", "manager"],
        ["globex", "reader"],
      ]);
      duplo = await svc.switchOrganization(duplo, globexId, meta);
      expect(duplo.organization?.role).toBe("reader");
      expect((await svc.listProjects(duplo)).map((p) => p.name)).toEqual(["Secreto"]);
      await expectError(svc.createWorkspace(duplo, { name: "x" }, meta), "forbidden");
      duplo = await svc.switchOrganization(duplo, acmeId, meta);
      expect(duplo.organization?.role).toBe("manager");
      expect((await svc.listProjects(duplo)).map((p) => p.name)).not.toContain("Secreto");
    });

    it("conta existente só aceita convite autenticada como ela mesma", async () => {
      const link = await svc.inviteMember(root, { email: "admin2@exemplo.test", role: "reader" }, meta).catch(() => undefined);
      expect(link).toBeUndefined(); // já é membro
      const g = await svc.switchOrganization(root, globexId, meta);
      const l2 = await svc.inviteMember(g, { email: "admin2@exemplo.test", role: "reader" }, meta);
      root = await svc.switchOrganization(g, acmeId, meta);
      await expectError(svc.acceptInvite({ token: l2.token }, meta), "forbidden");
      await expectError(svc.acceptInvite({ token: l2.token }, meta, root), "forbidden");
    });
  });

  describe("papéis e membros", () => {
    it("leitor vê, mas não cria; a negação é auditada (RN-003, RF-139)", async () => {
      const reader = await newMember(root, "leitor@exemplo.test", "reader");
      expect(Array.isArray(await svc.listWorkspaces(reader))).toBe(true);
      await expectError(svc.createWorkspace(reader, { name: "Nada" }, meta), "forbidden");
      const { rows } = await t.admin.query(
        `SELECT outcome FROM audit_events WHERE action = 'workspace.create' AND actor_user_id = $1`,
        [reader.user.id],
      );
      expect(rows).toEqual([{ outcome: "denied" }]);
    });

    it("leitor não vê e-mails dos membros; admin vê", async () => {
      const reader = await loginAs("leitor@exemplo.test");
      expect((await svc.listMembers(reader)).every((m) => m.email === undefined)).toBe(true);
      expect((await svc.listMembers(root)).some((m) => m.email === "root@exemplo.test")).toBe(true);
    });

    it("gestor só gerencia usuários se a política permitir, e nunca concede admin", async () => {
      let manager = await newMember(root, "gestor@exemplo.test", "manager");
      await expectError(svc.inviteMember(manager, { email: "a@exemplo.test", role: "reader" }, meta), "forbidden");
      await svc.updateAccessPolicy(root, { manager: ["manageUsers"], reader: ["execute"] }, meta);
      expect(await svc.getAccessPolicy(root)).toEqual({ manager: ["manageUsers"] }); // "execute" do leitor não é "conforme política"
      manager = await loginAs("gestor@exemplo.test");
      await svc.inviteMember(manager, { email: "b@exemplo.test", role: "operator" }, meta);
      await expectError(svc.inviteMember(manager, { email: "c@exemplo.test", role: "admin" }, meta), "forbidden");
      await expectError(svc.changeMemberRole(manager, root.user.id, "reader", meta), "forbidden");
    });

    it("a organização nunca fica sem admin", async () => {
      const { organization } = root;
      const solo = await svc.createOrganization(root, { name: "Solo", slug: "solo" }, meta);
      const inSolo = await svc.switchOrganization(root, solo.id, meta);
      await expectError(svc.changeMemberRole(inSolo, root.user.id, "reader", meta), "conflict");
      await expectError(svc.removeMember(inSolo, root.user.id, meta), "conflict");
      root = await svc.switchOrganization(inSolo, organization!.id, meta);
    });

    it("RF-140: remover o membro corta o acesso na hora, sem esperar a sessão expirar", async () => {
      const { token, actor } = await svc.login({ email: "leitor@exemplo.test", password: PASSWORD }, meta);
      expect(actor.organization?.id).toBe(acmeId);
      await svc.removeMember(root, actor.user.id, meta);
      const after = await svc.resolveSession(token);
      expect(after?.organization).toBeUndefined();
      await expectError(svc.listProjects(after!), "conflict");
    });
  });

  describe("workspaces e projetos", () => {
    it("cria, busca, renomeia e arquiva com as regras de nome e de projetos ativos (RF-002, RF-003, RF-007)", async () => {
      const ws = await svc.createWorkspace(root, { name: "Qualidade" }, meta);
      await expectError(svc.createWorkspace(root, { name: "qualidade" }, meta), "conflict");
      const p = await svc.createProject(root, { workspaceId: ws.id, name: "Sistema Web" }, meta);
      expect((await svc.listWorkspaces(root, { q: "quali" })).map((w) => w.id)).toEqual([ws.id]);
      expect((await svc.listProjects(root, { workspaceId: ws.id, q: "web" })).map((x) => x.id)).toEqual([p.id]);

      await expectError(svc.setWorkspaceArchived(root, ws.id, true, meta), "conflict");
      await svc.setProjectArchived(root, p.id, true, meta);
      await svc.setWorkspaceArchived(root, ws.id, true, meta);
      await expectError(svc.createProject(root, { workspaceId: ws.id, name: "Novo" }, meta), "conflict");
      expect(await svc.listWorkspaces(root)).not.toContainEqual(expect.objectContaining({ id: ws.id }));
      expect(await svc.listWorkspaces(root, { includeArchived: true })).toContainEqual(expect.objectContaining({ id: ws.id }));
    });

    it("organização arquivada fica somente leitura até ser desarquivada", async () => {
      await svc.setOrganizationArchived(root, true, meta);
      root = await svc.switchOrganization(root, acmeId, meta);
      await expectError(svc.createWorkspace(root, { name: "Bloqueado" }, meta), "conflict");
      expect(Array.isArray(await svc.listProjects(root))).toBe(true);
      await svc.setOrganizationArchived(root, false, meta);
      root = await svc.switchOrganization(root, acmeId, meta);
      await svc.createWorkspace(root, { name: "Liberado" }, meta);
    });
  });

  describe("auditoria", () => {
    it("só quem pode consultar vê, e só da própria organização", async () => {
      const events = await svc.listAudit(root, { limit: 200 }, meta);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.organizationId === acmeId)).toBe(true);
      const operator = await newMember(root, "operador@exemplo.test", "operator");
      await expectError(svc.listAudit(operator, {}, meta), "forbidden");
    });

    it("nenhum token ou hash de senha vai para a auditoria (RNF-033)", async () => {
      const link = await svc.inviteMember(root, { email: "segredo@exemplo.test", role: "reader" }, meta);
      const { rows } = await t.admin.query(`SELECT details::text AS d FROM audit_events`);
      const all = rows.map((r) => r.d).join("\n");
      expect(all).not.toContain(link.token);
      expect(all).not.toContain("$argon2id$");
    });
  });
});
