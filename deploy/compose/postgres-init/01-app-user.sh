#!/bin/sh
# Roda só na primeira inicialização do volume do PostgreSQL.
# Cria o usuário de login da aplicação, membro do papel painel_app (sujeito a RLS, sem DDL).
# As permissões das tabelas são concedidas pelas migrações (packages/core/migrations).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'painel_app') THEN
    CREATE ROLE painel_app NOLOGIN;
  END IF;
END
$$;
SELECT format('CREATE ROLE painel_app_user LOGIN PASSWORD %L IN ROLE painel_app', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'painel_app_user')
\gexec
SQL
