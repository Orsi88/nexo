import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_DATABASE_ADMIN_URL, type TestDatabase } from "../src/testing.ts";

// Teste de isolamento entre organizações no banco (RNF-008, CA-020).
// Precisa de TEST_DATABASE_ADMIN_URL: o teste cria um banco próprio, temporário, e apaga no fim
// (nunca aplica as migrações no banco apontado pela URL).
// As verificações usam o código do erro (SQLSTATE), não o texto: o servidor pode responder em
// outro idioma (ex.: "a nova linha viola a política de segurança").
const INSUFFICIENT_PRIVILEGE = "42501";

describe.skipIf(!TEST_DATABASE_ADMIN_URL)("Row-Level Security entre organizações", () => {
  let t: TestDatabase;
  let pool: pg.Pool;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    t = await createTestDatabase();
    pool = t.admin;
    // Dados de teste criados pelo administrador (o dono das tabelas).
    // FORCE ROW LEVEL SECURITY vale também para o dono, então cada inserção define o tenant.
    for (const [org, name] of [[orgA, "A"], [orgB, "B"]] as const) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
        await c.query("INSERT INTO tenancy_organizations (id, slug, name) VALUES ($1, $2, $3)", [org, `org-${org}`, name]);
        const ws = await c.query<{ id: string }>(
          "INSERT INTO tenancy_workspaces (organization_id, name) VALUES ($1, 'ws') RETURNING id",
          [org],
        );
        await c.query("INSERT INTO tenancy_projects (organization_id, workspace_id, name) VALUES ($1, $2, $3)", [
          org,
          ws.rows[0]!.id,
          `projeto-${name}`,
        ]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  async function asApp<T>(org: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE painel_app");
      if (org) await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("a organização A só enxerga os próprios projetos", async () => {
    const rows = await asApp(orgA, async (c) => (await c.query("SELECT organization_id FROM tenancy_projects")).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
  });

  it("sem contexto de tenant, nada é visível", async () => {
    const rows = await asApp(null, async (c) => (await c.query("SELECT 1 FROM tenancy_projects")).rows);
    expect(rows).toEqual([]);
  });

  it("A não consegue gravar em nome de B", async () => {
    await expect(
      asApp(orgA, (c) => c.query("INSERT INTO tenancy_workspaces (organization_id, name) VALUES ($1, 'x')", [orgB])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("auditoria é append-only para a aplicação", async () => {
    await expect(asApp(orgA, (c) => c.query("DELETE FROM audit_events"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});
