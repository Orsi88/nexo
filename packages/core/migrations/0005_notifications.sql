-- 0005: regras de evento e avisos (RF-126–130, área 17 do §24). Primeiro canal: aviso no painel.
-- Exemplo de uso, como dado do projeto (não do núcleo): "quando a suíte smoke terminar com sucesso,
-- avisar que a versão pode seguir para homologação".

-- Regra: quando (pipeline, resultado, valores de parâmetros) → aviso com mensagem.
CREATE TABLE notifications_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Pipeline vigiada; null = qualquer pipeline da organização.
  pipeline_id uuid,
  -- Resultados finais que disparam a regra (ex.: {succeeded}).
  on_status text[] NOT NULL CHECK (cardinality(on_status) > 0),
  -- Condições sobre os parâmetros usados: [{ "parameter": "suite", "in": ["smoke"] }].
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  message text NOT NULL,
  -- Canais: só "panel" por enquanto; "email" entra no incremento 7.
  channels text[] NOT NULL DEFAULT '{panel}',
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, pipeline_id) REFERENCES pipelines_pipelines (organization_id, id)
);
CREATE INDEX notifications_rules_active ON notifications_rules (organization_id) WHERE archived_at IS NULL AND enabled;

-- Aviso gerado por uma regra para uma execução. Fica aberto até alguém marcar como resolvido.
CREATE TABLE notifications_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  rule_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES identity_users (id),
  resolution_note text,
  FOREIGN KEY (organization_id, rule_id) REFERENCES notifications_rules (organization_id, id),
  FOREIGN KEY (organization_id, execution_id) REFERENCES execution_executions (organization_id, id)
);
-- A mesma regra nunca avisa duas vezes pela mesma execução (reprocessar é seguro).
CREATE UNIQUE INDEX notifications_alerts_once ON notifications_alerts (rule_id, execution_id);
CREATE INDEX notifications_alerts_open ON notifications_alerts (organization_id, created_at DESC) WHERE resolved_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications_rules', 'notifications_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON notifications_rules, notifications_alerts TO painel_app;
