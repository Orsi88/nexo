# ADR-001 — Monólito modular com processos api e worker

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Instalação self-hosted primeiro (Q-001), escala de referência modesta (Q-014: 10 organizações, 100 pipelines, 1.000 execuções/dia, 50 usuários), processamento escalável horizontalmente (RNF-004) e projeto open source (Q-012).

## Opções consideradas

- Monólito modular com dois processos (api e worker)
- Microsserviços
- Serverless/gerenciado

## Decisão

Um único código TypeScript dividido em módulos com fronteiras explícitas (`packages/core/src/modules/<módulo>/index.ts`), executado como `api` e `worker`, ambos replicáveis. Um módulo nunca lê tabelas de outro.

## Consequências

**Positivas**

- Poucos containers para instalar e operar
- Workers escalam horizontalmente
- Fronteiras claras permitem extrair serviços no futuro SaaS

**Negativas**

- Exige disciplina de fronteiras: verificada por `scripts/check-boundaries.mjs` no lint

## Referências

- [Documento de arquitetura](../arquitetura.md)
