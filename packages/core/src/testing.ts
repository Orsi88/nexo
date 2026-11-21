import { randomBytes } from "node:crypto";
import pg from "pg";
import { Database } from "./db/database.ts";
import { runMigrations } from "./db/migrate.ts";
import type { Argon2Params } from "./modules/identity/index.ts";

// Apoio a testes com PostgreSQL real (RNF-008). Cada chamada cria um banco novo, aplica as migrações
// e devolve um Database que assume o papel painel_app (sujeito a RLS), como a aplicação em produção.
// Precisa de TEST_DATABASE_ADMIN_URL apontando para um servidor descartável.

export const TEST_DATABASE_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;

/** Argon2 leve para testes; produção usa DEFAULT_ARGON2. */
export const FAST_ARGON2: Argon2Params = { memory: 1024, passes: 1, parallelism: 1 };

export interface TestDatabase {
  db: Database;
  /** Conexão administrativa ao banco de teste (dona das tabelas), para preparar e inspecionar dados. */
  admin: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(adminUrl = TEST_DATABASE_ADMIN_URL): Promise<TestDatabase> {
  if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL não definida");
  const name = `painel_t_${randomBytes(6).toString("hex")}`;
  const root = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 10 });
  await runMigrations(admin, undefined, () => undefined);
  return {
    db: new Database(admin, { role: "painel_app" }),
    admin,
    async drop() {
      await admin.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    },
  };
}
