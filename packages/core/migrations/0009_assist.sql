-- 0009: incremento 8 — IA própria + MCP (RF-172–186, RN-038–041, RN-049; CA-027–029, CA-043,
-- CA-044; ADR-016). Tudo opcional: sem estas configurações, a plataforma funciona inteira (RN-038).
-- Chaves de IA e credenciais MCP ficam cifradas pelo cofre da organização (RN-049, RNF-033).

-- Provedor de IA escolhido pela organização (BYOAI/BYOK).
CREATE TABLE assist_ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('anthropic', 'openai-compatible')),
  endpoint text NOT NULL DEFAULT '',
  model text NOT NULL,
  effort text CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  -- SealedSecret (cofre); null quando a API não pede chave (ex.: modelo local).
  credential jsonb,
  last_check jsonb,
  last_checked_at timestamptz,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX assist_ai_providers_name ON assist_ai_providers (organization_id, lower(name)) WHERE archived_at IS NULL;

-- Servidor MCP (transporte HTTP). Cada ferramenta descoberta é classificada como leitura ou mutação
-- e só entra numa sessão se estiver autorizada; mutação nunca vai para o modelo (RF-176, RF-182).
CREATE TABLE assist_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  name text NOT NULL,
  url text NOT NULL,
  -- Cabeçalho de autenticação (ex.: Authorization); o valor fica cifrado em credential.
  auth_header text,
  credential jsonb,
  -- [{ name, description, inputSchema, kind: read|mutate, authorized, readOnlyHint }]
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  server_info jsonb,
  last_check jsonb,
  last_checked_at timestamptz,
  created_by uuid REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX assist_mcp_servers_name ON assist_mcp_servers (organization_id, lower(name)) WHERE archived_at IS NULL;

-- Sessão assistida: do pedido à proposta revisada e aplicada. Guarda o que a IA leu (ferramenta,
-- entrada resumida, tamanho), nunca credenciais (RF-183).
CREATE TABLE assist_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  project_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_id text NOT NULL,
  ref text,
  pipeline_name text NOT NULL,
  provider_id uuid NOT NULL,
  -- Ferramentas MCP liberadas para esta sessão: ["<serverId>/<tool>"].
  mcp_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'proposed', 'failed', 'applied', 'discarded')),
  -- Manifesto da descoberta (ponto de partida) e parâmetros reais do provedor.
  baseline jsonb NOT NULL,
  provider_parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Resultado: { manifest, problems, warnings, changes, notes }.
  review jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  error text,
  created_by uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  applied_by uuid REFERENCES identity_users (id),
  applied_at timestamptz,
  applied_pipeline_id uuid,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, provider_id) REFERENCES assist_ai_providers (organization_id, id),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations_integrations (organization_id, id)
);
CREATE INDEX assist_sessions_by_org ON assist_sessions (organization_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assist_ai_providers', 'assist_mcp_servers', 'assist_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_organization()) WITH CHECK (organization_id = app_current_organization())',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON assist_ai_providers, assist_mcp_servers, assist_sessions TO painel_app;
