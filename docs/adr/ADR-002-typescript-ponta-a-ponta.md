# ADR-002 — TypeScript ponta a ponta

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

A stack estava pendente (P-009). O manifesto de configuração (§19.4) precisa ser validado do mesmo jeito no painel, no backend, nos conectores e nas propostas da IA. Rust foi considerado e descartado.

## Opções consideradas

- TypeScript (Node.js + React)
- .NET (ASP.NET Core + React)
- Python (FastAPI + React)
- Rust (considerado na conversa)

## Decisão

TypeScript em todo o sistema: Node.js 24 LTS, executando TypeScript direto (remoção de tipos, sem etapa de build no backend), React + Vite no painel e monorepo com npm workspaces. TypeScript 6.0 (o 7.0 ainda não é suportado pelo typescript-eslint).

## Consequências

**Positivas**

- Esquemas Zod compartilhados entre front, back, conectores e IA
- SDK oficial de referência do MCP e ecossistema do Playwright em TypeScript
- Base ampla de contribuidores

**Negativas**

- SDK do Azure DevOps para Node.js menos completo que o de .NET
- Só sintaxe TypeScript apagável é permitida (`erasableSyntaxOnly`): sem `enum` nem parameter properties

## Ajuste na criação do esqueleto

A proposta original citava pnpm; o esqueleto usa npm workspaces porque o pnpm não estava instalado e o npm cobre o mesmo papel sem ferramenta extra.

## Referências

- [Documento de arquitetura](../arquitetura.md)
