import pg from "pg";
import { createAzureDevOpsConnector } from "@painel/connector-azure-devops";
import { createGitHubConnector } from "@painel/connector-github";
import { ConnectorRegistry } from "@painel/connector-sdk";
import {
  AssistService,
  Database,
  EmailService,
  EnvelopeSecretStore,
  ExecutionService,
  FoundationService,
  NotificationService,
  OnboardingService,
  ProviderAccess,
  parseMasterKey,
  ResultsService,
  SharingService,
} from "@painel/core";
import { EventHub } from "./events.ts";
import { loadConfig } from "./config.ts";
import { buildApiServer, buildReportOriginServer } from "./server.ts";

const config = loadConfig();
const pool = config.DATABASE_URL ? new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 }) : undefined;
const db = pool && new Database(pool);

const foundation =
  db &&
  new FoundationService(db, {
    sessionIdleMinutes: config.SESSION_IDLE_MINUTES,
    sessionAbsoluteHours: config.SESSION_ABSOLUTE_HOURS,
    inviteTtlHours: config.INVITE_TTL_HOURS,
    passwordResetTtlHours: config.PASSWORD_RESET_TTL_HOURS,
  });

// Conectores desta instalação (RF-013). Um provedor novo entra aqui, sem mudar o núcleo.
function connectors(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createAzureDevOpsConnector({ extraHosts: config.AZURE_DEVOPS_EXTRA_HOSTS }));
  registry.register(createGitHubConnector({ extraHosts: config.GITHUB_EXTRA_HOSTS }));
  return registry;
}

const secrets = db && config.SECRETS_MASTER_KEY ? new EnvelopeSecretStore(db, parseMasterKey(config.SECRETS_MASTER_KEY)) : undefined;
const registry = connectors();
const onboarding = db && foundation && secrets ? new OnboardingService(db, foundation, secrets, registry) : undefined;
const execution = db && foundation && secrets ? new ExecutionService(db, foundation, new ProviderAccess(db, secrets, registry)) : undefined;
const notifications = db && foundation ? new NotificationService(db, foundation) : undefined;
const results = db && foundation ? new ResultsService(db, foundation) : undefined;
const sharing = db && foundation ? new SharingService(db, foundation) : undefined;
const email = db && foundation ? new EmailService(db, foundation, Boolean(config.SMTP_URL)) : undefined;
const assist = db && foundation && secrets && onboarding ? new AssistService(db, foundation, secrets, onboarding) : undefined;
const events = pool && execution && config.MODE === "api" ? new EventHub(pool, (msg, error) => console.error(JSON.stringify({ level: "warn", msg, error: String(error) }))) : undefined;
await events?.start();

const app =
  config.MODE === "report-origin"
    ? buildReportOriginServer(config)
    : buildApiServer(
        config,
        db
          ? {
              checkDatabase: () => db.ping(),
              ...(foundation ? { foundation } : {}),
              ...(onboarding ? { onboarding } : {}),
              ...(execution ? { execution } : {}),
              ...(notifications ? { notifications } : {}),
              ...(results ? { results } : {}),
              ...(sharing ? { sharing } : {}),
              ...(email ? { email } : {}),
              ...(assist ? { assist } : {}),
              ...(events ? { events } : {}),
            }
          : {},
      );

async function shutdown(signal: string) {
  app.log.info({ signal }, "encerrando");
  await app.close();
  await events?.stop();
  await pool?.end();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });
