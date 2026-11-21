-- 0001: fundação — identidade, tenancy e auditoria (incremento 1).
-- Isolamento por organização em duas barreiras (ADR-003, RN-002, RNF-008):
--   1. a aplicação sempre filtra pelo contexto de tenant;
--   2. Row-Level Security usa current_setting('app.organization_id'), definido por transação.
-- A aplicação conecta com um usuário membro do papel painel_app (sem BYPASSRLS, sem DDL).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'painel_app') THEN
    CREATE ROLE painel_app NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app_current_organization() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;

-- Usuários são globais: um usuário participa de várias organizações (RF-005).
CREATE TABLE identity_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text,               -- Argon2id (RNF-026); null enquanto o convite não foi aceito
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identity_users_email_key ON identity_users (lower(email));

CREATE TABLE tenancy_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenancy_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  name text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE tenancy_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- O projeto e o workspace são obrigatoriamente da mesma organização.
  FOREIGN KEY (organization_id, workspace_id) REFERENCES tenancy_workspaces (organization_id, id)
);

CREATE TABLE tenancy_memberships (
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  user_id uuid NOT NULL REFERENCES identity_users (id),
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'operator', 'reader')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- Auditoria append-only (RN-020, RNF-021). Nunca guarda segredos (RNF-033).
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  actor_user_id uuid REFERENCES identity_users (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system', 'share-link', 'assist')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
  correlation_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time ON audit_events (organization_id, occurred_at DESC);

-- Row-Level Security nas tabelas de tenant.
ALTER TABLE tenancy_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy_organizations
  USING (id = app_current_organization())
  WITH CHECK (id = app_current_organization());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenancy_workspaces', 'tenancy_projects', 'tenancy_memberships', 'audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

-- Permissões do papel da aplicação.
GRANT USAGE ON SCHEMA public TO painel_app;
GRANT SELECT, INSERT, UPDATE ON identity_users, tenancy_organizations, tenancy_workspaces, tenancy_projects TO painel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy_memberships TO painel_app;
GRANT SELECT, INSERT ON audit_events TO painel_app;   -- sem UPDATE/DELETE: append-only
GRANT EXECUTE ON FUNCTION app_current_organization() TO painel_app;
