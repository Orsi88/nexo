# ADR-012 — Open source e self-hosted, sem SaaS

**Status:** Aceita · Decidida em 21/11/2026.

## Contexto

A especificação e as primeiras decisões (ADR-001, ADR-004, ADR-005, ADR-011) deixavam aberta uma "evolução para SaaS": uma versão hospedada por nós, para várias empresas. Foi decidido o modelo de distribuição: o Nexo será um projeto **open source**, e quem quiser usar baixa, instala e hospeda a própria instância.

## Opções consideradas

- Open source, só self-hosted
- Open source com uma oferta SaaS paralela
- Produto fechado

## Decisão

**Open source, só self-hosted. Não haverá SaaS.**

## Consequências

**Positivas**

- Cada empresa mantém os dados, as credenciais e os relatórios na própria infraestrutura.
- Nada de cadastro aberto, cobrança ou isolamento entre clientes de terceiros num mesmo servidor: o isolamento por organização (ADR-003) continua, para áreas e times de uma mesma empresa.
- Decisões que só se justificavam pelo SaaS deixam de ser objetivo (ex.: extrair serviços do monólito, trocar a fila por um broker, cadastro aberto mencionado no ADR-011).

**Negativas e obrigações**

- O repositório é **público**: nenhum dado de cliente, empresa ou pessoa pode entrar nele (nomes de sistemas, organizações, máquinas, versões, ids de execução, usuários). A verificação `scripts/check-sensitive.mjs`, no `npm run check`, barra os termos de uma lista local que não vai para o git.
- A instalação precisa ser fácil para quem não conhece o projeto: Docker Compose, configuração só por variáveis de ambiente e documentação de instalação e atualização (RNF-032).
- A **licença** (P-001) precisa estar definida antes da primeira publicação.

## Efeito em outros ADRs

As menções a SaaS no ADR-001, ADR-004, ADR-005 e ADR-011 ficam como contexto histórico; não são mais objetivo. As decisões deles continuam valendo.

## Referências

- [Documento de arquitetura](../arquitetura.md)
