-- 0008: incremento 7 — distribuição (RF-119–130, RF-146–150, RN-015, RN-016, RN-046, RN-047;
-- CA-015–018, CA-036, CA-037; ADR-014 e ADR-015): links compartilhados, e-mail e retenção.

-- ---------------------------------------------------------------------------------------------
-- Configurações da organização: política de compartilhamento e de retenção (P-002, P-010).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE admin_org_settings (
  organization_id uuid PRIMARY KEY REFERENCES tenancy_organizations (id),
  sharing jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES identity_users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Links compartilhados (22.2): publicação somente leitura, não sessão. Só o hash do token fica
-- no banco; o link leva o token no fragmento (#), que não vai ao servidor nem em Referer.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sharing_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  token_hash bytea NOT NULL UNIQUE,
  -- "execution": o relatório de uma execução; "pipeline": o painel da pipeline num período.
  scope text NOT NULL CHECK (scope IN ('execution', 'pipeline')),
  pipeline_id uuid NOT NULL,
  execution_id uuid,
  -- "public": qualquer pessoa com o link; "members": só quem entra e é membro da organização (RF-124).
  access text NOT NULL CHECK (access IN ('public', 'members')),
  title text NOT NULL,
  -- O que o visitante vê além do básico (parâmetros, detalhes de erro, branch, versão, período).
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES identity_users (id),
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  UNIQUE (organization_id, id),
  CHECK ((scope = 'execution') = (execution_id IS NOT NULL)),
  FOREIGN KEY (organization_id, pipeline_id) REFERENCES pipelines_pipelines (organization_id, id),
  FOREIGN KEY (organization_id, execution_id) REFERENCES execution_executions (organization_id, id)
);
CREATE INDEX sharing_links_by_org ON sharing_links (organization_id, created_at DESC);

-- O visitante não tem organização: esta função acha a organização do link pelo hash e mais nada.
-- O resto da leitura acontece numa transação com o contexto dessa organização, sob RLS.
CREATE OR REPLACE FUNCTION sharing_link_organization(hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.organization_id FROM sharing_links l
  JOIN tenancy_organizations o ON o.id = l.organization_id
  WHERE l.token_hash = hash AND o.archived_at IS NULL
$$;
REVOKE ALL ON FUNCTION sharing_link_organization(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sharing_link_organization(bytea) TO painel_app;

-- ---------------------------------------------------------------------------------------------
-- E-mails (RF-126–130): fila de saída com histórico de envio e falhas. Convite e redefinição de
-- senha não têm organização no caso da instância: a linha sem organização só é visível numa
-- transação também sem organização. O corpo é apagado depois do envio (leva link de uso único).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notifications_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES tenancy_organizations (id),
  kind text NOT NULL CHECK (kind IN ('rule', 'invite', 'password-reset', 'test')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text,
  body_html text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  rule_id uuid,
  execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notifications_emails_by_org ON notifications_emails (organization_id, created_at DESC);
-- A mesma regra manda um e-mail por destinatário por execução (reprocessar é seguro).
CREATE UNIQUE INDEX notifications_emails_once ON notifications_emails (rule_id, execution_id, recipient) WHERE rule_id IS NOT NULL;

ALTER TABLE notifications_rules ADD COLUMN recipients text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------------------------
-- Retenção (RF-146, 22.1): o artefato original pode expirar; o registro dele fica como "expired".
-- ---------------------------------------------------------------------------------------------
ALTER TABLE results_artifacts DROP CONSTRAINT results_artifacts_status_check;
ALTER TABLE results_artifacts ADD CONSTRAINT results_artifacts_status_check CHECK (status IN ('stored', 'skipped', 'failed', 'expired'));
GRANT UPDATE (storage_key, status, reason) ON results_artifacts TO painel_app;
-- Resultados estruturados também têm prazo (padrão 12 meses): a retenção apaga os detalhes.
GRANT DELETE ON results_functional_tests, results_performance TO painel_app;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_org_settings', 'sharing_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

ALTER TABLE notifications_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications_emails
  USING (organization_id IS NOT DISTINCT FROM app_current_organization())
  WITH CHECK (organization_id IS NOT DISTINCT FROM app_current_organization());

GRANT SELECT, INSERT, UPDATE ON admin_org_settings, sharing_links TO painel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_emails TO painel_app;
