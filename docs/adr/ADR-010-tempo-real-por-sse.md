# ADR-010 — Tempo real por Server-Sent Events

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Atualização automática do painel (RF-075), meta de até 15 s após o evento (RNF-003).

## Opções consideradas

- SSE
- WebSocket
- Polling do navegador

## Decisão

SSE da api para o painel, alimentado por eventos internos.

## Consequências

**Positivas**

- Simples, atravessa proxies HTTP, reconexão nativa

**Negativas**

- Só servidor → cliente; suficiente para os requisitos atuais

## Referências

- [Documento de arquitetura](../arquitetura.md)
