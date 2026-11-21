import type { ConnectionContext, ConnectorRegistry, PipelineConnector } from "@painel/connector-sdk";
import type { Database } from "../db/database.ts";
import { DomainError, notFound } from "../shared/errors.ts";
import type { SecretStore } from "../shared/secret-store.ts";
import { integrations, type Integration } from "../modules/integrations/index.ts";

// Acesso ao provedor com a credencial guardada, para a api e para o worker. A credencial só existe
// em texto claro dentro da chamada ao conector (RN-017).

export class ProviderAccess {
  readonly #db: Database;
  readonly #secrets: SecretStore;
  readonly #connectors: ConnectorRegistry;

  constructor(db: Database, secrets: SecretStore, connectors: ConnectorRegistry) {
    this.#db = db;
    this.#secrets = secrets;
    this.#connectors = connectors;
  }

  connector(kind: string): PipelineConnector {
    try {
      return this.#connectors.get(kind);
    } catch {
      throw new DomainError("conflict", `O conector "${kind}" não está instalado nesta plataforma.`);
    }
  }

  /** Abre a integração e a credencial. `userId` vazio = processo do sistema (worker). */
  async open(
    organizationId: string,
    integrationId: string,
    correlationId: string,
    userId: string | null = null,
  ): Promise<{ integration: Integration; connector: PipelineConnector; conn: ConnectionContext }> {
    const { integration, sealed } = await this.#db.tx({ organizationId, userId }, async (sql) => {
      const found = await integrations.getIntegration(sql, organizationId, integrationId);
      if (!found) throw notFound("Integração");
      if (found.archivedAt) throw new DomainError("conflict", "A integração desta pipeline está arquivada.");
      return { integration: found, sealed: await integrations.getSealedCredential(sql, organizationId, integrationId) };
    });
    if (!sealed) throw notFound("Integração");
    const value = await this.#secrets.open(organizationId, sealed);
    return {
      integration,
      connector: this.connector(integration.kind),
      conn: {
        organizationId,
        integrationId,
        endpoint: integration.endpoint,
        credential: { kind: integration.credentialKind, value },
        correlationId,
      },
    };
  }
}
