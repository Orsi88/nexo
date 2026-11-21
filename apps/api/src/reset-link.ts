import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { Database, identity, recordAudit } from "@painel/core";

// Operação: gera um link de uso único para alguém definir uma senha nova, sem passar pela tela.
// Para quando ninguém consegue entrar (ex.: o administrador da instalação esqueceu a senha). Quem
// roda este comando já tem acesso ao servidor e ao banco; a ação fica na auditoria como "system".
// O link anterior ainda não usado, se houver, deixa de valer.
//
//   node apps/api/src/reset-link.ts --email pessoa@empresa.com

const { values } = parseArgs({ options: { email: { type: "string" } } });
const url = process.env.DATABASE_URL;
const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const ttlHours = Number(process.env.PASSWORD_RESET_TTL_HOURS ?? 24);
if (!url || !values.email) {
  console.error("Uso: DATABASE_URL=... node apps/api/src/reset-link.ts --email <e-mail>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const db = new Database(pool);
  const issued = await db.tx({}, async (sql) => {
    const user = await identity.getUserByEmail(sql, values.email!);
    if (!user || user.status === "disabled") return undefined;
    const link = await identity.issueOneTimeToken(sql, { kind: "password-reset", userId: user.id, createdBy: null, ttlHours });
    await recordAudit(sql, {
      organizationId: null,
      actorUserId: null,
      actorKind: "system",
      action: "auth.password.reset.issue",
      targetType: "user",
      targetId: user.id,
      outcome: "success",
      correlationId: `reset-link-${randomUUID()}`,
      details: { via: "cli" },
    });
    return link;
  });
  if (!issued) {
    console.error("Nenhum usuário ativo com esse e-mail.");
    process.exitCode = 1;
  } else {
    console.log(`Link para definir a senha (vale uma vez, até ${issued.expiresAt.toISOString()}):`);
    console.log(`  ${base}/redefinir-senha#token=${issued.token}`);
    console.log("Não compartilhe: quem tiver o link define a senha desta conta.");
  }
} finally {
  await pool.end();
}
