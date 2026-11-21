import type { Database } from "../db/database.ts";
import type { ArtifactStore } from "../shared/artifact-store.ts";
import { orgSettings } from "../modules/admin/index.ts";
import { recordAudit } from "../modules/audit/index.ts";
import { emails } from "../modules/notifications/index.ts";
import { results } from "../modules/results/index.ts";

// Retenção (incremento 7, RF-146, Q-008, 22.1; ADR-015). Roda no worker, uma organização por vez,
// sempre sob RLS. Apaga o arquivo original dos artefatos vencidos (o registro fica como "expired"),
// os testes e métricas detalhados de execuções antigas e o histórico antigo de e-mails. O estado
// das execuções (metadados) fica: o histórico não perde o "o que rodou e como terminou".

export interface RetentionSummary {
  organizationId: string;
  artifacts: number;
  tests: number;
  performance: number;
  emails: number;
}

const DAY = 86_400_000;

export class RetentionRunner {
  readonly #db: Database;
  readonly #store: ArtifactStore;
  readonly #now: () => Date;
  readonly #log: ((level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void) | undefined;

  constructor(db: Database, store: ArtifactStore, options: { now?: () => Date; log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void } = {}) {
    this.#db = db;
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log;
  }

  async run(): Promise<RetentionSummary[]> {
    const orgs = await this.#db.tx({}, async (sql) => (await sql.query<{ id: string }>(`SELECT app_active_organization_ids() AS id`)).rows.map((r) => r.id));
    const out: RetentionSummary[] = [];
    for (const organizationId of orgs) {
      try {
        out.push(await this.runFor(organizationId));
      } catch (error) {
        this.#log?.("error", "retenção falhou", { organizationId, error: String(error) });
      }
    }
    return out;
  }

  async runFor(organizationId: string): Promise<RetentionSummary> {
    const scope = { organizationId, userId: null };
    const now = this.#now().getTime();
    const policy = (await this.#db.tx(scope, (sql) => orgSettings.getSettings(sql, organizationId))).retention;
    const summary: RetentionSummary = { organizationId, artifacts: 0, tests: 0, performance: 0, emails: 0 };

    // Artefatos: apaga o arquivo e depois marca. Se o processo cair no meio, a próxima rodada refaz.
    const cutoff = new Date(now - policy.artifactsDays * DAY);
    for (;;) {
      const batch = await this.#db.tx(scope, (sql) => results.expirableArtifacts(sql, organizationId, cutoff, 200));
      if (!batch.length) break;
      for (const a of batch) {
        await this.#store.delete(a.storageKey);
        await this.#db.tx(scope, (sql) => results.markArtifactExpired(sql, organizationId, a.id, `apagado pela política de retenção (${policy.artifactsDays} dias)`));
        summary.artifacts++;
      }
      if (batch.length < 200) break;
    }

    await this.#db.tx(scope, async (sql) => {
      const purged = await results.purgeResultDetails(sql, organizationId, new Date(now - policy.resultsDays * DAY));
      summary.tests = purged.tests;
      summary.performance = purged.performance;
      summary.emails = await emails.purgeEmails(sql, organizationId, new Date(now - policy.emailsDays * DAY));
      if (summary.artifacts || summary.tests || summary.performance || summary.emails) {
        await recordAudit(sql, {
          organizationId,
          actorUserId: null,
          actorKind: "system",
          action: "retention.apply",
          targetType: "organization",
          targetId: organizationId,
          outcome: "success",
          correlationId: `retention:${new Date(now).toISOString().slice(0, 13)}`,
          details: { ...summary, policy },
        });
      }
    });
    return summary;
  }
}
