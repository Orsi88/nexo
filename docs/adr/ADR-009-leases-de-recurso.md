# ADR-009 — Leases com validade no banco para recursos exclusivos

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Recursos compartilhados exclusivos (RN-006; caso piloto: DOC-002, DOC-003), reserva consistente com várias instâncias (FLX-005) e execuções externas detectáveis (RN-007).

## Opções consideradas

- Lease com validade no PostgreSQL
- Lock distribuído em Redis
- Lock em memória

## Decisão

Uma linha de reserva com `expires_at`, renovada enquanto a execução corre (`resources_leases`, repositório em `packages/core/src/modules/resources`). Um índice único parcial (`resource_id WHERE released_at IS NULL`) garante um lease aberto por recurso, mesmo com várias instâncias disputando. Leases vencidos vão para o reconciliador, que consulta o provedor antes de liberar. Execuções externas detectadas criam lease do tipo `external`.

**Implementação (incremento 3):** o pedido trava as linhas dos recursos (`FOR UPDATE`, em ordem de id) para decidir entre fila e recusa. O disparo pega todos os leases da execução de uma vez, ou nenhum. A fila é FIFO entre quem disputa ao menos um recurso em comum.

## Consequências

**Positivas**

- Um worker que morre não prende o recurso para sempre
- Funciona com várias instâncias

**Negativas**

- A validade precisa ser calibrada com a duração real das execuções
- A detecção de execuções externas depende do provedor (P-012)

## Referências

- [Documento de arquitetura](../arquitetura.md)
