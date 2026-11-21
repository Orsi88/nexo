import type { Sql } from "../../db/database.ts";

// Configurações da organização (incremento 7): política de compartilhamento (P-002, ADR-014) e de
// retenção (P-010, ADR-015). Guardadas em admin_org_settings; ausência = padrões abaixo.

export interface SharingPolicy {
  /** Links públicos (sem login) permitidos nesta organização (Q-003 confirma; a organização pode desligar). */
  allowPublic: boolean;
  /** Validade sugerida ao criar um link, em dias. */
  defaultDays: number;
  /** Validade máxima, em dias. Todo link expira: não há link eterno. */
  maxDays: number;
}

export interface RetentionPolicy {
  /** Artefatos originais (logs, prints, vídeos, traces ficam dentro deles): 22.1 sugere 90 dias. */
  artifactsDays: number;
  /** Testes e métricas detalhados das execuções: 12 meses. */
  resultsDays: number;
  /** Histórico de e-mails enviados. */
  emailsDays: number;
}

export interface OrgSettings {
  sharing: SharingPolicy;
  retention: RetentionPolicy;
}

export const DEFAULT_SETTINGS: OrgSettings = {
  sharing: { allowPublic: true, defaultDays: 7, maxDays: 90 },
  retention: { artifactsDays: 90, resultsDays: 365, emailsDays: 90 },
};

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Normaliza o que veio do banco ou da API: campo desconhecido some, número fora da faixa é limitado. */
export function sanitizeSettings(input: unknown): OrgSettings {
  const raw = (input && typeof input === "object" ? input : {}) as { sharing?: Record<string, unknown>; retention?: Record<string, unknown> };
  const s = raw.sharing ?? {};
  const r = raw.retention ?? {};
  const maxDays = int(s.maxDays, DEFAULT_SETTINGS.sharing.maxDays, 1, 365);
  return {
    sharing: {
      allowPublic: typeof s.allowPublic === "boolean" ? s.allowPublic : DEFAULT_SETTINGS.sharing.allowPublic,
      maxDays,
      defaultDays: Math.min(maxDays, int(s.defaultDays, DEFAULT_SETTINGS.sharing.defaultDays, 1, 365)),
    },
    retention: {
      artifactsDays: int(r.artifactsDays, DEFAULT_SETTINGS.retention.artifactsDays, 1, 3650),
      resultsDays: int(r.resultsDays, DEFAULT_SETTINGS.retention.resultsDays, 30, 3650),
      emailsDays: int(r.emailsDays, DEFAULT_SETTINGS.retention.emailsDays, 1, 3650),
    },
  };
}

export async function getSettings(sql: Sql, organizationId: string): Promise<OrgSettings> {
  const { rows } = await sql.query(`SELECT sharing, retention FROM admin_org_settings WHERE organization_id = $1`, [organizationId]);
  return sanitizeSettings(rows[0] ?? {});
}

export async function saveSettings(sql: Sql, organizationId: string, settings: OrgSettings, userId: string): Promise<OrgSettings> {
  const clean = sanitizeSettings(settings);
  await sql.query(
    `INSERT INTO admin_org_settings (organization_id, sharing, retention, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id) DO UPDATE SET sharing = EXCLUDED.sharing, retention = EXCLUDED.retention, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [organizationId, JSON.stringify(clean.sharing), JSON.stringify(clean.retention), userId],
  );
  return clean;
}
