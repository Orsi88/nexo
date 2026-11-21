import { z } from "zod";

// Configuração 100% por variáveis de ambiente (RNF-011). Ver deploy/compose/.env.example.

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Schema = z.object({
  MODE: z.enum(["api", "report-origin"]).default("api"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Conexão da aplicação: usuário membro de painel_app, sujeito a RLS. */
  DATABASE_URL: z.string().url().optional(),
  /** Origem pública do painel; a origem dos relatórios precisa ser diferente (ADR-007). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  REPORT_ORIGIN_URL: z.string().url().default("http://localhost:8081"),
  /** Atrás do proxy (Caddy), confiar em X-Forwarded-For para saber o IP do cliente. */
  TRUST_PROXY: bool.default(false),
  /** Sessão (RF-132): inatividade máxima e validade absoluta. */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(8 * 60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(90 * 24).default(7 * 24),
  /** Validade dos links de convite e de redefinição de senha (ADR-011). */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(72),
  PASSWORD_RESET_TTL_HOURS: z.coerce.number().int().min(1).max(7 * 24).default(24),
  /** Limite por IP nos endpoints públicos de autenticação, por minuto e por instância (§5.1). */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /**
   * Chave mestra que protege as chaves de dados das organizações (credenciais dos provedores).
   * 32 bytes em base64: openssl rand -base64 32. Sem ela, as rotas de integração não sobem.
   * Trocar ou perder a chave torna as credenciais guardadas ilegíveis.
   */
  SECRETS_MASTER_KEY: z.string().optional(),
  /**
   * SMTP da instalação (incremento 7): smtp://usuario:senha@host:587 ou smtps://...:465. Quem envia é o
   * worker; a api só precisa saber se está configurado. Sem ele, convites e avisos ficam só no painel.
   */
  SMTP_URL: z.string().optional(),
  /** Limite por IP para abrir links compartilhados, por minuto e por instância. */
  SHARE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  /** Hosts de Azure DevOps Server aceitos além de dev.azure.com e *.visualstudio.com, separados por vírgula. */
  /** Hosts de GitHub Enterprise Server aceitos além de github.com, separados por vírgula. */
  GITHUB_EXTRA_HOSTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  AZURE_DEVOPS_EXTRA_HOSTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = Schema.parse(env);
  if (new URL(config.PUBLIC_BASE_URL).origin === new URL(config.REPORT_ORIGIN_URL).origin) {
    throw new Error("REPORT_ORIGIN_URL precisa ter origem diferente de PUBLIC_BASE_URL (RNF-024, ADR-007)");
  }
  return config;
}

/** Cookies com Secure e prefixo __Host- quando o painel é servido por HTTPS (RNF-005). */
export function isSecureOrigin(config: Config): boolean {
  return new URL(config.PUBLIC_BASE_URL).protocol === "https:";
}
