-- 0007: incremento 6 — desempenho k6 (RF-188–194, RN-045, CA-038, CA-039, CA-045; ADR-013).
-- Um resumo de desempenho por relatório processado. Fica numa tabela própria, separada dos testes
-- funcionais: requisições HTTP nunca entram na taxa de aprovação (§20.2).
-- Unidades: latências em ms; taxas como proporção de 0 a 1; vazão por segundo na janela duration_ms.

CREATE TABLE results_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy_organizations (id),
  execution_id uuid NOT NULL,
  report_id uuid NOT NULL,
  format text NOT NULL,
  duration_ms double precision,
  vus_max double precision,
  iterations double precision,
  http_reqs double precision,
  http_req_rate double precision,
  http_req_failed_rate double precision,
  latency_avg double precision,
  latency_med double precision,
  latency_p90 double precision,
  latency_p95 double precision,
  latency_p99 double precision,
  latency_max double precision,
  checks_rate double precision,
  thresholds_total integer NOT NULL DEFAULT 0,
  thresholds_failed integer NOT NULL DEFAULT 0,
  -- Todas as métricas e thresholds como vieram (normalizados), para o detalhe.
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  thresholds jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (report_id),
  FOREIGN KEY (organization_id, report_id) REFERENCES results_reports (organization_id, id),
  FOREIGN KEY (organization_id, execution_id) REFERENCES execution_executions (organization_id, id)
);
CREATE INDEX results_performance_by_execution ON results_performance (organization_id, execution_id);

ALTER TABLE results_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE results_performance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON results_performance
  USING (organization_id = app_current_organization())
  WITH CHECK (organization_id = app_current_organization());

GRANT SELECT, INSERT ON results_performance TO painel_app;
