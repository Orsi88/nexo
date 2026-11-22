# Decisões de arquitetura

| ADR | Decisão | Status |
|---|---|---|
| [ADR-001](ADR-001-monolito-modular.md) | Monólito modular com processos api e worker | Aceita |
| [ADR-002](ADR-002-typescript-ponta-a-ponta.md) | TypeScript ponta a ponta | Aceita |
| [ADR-003](ADR-003-postgresql-com-rls.md) | PostgreSQL como banco único, com Row-Level Security | Aceita |
| [ADR-004](ADR-004-fila-no-postgresql.md) | Fila de jobs no PostgreSQL | Aceita |
| [ADR-005](ADR-005-object-storage-s3.md) | Object storage compatível com S3 | Aceita |
| [ADR-006](ADR-006-contratos-com-capacidades.md) | Conectores e processadores com contrato versionado e capacidades declaradas | Aceita |
| [ADR-007](ADR-007-origem-separada-para-relatorios.md) | Relatórios HTML servidos em origem separada | Aceita |
| [ADR-008](ADR-008-manifesto-unico.md) | Manifesto de configuração como representação única | Aceita |
| [ADR-009](ADR-009-leases-de-recurso.md) | Leases com validade no banco para recursos exclusivos | Aceita |
| [ADR-010](ADR-010-tempo-real-por-sse.md) | Tempo real por Server-Sent Events | Aceita |
| [ADR-011](ADR-011-acesso-local-por-convite.md) | Acesso local por convite, com links gerados pelo administrador (P-003) | Aceita |
| [ADR-012](ADR-012-open-source-self-hosted.md) | Open source e self-hosted, sem SaaS | Aceita |
| [ADR-013](ADR-013-resumo-k6.md) | Desempenho a partir do resumo JSON do k6 (P-008, provisório) | Aceita |
| [ADR-014](ADR-014-links-compartilhados.md) | Links compartilhados: somente leitura, expiração obrigatória e mascaramento (P-002, P-011) | Aceita |
| [ADR-015](ADR-015-email-e-retencao.md) | E-mail pelo SMTP da instalação e retenção aplicada pelo worker (P-010) | Aceita |
| [ADR-016](ADR-016-ia-propria-e-mcp.md) | IA da própria organização e MCP: só leitura, proposta validada, aplicação humana (P-004, P-005) | Aceita |
| [ADR-017](ADR-017-tokens-de-acesso-e-servidor-mcp.md) | Tokens pessoais de acesso e servidor MCP do Nexo, com as permissões do papel | Aceita |

Uma decisão nova recebe o próximo número. Uma decisão revista não é reescrita: um novo ADR a substitui, e o antigo passa a "Substituída por ADR-xxx".
