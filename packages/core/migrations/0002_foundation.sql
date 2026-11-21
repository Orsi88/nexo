-- 0002: fundação, parte 2 (incremento 1) — sessões, tokens de uso único, administração da instância,
-- política de papéis por organização e visibilidade das organizações de cada usuário.
-- Decisões: ADR-011 (admin inicial + convites; links gerados pelo admin enquanto não há e-mail).

-- Contexto do usuário, ao lado do contexto de tenant (0001). Definido por transação pela aplicação.
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app_current_user() TO painel_app;

-- Administrador da instância: cria organizações e gera links de redefinição de senha (ADR-011).
-- Não dá acesso aos dados das organizações: para isso precisa ser membro, como qualquer usuário.
ALTER TABLE identity_users
  ADD COLUMN is_instance_admin boolean NOT NULL DEFAULT false,
  -- Proteção contra força bruta por conta (RNF-026, §5.1).
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz;

-- Sessões (RF-132). Só o hash SHA-256 do token fica no banco; o token vai no cookie HttpOnly.
CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES identity_users (id),
  -- Organização em uso nesta sessão (CA-024). A permissão é sempre reavaliada pela associação atual.
  active_organization_id uuid REFERENCES tenancy_organizations (id),
  csrf_token text NOT NULL,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX identity_sessions_user ON identity_sessions (user_id) WHERE revoked_at IS NULL;

-- Tokens de uso único: convite para uma organização e redefinição de senha (RF-133, RNF-026).
-- Só o hash fica no banco; o link com o token é mostrado uma única vez a quem o gerou.
CREATE TABLE identity_one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('invite', 'password-reset')),
  user_id uuid NOT NULL REFERENCES identity_users (id),
  -- Convite: organização e papel concedidos ao aceitar.
  organization_id uuid REFERENCES tenancy_organizations (id),
  role text CHECK (role IN ('admin', 'manager', 'operator', 'reader')),
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK ((kind = 'invite') = (organization_id IS NOT NULL AND role IS NOT NULL))
);
CREATE INDEX identity_one_time_tokens_user ON identity_one_time_tokens (user_id, kind) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON identity_sessions, identity_one_time_tokens TO painel_app;

-- Um usuário enxerga as próprias associações e as organizações de que participa, em qualquer
-- organização, para listar e trocar de organização (RF-005, CA-024). Políticas permissivas somam
-- com tenant_isolation; continuam valendo só para leitura.
CREATE POLICY own_memberships ON tenancy_memberships FOR SELECT
  USING (user_id = app_current_user());
CREATE POLICY member_organizations ON tenancy_organizations FOR SELECT
  USING (id IN (SELECT organization_id FROM tenancy_memberships WHERE user_id = app_current_user()));

-- Busca por nome (RF-007).
CREATE INDEX tenancy_workspaces_org ON tenancy_workspaces (organization_id, lower(name));
CREATE INDEX tenancy_projects_org ON tenancy_projects (organization_id, workspace_id, lower(name));
-- Nome único entre os ativos, dentro do mesmo pai.
CREATE UNIQUE INDEX tenancy_workspaces_name_key ON tenancy_workspaces (organization_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX tenancy_projects_name_key ON tenancy_projects (organization_id, workspace_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE tenancy_organizations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tenancy_workspaces ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tenancy_projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tenancy_memberships ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Concessões "conforme política" do §6, por organização (módulo access).
CREATE TABLE access_policies (
  organization_id uuid PRIMARY KEY REFERENCES tenancy_organizations (id),
  grants jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES identity_users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_policies
  USING (organization_id = app_current_organization())
  WITH CHECK (organization_id = app_current_organization());
GRANT SELECT, INSERT, UPDATE ON access_policies TO painel_app;

-- Eventos da instância (login, administração da instância) não pertencem a uma organização.
-- A aplicação pode gravá-los, mas só lê eventos da organização em contexto.
ALTER TABLE audit_events ALTER COLUMN organization_id DROP NOT NULL;
DROP POLICY tenant_isolation ON audit_events;
CREATE POLICY tenant_read ON audit_events FOR SELECT
  USING (organization_id = app_current_organization());
CREATE POLICY tenant_write ON audit_events FOR INSERT
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_organization());
