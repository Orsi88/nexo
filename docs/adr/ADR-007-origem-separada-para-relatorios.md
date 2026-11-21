# ADR-007 — Relatórios HTML servidos em origem separada

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Relatórios HTML de terceiros podem conter script perigoso (RNF-024, CA-012), inclusive quando vistos por link público (§17.1 item 6).

## Opções consideradas

- Origem separada + CSP sandbox
- Mesmo domínio com iframe sandbox
- Converter HTML para dados e descartar o original

## Decisão

Processo `report-origin` (mesmo código da api com `MODE=report-origin`) em host ou porta diferente do painel, com CSP `sandbox` sem `allow-same-origin`, `frame-ancestors` restrito ao painel e sem cookies. A configuração recusa origens iguais.

## Consequências

**Positivas**

- O relatório não alcança sessão, cookies nem privilégios do painel

**Negativas**

- Exige um segundo hostname ou porta e certificado

## Referências

- [Documento de arquitetura](../arquitetura.md)
