import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { Database, DomainError, FoundationService } from "@painel/core";

// Primeiro acesso da instalação (ADR-011): cria o administrador da instância e a primeira organização
// e imprime um link de uso único para definir a senha. Recusa se a instalação já tiver administrador.
// Nenhuma senha passa por argumento ou variável de ambiente.
//
//   node apps/api/src/bootstrap.ts --email admin@empresa.com --name "Nome" --org "Empresa" --slug empresa

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    org: { type: "string" },
    slug: { type: "string" },
  },
});

const url = process.env.DATABASE_URL;
const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
if (!url) {
  console.error("DATABASE_URL não definida");
  process.exit(1);
}
if (!values.email || !values.name || !values.org || !values.slug) {
  console.error('Uso: bootstrap --email <e-mail> --name "<nome>" --org "<organização>" --slug <identificador>');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const svc = new FoundationService(new Database(pool), {
    passwordResetTtlHours: Number(process.env.PASSWORD_RESET_TTL_HOURS ?? 24),
  });
  const result = await svc.bootstrapInstance(
    { adminEmail: values.email, adminName: values.name, organizationName: values.org, organizationSlug: values.slug },
    { correlationId: `bootstrap-${randomUUID()}` },
  );
  console.log("Instalação preparada.");
  console.log(`Organização: ${values.org} (${result.organizationId})`);
  console.log(`Defina a senha do administrador em até ${result.link.expiresAt.toISOString()}:`);
  console.log(`  ${base}/redefinir-senha#token=${result.link.token}`);
  console.log("Enquanto a tela não existe, use a API:");
  console.log(`  POST ${base}/api/auth/password-reset/complete  {"token": "<o token acima>", "password": "<nova senha>"}`);
  console.log("O link vale uma vez. Não o compartilhe.");
} catch (error) {
  console.error(error instanceof DomainError ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
