# ADR-003 — PostgreSQL como banco único, com Row-Level Security

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Isolamento lógico por organização (Q-002, RN-002) com testes automatizados (RNF-008), auditoria (RN-020) e persistência reprocessável (RNF-023).

## Opções consideradas

- PostgreSQL único com RLS
- Banco por organização
- PostgreSQL sem RLS (só filtro na aplicação)

## Decisão

Um PostgreSQL. Toda tabela de tenant tem `organization_id`. A aplicação conecta como membro do papel `painel_app` (sem DDL, sujeito a RLS) e define `app.organization_id` por transação; a política `tenant_isolation` é a segunda barreira, além do filtro da aplicação.

## Consequências

**Positivas**

- Um vazamento por erro de consulta é barrado pelo banco
- Isolamento testável no CI (`packages/core/test/rls-isolation.test.ts`)

**Negativas**

- Toda transação precisa definir o contexto de tenant
- Agregações pesadas futuras podem exigir réplica de leitura

## Referências

- [Documento de arquitetura](../arquitetura.md)
