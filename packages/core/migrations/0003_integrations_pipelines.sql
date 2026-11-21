-- 0003: incremento 2 — integrações com provedores, credenciais cifradas, pipelines vinculadas e
-- manifesto versionado (CA-002, CA-003, CA-004, CA-026, CA-030, CA-040).
-- Evidências da API do Azure DevOps: docs/spikes/S1-azure-devops.md.

-- As chaves estrangeiras compostas (organization_id, project_id) abaixo garantem que pipeline e
-- projeto são da mesma organização; para isso o projeto precisa ser único por (organization_id, id).
ALTER TABLE tenancy_projects ADD CONSTRAINT tenancy_projects_org_id_key UNIQUE (organization_id, id);

-- Chave de dados por organização (cifragem envelope, §8 da arquitetura). Guardada cifrada pela
-- chave mestra do ambiente; o texto claro nunca toca o banco.
CREATE TABLE integrations_data_keys (
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  key_id text NOT NULL,
  master_key_id text NOT NULL,
  wrapped_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key_id)
);

-- Conexão com um provedor (RF-011, RF-014). A credencial fica cifrada (SealedSecret) e nunca sai
-- pela API, por exportação ou por log (RN-017, RNF-033).
CREATE TABLE integrations_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  kind text NOT NULL,
  name text NOT NULL,
  endpoint text NOT NULL,
  credential_kind text NOT NULL,
  credential jsonb NOT NULL,
  credential_updated_at timestamptz NOT NULL DEFAULT now(),
  -- Último teste de conexão: ok, failing (credencial recusada, sem permissão...) ou unchecked.
  status text NOT NULL DEFAULT 'unchecked' CHECK (status IN ('ok', 'failing', 'unchecked')),
  last_check jsonb,
  last_checked_at timestamptz,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id)
);
-- O nome é a referência usada pelo manifesto (provider.integrationRef), por isso único entre as ativas.
CREATE UNIQUE INDEX integrations_name_key ON integrations_integrations (organization_id, lower(name)) WHERE archived_at IS NULL;

-- Pipeline do provedor vinculada a um projeto (RF-026, CA-004). Guarda o que foi sincronizado
-- do provedor: origem, revisão, capacidades e parâmetros declarados (CA-030).
CREATE TABLE pipelines_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  project_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  external_url text,
  external_path text,
  -- Repositório da definição, para o link "abrir repositório" (nome e URL web https).
  repository_name text,
  repository_url text,
  default_ref text,
  -- Ref de onde vieram os parâmetros: o YAML muda de branch para branch (S1, achado 1).
  parameters_ref text,
  external_revision text,
  definition_revision text,
  capabilities jsonb NOT NULL,
  external_parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_state text NOT NULL DEFAULT 'synchronized' CHECK (sync_state IN ('synchronized', 'pending', 'unknown')),
  sync_problem text,
  synced_at timestamptz,
  current_version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES tenancy_projects (organization_id, id),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations_integrations (organization_id, id)
);
-- A mesma pipeline externa não entra duas vezes no mesmo projeto.
CREATE UNIQUE INDEX pipelines_external_key ON pipelines_pipelines (project_id, integration_id, external_id) WHERE archived_at IS NULL;
CREATE INDEX pipelines_by_project ON pipelines_pipelines (organization_id, project_id, lower(name));

-- Histórico do manifesto (ADR-008, RN-042): cada alteração é uma versão nova; nada é sobrescrito.
CREATE TABLE pipelines_config_versions (
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  pipeline_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  manifest jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('discovery', 'manual', 'import', 'assist')),
  note text,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, version),
  FOREIGN KEY (organization_id, pipeline_id) REFERENCES pipelines_pipelines (organization_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integrations_data_keys', 'integrations_integrations', 'pipelines_pipelines', 'pipelines_config_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

-- Chaves e versões de manifesto são só de inclusão.
GRANT SELECT, INSERT ON integrations_data_keys, pipelines_config_versions TO painel_app;
GRANT SELECT, INSERT, UPDATE ON integrations_integrations, pipelines_pipelines TO painel_app;
