# ADR-005 — Object storage compatível com S3

**Status:** Aceita · Aceita em 20/11/2026 como parte da base de arquitetura.

## Contexto

Relatórios, screenshots, vídeos, traces e logs coletados, preservados com retenção por tipo (RF-096, RF-144, R-007, R-009), em instalação self-hosted e futura nuvem.

## Opções consideradas

- Storage compatível com S3
- Sistema de arquivos local
- Blobs no banco

## Decisão

API S3 como contrato. No self-hosted, SeaweedFS (Apache-2.0) com gateway S3; em nuvem, qualquer S3 compatível.

## Consequências

**Positivas**

- Mesma API do servidor interno ao SaaS
- Retenção e ciclo de vida por bucket ou prefixo

**Negativas**

- Um container a mais para operar

## Ajuste na criação do esqueleto

A proposta original citava MinIO. Na criação do esqueleto (20/11/2026), o repositório `minio/minio` não existia mais no Docker Hub; o SeaweedFS mantém a decisão (S3 compatível) com imagem publicada e mantida.

## Referências

- [Documento de arquitetura](../arquitetura.md)
