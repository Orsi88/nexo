-- 0004: incremento 3 — execução e concorrência (RF-041–060, RN-004–009, RN-025;
-- CA-005–009, CA-021, CA-022, CA-042). Fluxos FLX-002 e FLX-005; ADR-004 e ADR-009.

-- ---------------------------------------------------------------------------------------------
-- Fila de jobs (ADR-004). Não é dado de tenant: guarda só nomes, ids e a organização de destino,
-- nunca credenciais ou parâmetros. O worker lê a fila de todas as organizações e executa cada job
-- numa transação com o contexto da organização do job (RLS continua valendo para os dados).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE jobs_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organization_id uuid REFERENCES tenancy_organizations (id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Evita dois jobs pendentes para o mesmo efeito (RNF-010, RF-057).
  idempotency_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  run_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs_jobs (run_after) WHERE status = 'pending';
CREATE INDEX jobs_running ON jobs_jobs (locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_idempotency_key ON jobs_jobs (name, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'running');
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_jobs TO painel_app;

-- ---------------------------------------------------------------------------------------------
-- Recursos executores (RF-049, RF-078, RF-079). O manifesto cita o recurso pelo ref
-- (executionResources[].ref); o catálogo é configuração da organização, não código (DOC-002).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE resources_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  ref text NOT NULL,
  name text NOT NULL,
  description text,
  -- O que fazer com um pedido quando o recurso está ocupado (FLX-005): esperar na fila ou recusar.
  busy_policy text NOT NULL DEFAULT 'queue' CHECK (busy_policy IN ('queue', 'reject')),
  -- Validade do lease, renovada a cada acompanhamento da execução (ADR-009).
  lease_ttl_seconds integer NOT NULL DEFAULT 900 CHECK (lease_ttl_seconds BETWEEN 60 AND 86400),
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX resources_ref_key ON resources_resources (organization_id, lower(ref)) WHERE archived_at IS NULL;

-- Lease de recurso exclusivo (ADR-009, RN-006, RN-007). Só um lease aberto por recurso: o índice
-- único é a garantia, consistente com várias instâncias (FLX-005). Lease vencido não é liberado
-- sozinho: o reconciliador consulta o provedor antes (RF-060).
CREATE TABLE resources_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  resource_id uuid NOT NULL,
  holder_kind text NOT NULL CHECK (holder_kind IN ('internal', 'external')),
  execution_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  FOREIGN KEY (organization_id, resource_id) REFERENCES resources_resources (organization_id, id)
);
CREATE UNIQUE INDEX resources_one_open_lease ON resources_leases (resource_id) WHERE released_at IS NULL;
CREATE INDEX resources_leases_by_execution ON resources_leases (execution_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Perfis de execução (RF-042): conjunto nomeado de ref e parâmetros de uma pipeline.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE pipelines_execution_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  pipeline_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  ref text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, pipeline_id) REFERENCES pipelines_pipelines (organization_id, id)
);
CREATE UNIQUE INDEX pipelines_profiles_name_key ON pipelines_execution_profiles (pipeline_id, lower(name)) WHERE archived_at IS NULL;

-- Até quando as execuções do provedor já foram lidas, para detectar as externas (RF-052).
ALTER TABLE pipelines_pipelines ADD COLUMN runs_synced_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Execuções (§9: campos mínimos). Cancelada ou concluída, a linha fica: o histórico não some (RN-008).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE execution_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  project_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  profile_id uuid,
  -- Versão do manifesto usada: mudar a configuração depois não altera esta execução (RN-010).
  manifest_version integer,
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'rerun', 'external', 'schedule')),
  requested_by uuid REFERENCES identity_users (id),
  rerun_of uuid,
  status text NOT NULL CHECK (status IN ('queued', 'rejected', 'dispatching', 'running', 'cancelling', 'cancelled',
                                         'succeeded', 'failed', 'stale', 'unknown')),
  status_reason text,
  external_status text,
  external_run_id text,
  ref text,
  -- Parâmetros efetivamente usados (RN-004). Sem segredos: o manifesto não declara segredos.
  parameters_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Refs dos recursos exclusivos exigidos, e os ids resolvidos no pedido.
  resource_refs text[] NOT NULL DEFAULT '{}',
  resource_ids uuid[] NOT NULL DEFAULT '{}',
  failure_kind text NOT NULL DEFAULT 'none' CHECK (failure_kind IN ('none', 'test', 'infrastructure', 'threshold', 'unknown')),
  report_status text NOT NULL DEFAULT 'pending' CHECK (report_status IN ('pending', 'available', 'partial', 'missing', 'invalid')),
  source_revision text,
  agent_or_pool text,
  -- Número e tags da execução no provedor: a pipeline pode mudá-los durante a execução (S1, achado 7).
  run_number text,
  run_tags text[] NOT NULL DEFAULT '{}',
  -- Versão do sistema em teste lida conforme o manifesto (systemUnderTest), ex.: distribuição e pacote.
  system_version jsonb,
  idempotency_key text,
  correlation_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_synced_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid REFERENCES identity_users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, pipeline_id) REFERENCES pipelines_pipelines (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES tenancy_projects (organization_id, id),
  FOREIGN KEY (organization_id, profile_id) REFERENCES pipelines_execution_profiles (organization_id, id),
  FOREIGN KEY (organization_id, rerun_of) REFERENCES execution_executions (organization_id, id)
);
-- A mesma execução do provedor nunca vira dois registros (CA-022).
CREATE UNIQUE INDEX execution_external_run_key ON execution_executions (pipeline_id, external_run_id) WHERE external_run_id IS NOT NULL;
-- O mesmo pedido repetido (clique duplo, nova tentativa do cliente) devolve a execução existente (RF-057).
CREATE UNIQUE INDEX execution_idempotency_key ON execution_executions (organization_id, requested_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX execution_by_pipeline ON execution_executions (organization_id, pipeline_id, requested_at DESC);
CREATE INDEX execution_queue ON execution_executions (organization_id, requested_at) WHERE status = 'queued';
CREATE INDEX execution_active ON execution_executions (organization_id, status)
  WHERE status IN ('dispatching', 'running', 'cancelling', 'stale');

-- Histórico de estados de cada execução, só de inclusão (RF-045, RN-008).
CREATE TABLE execution_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  execution_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_user_id uuid REFERENCES identity_users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, execution_id) REFERENCES execution_executions (organization_id, id)
);
CREATE INDEX execution_transitions_by_execution ON execution_transitions (execution_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources_resources', 'resources_leases', 'pipelines_execution_profiles',
                           'execution_executions', 'execution_transitions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON resources_resources, resources_leases, pipelines_execution_profiles, execution_executions TO painel_app;

-- A rotina periódica do worker (reconciliação, fila, execuções externas) passa por todas as
-- organizações ativas, uma transação por organização, sempre com RLS. Esta função entrega só os
-- ids, nada mais; o resto continua isolado pelo contexto de cada transação.
CREATE OR REPLACE FUNCTION app_active_organization_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenancy_organizations WHERE archived_at IS NULL ORDER BY id
$$;
REVOKE ALL ON FUNCTION app_active_organization_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_active_organization_ids() TO painel_app;
GRANT SELECT, INSERT ON execution_transitions TO painel_app;
