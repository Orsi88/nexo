# ADR-013 — Desempenho a partir do resumo JSON do k6

**Status:** Aceita · 21/11/2026, ao implementar o incremento 6. Resolve P-008 provisoriamente: a confirmação com a saída da pipeline real (spike S3) continua pendente.

## Contexto

A especificação pede métricas e thresholds do k6 (RF-188–194, CA-038, CA-039, CA-045), mas deixa o formato exato para ser confirmado com a pipeline real (P-008). Sem essa amostra, esperar travaria o incremento. O k6 tem duas saídas JSON de fim de teste que não precisam de extensão, e a saída por ponto (`--out json`) que gera arquivos enormes.

## Opções consideradas

- **Resumo de fim de teste: `handleSummary` e `--summary-export`**
- Saída por ponto (`--out json`), agregada pela plataforma
- Esperar a amostra real

## Decisão

1. O processador `k6-summary@1` lê os dois resumos de fim de teste:
   - **handleSummary**: `metrics.<nome>.values` e `thresholds: { expr: { ok } }`, com `state.testRunDurationMs`;
   - **--summary-export**: estatísticas direto na métrica e `thresholds: { expr: boolean }`, em que o booleano quer dizer "falhou".
2. Normaliza latência de `http_req_duration` (avg, med, p90, p95, p99, max) em ms, `http_reqs` (total e por segundo), `http_req_failed` (proporção), `vus_max`, `iterations`, `checks` e todos os thresholds. Percentil que o resumo não traz fica **ausente**, nunca zero. A janela das taxas é a duração do teste, quando informada.
3. Os números vão para `results_performance`, separados dos testes funcionais. Nada do k6 entra na taxa de aprovação (RN-045, §20.2).
4. Execução que falhou sem teste funcional falhando e com threshold não atendido é classificada como `threshold` (CA-045), não como infraestrutura. Teste funcional falhando tem prioridade (`test`).
5. A saída por ponto (`--out json`) e o novo resumo legível por máquina do k6 1.x ficam como `unsupported`, com o motivo, até uma pipeline real precisar deles.

## Consequências

**Positivas**

- Funciona com o que um script k6 já produz, só publicando o arquivo como artefato.
- Desempenho e testes funcionais aparecem lado a lado no mesmo projeto sem misturar indicadores (CA-039).

**Negativas**

- Comparar execuções exige o mesmo script e os mesmos `summaryTrendStats`; sem p99 no resumo, o gráfico de p99 fica vazio.
- Se a pipeline real usar outro formato, entra um processador novo (o registro escolhe pela confiança), sem mudar o núcleo.

## Referências

- Especificação v1.1: §20, RF-188–194, RN-045, CA-038, CA-039, CA-045, P-008
- `packages/processor-k6`, migração `0007_performance.sql`
