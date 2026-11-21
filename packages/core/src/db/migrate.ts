import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Pasta das migrações SQL versionadas (RNF-032). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Aplica, em ordem e cada uma numa transação, as migrações ainda não aplicadas.
 * Usa a conexão administrativa: o papel da aplicação (painel_app) não pode alterar o esquema.
 */
export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Impede duas instâncias de migrar ao mesmo tempo.
    await client.query("SELECT pg_advisory_lock(hashtext('painel.migrations'))");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migração ${file} falhou: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file);
      log(`migração aplicada: ${file}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('painel.migrations'))").catch(() => undefined);
    client.release();
  }
}
