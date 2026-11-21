-- 0006: incremento 5 — resultados de testes (FLX-003, RF-086–105, RN-011–014, RN-045;
-- CA-010, CA-011, CA-025). O artefato original fica guardado (R-007); cada arquivo reconhecido
-- vira um relatório processado; cada teste vira uma linha, na tabela da sua categoria (RN-045).

-- Artefato baixado do provedor e guardado como veio.
CREATE TABLE results_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  execution_id uuid NOT NULL,
  external_ref text NOT NULL,
  name text NOT NULL,
  size_bytes bigint,
  -- Onde o original foi guardado (ArtifactStore); null quando não foi guardado (ver status).
  storage_key text,
  status text NOT NULL CHECK (status IN ('stored', 'skipped', 'failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (execution_id, external_ref),
  FOREIGN KEY (organization_id, execution_id) REFERENCES execution_executions (organization_id, id)
);

-- Um arquivo de relatório dentro de um artefato, já passado pelo processador. Reprocessar é
-- idempotente pela chave (artefato, arquivo, processador@versão) — §20.3, RF-149.
CREATE TABLE results_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  execution_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  file_path text NOT NULL,
  processor_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('functional', 'api', 'performance')),
  status text NOT NULL CHECK (status IN ('processed', 'partial', 'unsupported', 'failed')),
  reason text,
  tests integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (artifact_id, file_path, processor_id),
  FOREIGN KEY (organization_id, artifact_id) REFERENCES results_artifacts (organization_id, id)
);

-- Testes funcionais normalizados (categoria "functional"). Métricas de desempenho (k6) terão a
-- tabela delas: nunca entram na taxa de aprovação (RN-045, §20.2).
CREATE TABLE results_functional_tests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  execution_id uuid NOT NULL,
  report_id uuid NOT NULL,
  suite text NOT NULL,
  name text NOT NULL,
  file text,
  project text,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'flaky')),
  duration_ms integer,
  attempts integer NOT NULL DEFAULT 1,
  error_message text,
  error_details text,
  attachments jsonb,
  FOREIGN KEY (organization_id, report_id) REFERENCES results_reports (organization_id, id)
);
CREATE INDEX results_tests_by_execution ON results_functional_tests (organization_id, execution_id, status);
CREATE INDEX results_tests_by_name ON results_functional_tests (organization_id, file, name);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['results_artifacts', 'results_reports', 'results_functional_tests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

-- Resultados são só de inclusão: o histórico de uma execução não muda depois (RN-010, RN-014).
GRANT SELECT, INSERT ON results_artifacts, results_reports, results_functional_tests TO painel_app;
