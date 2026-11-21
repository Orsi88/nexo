# ADR-008 — Manifesto de configuração como representação única

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Onboarding manual e por IA devem produzir a mesma configuração versionada (§19.1); importação e exportação sem segredos (Q-013, CA-040).

## Opções consideradas

- Manifesto único validado por esquema
- Modelos separados por caminho de onboarding

## Decisão

`PipelineManifestSchema` (`packages/contracts/src/manifest.ts`), com `schemaVersion`, parâmetros tipados e regras de validação declarativas. As regras específicas (como o bootstrap do caso piloto só em PostgreSQL) são dados do projeto, não código do núcleo. Propostas da IA passam por `checkAiProposal` e voltam sempre como rascunho com aprovação humana.

## Consequências

**Positivas**

- Trocar de método, editar depois e executar sem IA
- Validação determinística única (RN-041)

**Negativas**

- Mudanças no esquema exigem migrar versões de manifesto

## Referências

- [Documento de arquitetura](../arquitetura.md)
