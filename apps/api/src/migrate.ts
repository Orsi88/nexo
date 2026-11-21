import pg from "pg";
import { runMigrations } from "@painel/core";

// Passo "migrate" da instalação (RNF-032): roda antes de subir a versão nova da api e do worker.
// Usa a conexão administrativa (dona do esquema), nunca a da aplicação.

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL não definida");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `${applied.length} migração(ões) aplicada(s)` : "banco já atualizado");
} finally {
  await pool.end();
}
