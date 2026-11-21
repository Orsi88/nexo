# ADR-004 — Fila de jobs no PostgreSQL

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Eventos e jobs persistentes e reprocessáveis (RNF-023), idempotentes (RNF-010), num volume de poucos milhares de jobs por dia.

## Opções consideradas

- Fila no PostgreSQL (pg-boss ou graphile-worker)
- Redis + BullMQ
- RabbitMQ

## Decisão

Fila no próprio PostgreSQL, atrás da interface `JobQueue` (`packages/core/src/shared/job-queue.ts`). O job é criado na mesma transação do dado que o originou (outbox). A biblioteca concreta será escolhida no incremento 1.

## Consequências

**Positivas**

- Nenhum componente a mais
- Atomicidade entre dado e job

**Negativas**

- Teto de vazão menor que o de um broker dedicado; trocável pela interface se o SaaS exigir

## Referências

- [Documento de arquitetura](../arquitetura.md)
