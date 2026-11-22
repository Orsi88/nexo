-- 0010: tokens pessoais de acesso, para clientes de API e MCP (ADR-017).
-- Um token é uma sessão de outro tipo: mesmo hash SHA-256, mesma reavaliação do papel a cada chamada
-- (RF-140) e mesma revogação. Diferenças: vai no cabeçalho Authorization (nunca em cookie), fica preso
-- à organização em que foi criado, não expira por inatividade e tem nome para quem o gerencia.

ALTER TABLE identity_sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'access-token')),
  ADD COLUMN name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80);

-- Token de acesso sempre tem nome e organização; sessão de navegador não tem nome.
ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_kind_shape CHECK (
    (kind = 'browser' AND name IS NULL)
    OR (kind = 'access-token' AND name IS NOT NULL AND active_organization_id IS NOT NULL)
  );
