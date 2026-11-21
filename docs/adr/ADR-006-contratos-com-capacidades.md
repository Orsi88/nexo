# ADR-006 — Conectores e processadores com contrato versionado e capacidades declaradas

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Provedores têm capacidades diferentes (RN-024, RN-044); a plataforma não pode prometer o que o provedor não faz (CA-023, CA-041). Processadores de relatório precisam ser independentes e versionados (RNF-022).

## Opções consideradas

- Contrato com capacidades declaradas
- Interface única com todos os métodos obrigatórios
- Integração só via MCP

## Decisão

`PipelineConnector` (`packages/connector-sdk`) com métodos obrigatórios e opcionais, mais `capabilities()`; `checkConformance` falha se uma capacidade declarada não tem método ou vice-versa. `ReportProcessor` (`packages/processor-sdk`) com `detect` e `process`, identificado por `id@versão`. MCP é complementar, nunca substitui o conector (§17.1 item 4).

## Consequências

**Positivas**

- A interface mostra só o que é suportado
- Um provedor novo entra sem mudar o núcleo (§15)

**Negativas**

- Mais código de contrato antes do primeiro conector real

## Referências

- [Documento de arquitetura](../arquitetura.md)
