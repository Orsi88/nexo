# Nexo — painel de pipelines

Plataforma web **open source e self-hosted** para **descobrir, configurar, executar, monitorar, analisar e compartilhar** resultados de pipelines de automação de testes, independente de empresa, framework de testes e provedor de CI/CD. Quem quiser usar clona o repositório e hospeda a própria instância; não há versão SaaS ([ADR-012](docs/adr/ADR-012-open-source-self-hosted.md)).

Provedores suportados: **Azure DevOps Pipelines** e **GitHub Actions**. Um provedor novo entra como um pacote de conector, sem mudar o núcleo.

> **Estado** ([plano](docs/arquitetura.md#14-plano-de-entregas)):
> - **Incremento 1 (Fundação):** login local, sessões, organizações, workspaces, projetos, membros por convite, papéis, auditoria e isolamento por RLS.
> - **Incremento 2:** integração com o Azure DevOps (PAT cifrado e testado antes de guardar), descoberta, vínculo de pipelines a projetos e manifesto versionado.
> - **Incremento 3 (Execução e concorrência):** recursos exclusivos com lease, perfis, pedido com prévia, fila, disparo, acompanhamento, cancelamento, reexecução, execuções externas, execuções sem notícia, versão do sistema em teste e tempo real por SSE.
> - **Incremento 4:** arquivo da pipeline (ver, editar com diff, gravar por commit ou PR) e criação por modelo.
> - **Incremento 5:** relatórios JUnit e Playwright, artefatos originais guardados, ausência explícita de relatório e tipo de falha.
> - **Incremento 6 (Desempenho):** resumo do k6, thresholds, falha por limite de desempenho e painel de desempenho por pipeline ([ADR-013](docs/adr/ADR-013-resumo-k6.md)).
> - **Incremento 7 (Distribuição):** links compartilhados públicos ou só para membros, com prévia, expiração, revogação e mascaramento; e-mail pelo SMTP da instalação; retenção configurável ([ADR-014](docs/adr/ADR-014-links-compartilhados.md), [ADR-015](docs/adr/ADR-015-email-e-retencao.md)).
> - **Incremento 8 (IA + MCP):** IA da própria organização (Claude ou API compatível com OpenAI), servidores MCP por HTTP com ferramentas liberadas uma a uma, e configuração de pipeline proposta pela IA e aplicada por uma pessoa ([ADR-016](docs/adr/ADR-016-ia-propria-e-mcp.md)).
>
> O painel web (Nexo) cobre todos esses fluxos e também roda em modo demonstração, sem API. A especificação de UX/UI (P-013) continua pendente: as telas são provisórias.

## Documentação

- [Arquitetura](docs/arquitetura.md): visão, containers, módulos, contratos, fluxos, segurança, plano de entregas.
- [Decisões de arquitetura (ADRs)](docs/adr/README.md).
- [Spike S1: capacidades do Azure DevOps](docs/spikes/S1-azure-devops.md).

## Estrutura

| Pasta | O que tem |
|---|---|
| [apps/api](apps/api) | HTTP, health checks, migrações; com `MODE=report-origin`, a origem isolada dos relatórios HTML |
| [apps/worker](apps/worker) | Processo de jobs (sincronização, disparo, ingestão, e-mail); registra conectores e processadores |
| [apps/web](apps/web) | Painel em React + Vite (página provisória até a especificação de UX/UI) |
| [packages/contracts](packages/contracts) | Manifesto de configuração de pipeline, capacidades e estados, com validação determinística |
| [packages/core](packages/core) | Os 15 módulos de domínio, interfaces (`JobQueue`, `SecretStore`, `LeaseStore`), matriz de papéis, migrações SQL |
| [packages/connector-sdk](packages/connector-sdk) | Contrato `PipelineConnector`, registro e verificação de conformidade |
| [packages/connector-azure-devops](packages/connector-azure-devops) | Conector Azure DevOps: pipelines, parâmetros do YAML por branch, disparo, cancelamento, logs e artefatos ([S1](docs/spikes/S1-azure-devops.md)) |
| [packages/connector-github](packages/connector-github) | Conector GitHub Actions: workflows, entradas do `workflow_dispatch` por branch, disparo com o id da execução, cancelamento, logs e artefatos ([S4](docs/spikes/S4-github-actions.md)) |
| [packages/processor-sdk](packages/processor-sdk) e `processor-*` | Contrato `ReportProcessor` e detecção de Playwright, JUnit XML e k6 |
| [packages/assist](packages/assist) | IA do usuário + MCP (opcional): políticas de ferramentas e validação de propostas |
| [deploy/compose](deploy/compose) | Docker Compose, Caddyfile, inicialização do PostgreSQL, `.env.example` |

## Requisitos

- Node.js 24 ou mais recente (executa TypeScript direto, sem build do backend).
- Docker com Compose, para a instalação completa.

## Desenvolvimento

```bash
npm install
npm run check        # typecheck + lint (inclui fronteiras entre módulos) + testes
npm run dev:api      # http://localhost:3000/health/live
npm run dev:web      # http://localhost:5173 (encaminha /api e /health para a api)
```

Os testes com banco (isolamento entre organizações, casos de uso e API) só rodam com um PostgreSQL descartável. Cada arquivo de teste cria e apaga o próprio banco, então o usuário precisa poder criar bancos:

```bash
TEST_DATABASE_ADMIN_URL=postgres://usuario:senha@localhost:5432/postgres npm test
```

## Instalação self-hosted

```bash
cd deploy/compose
cp .env.example .env    # troque todos os valores
docker compose up -d --build
```

- Painel: <http://localhost:8080>
- Relatórios, em origem separada: <http://localhost:8081>

A ordem de subida é PostgreSQL e storage (SeaweedFS), depois `migrate`, depois `api`, `worker` e `report-origin`, e por fim o proxy (Caddy). Em produção, troque as portas do [Caddyfile](deploy/compose/Caddyfile) pelos nomes de host para ter TLS.

### Primeiro acesso

O cadastro é fechado: só entra quem é convidado ([ADR-011](docs/adr/ADR-011-acesso-local-por-convite.md)). Depois da primeira subida, crie o administrador e a primeira organização:

```bash
docker compose run --rm api node apps/api/src/bootstrap.ts \
  --email admin@empresa.com --name "Seu nome" --org "Sua empresa" --slug sua-empresa
```

O comando imprime um link de uso único para definir a senha. Enquanto a tela não existe, conclua pela API:

```bash
curl -X POST http://localhost:8080/api/auth/password-reset/complete \
  -H "content-type: application/json" -H "origin: http://localhost:8080" \
  -d '{"token": "<token do link>", "password": "<senha com 12 ou mais caracteres>"}'
```

### API do incremento 1

Sessão em cookie `HttpOnly`; toda mutação autenticada exige o cabeçalho `x-csrf-token` com o valor devolvido pelo login ou por `GET /api/session`.

| Área | Rotas |
|---|---|
| Autenticação | `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/password`, `POST /api/auth/invites/accept`, `POST /api/auth/password-reset/complete` |
| Sessão | `GET /api/session`, `POST /api/session/organization` (trocar de organização), `GET /api/sessions`, `DELETE /api/sessions/:id` |
| Organizações | `GET` e `POST /api/organizations`, `GET` e `PATCH /api/organization`, `POST /api/organization/archive` e `/unarchive` |
| Workspaces e projetos | `GET`, `POST /api/workspaces` e `/api/projects`; `GET`, `PATCH /:id`; `POST /:id/archive` e `/:id/unarchive`; busca com `?q=` |
| Membros | `GET /api/members`, `POST /api/invites`, `PATCH` e `DELETE /api/members/:userId` |
| Política e auditoria | `GET` e `PUT /api/access-policy`, `GET /api/audit` |
| Instância | `POST /api/admin/password-resets` (só o administrador da instância) |

### API do incremento 2

Precisa de `SECRETS_MASTER_KEY`: sem ela, estas rotas não sobem. A credencial (PAT) só entra no corpo de `POST /api/integrations` e `PUT /api/integrations/:id/credential`; nenhuma resposta a devolve.

| Área | Rotas |
|---|---|
| Provedores | `GET /api/connectors` |
| Integrações | `GET` e `POST /api/integrations` (testa a credencial antes de guardar); `GET`, `PATCH /:id`; `POST /:id/test`; `PUT /:id/credential`; `POST /:id/archive` e `/:id/unarchive` |
| Descoberta | `GET /api/integrations/:id/discover?q=&cursor=` (marca o que já está vinculado) |
| Pipelines | `GET /api/pipelines?projectId=&q=`; `POST /api/pipelines` (vincula a um projeto; `ref` escolhe a branch de onde ler os parâmetros); `GET /:id` (dados sincronizados, revisão, capacidades e diferenças); `POST /:id/sync`; `POST /:id/archive` e `/:id/unarchive` |
| Manifesto | `PUT /api/pipelines/:id/manifest` (com `expectedVersion`); `GET /:id/manifest/versions` e `/:id/manifest/versions/:version`; `POST /api/pipelines/import-manifest` |

O manifesto referencia a integração pelo nome (`provider.integrationRef`), nunca pela credencial. Ao importar, a integração com esse nome precisa existir; organização e projeto são reescritos para o destino, e o manifesto volta para rascunho.

### API do incremento 3

Precisa das mesmas condições do incremento 2. O disparo e o acompanhamento rodam no **worker**, que também precisa de `SECRETS_MASTER_KEY`.

| Área | Rotas |
|---|---|
| Recursos exclusivos | `GET` e `POST /api/resources` (com ocupação atual e fila); `PATCH /:id`; `POST /:id/archive` e `/:id/unarchive` |
| Perfis de execução | `GET` e `POST /api/pipelines/:id/profiles`; `PUT /api/profiles/:id`; `POST /api/profiles/:id/archive` e `/unarchive` |
| Execuções | `POST /api/executions/preview` (o que aconteceria, sem gravar); `POST /api/executions` (202; com `idempotencyKey`, repetir devolve a mesma); `GET /api/executions?pipelineId=&projectId=&status=&before=&limit=`; `GET /:id` (histórico de estados, leases, reexecuções); `POST /:id/cancel`; `POST /:id/rerun`; `GET /:id/logs` (texto, lido do provedor na hora) |
| Tempo real | `GET /api/events` (SSE: `execution.changed` da organização em uso) |

Como funciona:

- **Recurso exclusivo:** o manifesto cita o recurso pelo `ref` (`executionResources`), e o recurso precisa estar cadastrado na organização. Ocupado, o pedido espera na fila (FIFO) ou é recusado, conforme o `busyPolicy` do recurso.
- **Validade do lease:** o lease vale por `leaseTtlSeconds` e é renovado a cada acompanhamento. Um lease vencido **não** é liberado sozinho: a rotina do worker consulta o provedor antes.
- **Execuções externas:** execuções iniciadas direto no provedor são lidas a cada `EXTERNAL_RUNS_SYNC_SECONDS`, entram no histórico e ocupam o recurso.
- **Versão do sistema em teste:** o manifesto diz, em `systemUnderTest`, de onde ler cada parte da versão (número da execução, tag ou parâmetro, com um padrão opcional). Exemplo: distribuição e pacote tirados do número que a pipeline grava com `##vso[build.updatebuildnumber]`. A versão é relida a cada acompanhamento.

Variáveis do worker (todas opcionais):

| Variável | Padrão | O que é |
|---|---|---|
| `EXECUTION_POLL_SECONDS` | 15 | Intervalo de acompanhamento sem webhook |
| `EXECUTION_STALE_AFTER_SECONDS` | 600 | Sem notícia do provedor por mais que isso, a execução vira "sem notícia" (stale) |
| `EXTERNAL_RUNS_SYNC_SECONDS` | 120 | Intervalo de leitura das execuções do provedor, por pipeline |
| `EXTERNAL_RUNS_LOOKBACK_HOURS` | 24 | Na primeira leitura, até quando procurar execuções externas |
| `WORKER_TICK_SECONDS` | 30 | Intervalo da rotina periódica (fila, leases vencidos, execuções externas) |

### Arquivo da pipeline e criação por modelo (incremento 4)

Na aba **Arquivo** da pipeline dá para ver o YAML, editar, revisar a diferença e gravar. Em **Pipelines → Nova pipeline**, um assistente monta o YAML a partir de um modelo (Playwright, testes em Node com JUnit, k6 ou comando livre), mostra o arquivo para revisão e cria a pipeline no provedor, já vinculada ao projeto. Tudo funciona sem IA.

| Área | Rotas |
|---|---|
| Arquivo | `GET /api/pipelines/:id/definition?ref=`; `POST /:id/definition/preview` (diferença e problemas de sintaxe, sem gravar); `POST /:id/definition` (`mode`: `commit` ou `pull-request`, com `expectedRevision`) |
| Criação | `GET /api/pipeline-templates`; `POST /api/pipeline-templates/render`; `GET /api/integrations/:id/repositories`; `POST /api/pipelines/create` |

- **Commit direto ou PR, à escolha de quem grava:** o PR não é obrigatório. Escolhas feitas na hora de executar (como a suíte a rodar) nunca mexem no arquivo.
- **Trava contra sobrescrever:** a gravação só acontece se o arquivo ainda estiver na revisão que a pessoa viu; se alguém mudou antes, a tela pede para recarregar.
- **Permissões do token:** para gravar, o PAT do Azure DevOps precisa de **Code: Read & Write** (e **Build: Read & execute** para criar a pipeline); no GitHub, **Contents** e **Workflows** com leitura e escrita. Sem isso, a leitura continua funcionando e a gravação mostra o erro de permissão.

### Relatórios de testes (incremento 5)

Quando uma execução termina, o worker baixa os artefatos dela do provedor, guarda o original e procura relatórios dentro deles. Reconhece hoje **JUnit XML** (node --test, Vitest, Jest, pytest, Maven...) e o **JSON do Playwright** (reporter `json`). Para a pipeline aparecer com testes, basta publicar o relatório como artefato.

| Área | Rotas |
|---|---|
| Resultados | `GET /api/executions/:id/results?status=failed,flaky&search=&limit=` (resumo, artefatos, relatórios lidos e testes, falhas primeiro). A lista de execuções traz `tests` com a contagem de cada uma |

- **Sem relatório não é "0 testes":** se a execução não publicou relatório, ela fica com `reportStatus: missing`, e a tela diz isso.
- **Tipo de falha:** falhou com teste falhando = falha de teste; falhou sem relatório, ou com todos os testes passando = falha de infraestrutura.
- **Taxa de aprovação:** teste instável (passou numa nova tentativa) conta como aprovado; pulado não entra na conta.
- **Limites:** o zip é lido só em memória, com limite de tamanho e de quantidade de arquivos (proteção contra "zip bomb"); XML com `DOCTYPE` é recusado.

| Variável (worker) | Padrão | O que é |
|---|---|---|
| `ARTIFACTS_DIR` | `./data/artifacts` | Pasta onde ficam os artefatos originais (no Docker, o volume `artifacts-data`) |
| `ARTIFACT_MAX_MB` | 500 | Artefato maior que isso não é baixado (fica registrado como ignorado) |
| `INGEST_CONCURRENCY` | 2 | Quantas execuções têm relatório lido ao mesmo tempo |

### Desempenho k6 (incremento 6)

Publique o resumo do k6 como artefato: `export function handleSummary(data) { return { "summary.json": JSON.stringify(data) } }` ou `k6 run --summary-export=summary.json`. O Nexo lê latência (p50 a p99), vazão, erros HTTP, usuários virtuais e thresholds, sempre separados dos testes funcionais. Execução que falhou por threshold aparece como "limite de desempenho não atingido". Rota: `GET /api/pipelines/:id/performance`.

### Links, e-mail e retenção (incremento 7)

| Área | Rotas |
|---|---|
| Links | `POST /api/share-links` (a URL aparece só na resposta); `POST /api/share-links/preview`; `GET /api/share-links`; `POST /api/share-links/:id/revoke`; visitante: `GET /api/public/share` com o token no cabeçalho `x-share-token` |
| Configurações | `GET/PUT /api/organization/settings` (política de links e retenção; só admin altera) |
| E-mail | `GET /api/email/status`; `GET /api/email/history`; `POST /api/email/test` |

| Variável | Padrão | O que é |
|---|---|---|
| `SMTP_URL` | vazio | SMTP da instalação (`smtp://usuario:senha@host:587` ou `smtps://...:465`). Vazio = convites e avisos só no painel |
| `SMTP_FROM` | `Nexo <nexo@localhost>` | Remetente |
| `SHARE_RATE_LIMIT_PER_MINUTE` | 120 | Aberturas de link compartilhado por IP e minuto |

### IA própria + MCP (incremento 8)

Opcional. Em **Administração → Inteligência artificial**, cadastre a IA (Anthropic/Claude ou API compatível com OpenAI, inclusive modelo local) e, se quiser, servidores MCP por HTTP, liberando uma a uma as ferramentas de leitura. Em **Vincular existente**, escolha "Assistido por IA": a IA lê o arquivo e os parâmetros e propõe a configuração; você revisa, corrige e aplica. Detalhes e garantias: [ADR-016](docs/adr/ADR-016-ia-propria-e-mcp.md).

| Área | Rotas |
|---|---|
| Provedores | `GET/POST /api/ai-providers`; `POST /api/ai-providers/:id/test`; `POST /api/ai-providers/:id/archive` |
| MCP | `GET/POST /api/mcp-servers`; `POST /api/mcp-servers/:id/refresh`; `PUT /api/mcp-servers/:id/tools`; `POST /api/mcp-servers/:id/archive` |
| Sessões | `GET/POST /api/assist-sessions`; `GET /api/assist-sessions/:id`; `POST /api/assist-sessions/:id/apply`; `POST /api/assist-sessions/:id/discard` |

## Regras para contribuir

- Um módulo de `packages/core` só importa outro pelo `index.ts` dele (ADR-001); o lint verifica.
- Conectores e processadores declaram só o que realmente suportam; nada é simulado (ADR-006).
- Nada de credenciais em código, manifestos, logs, exports ou testes.
- Regras específicas de um cliente ou projeto (máquina exclusiva, smoke, nomes de parâmetros) são configuração, não código do núcleo.
- O repositório é público ([ADR-012](docs/adr/ADR-012-open-source-self-hosted.md)): nenhum dado de empresa, sistema, máquina, versão real ou pessoa em código, testes ou documentos. O `npm run check` barra os termos de um arquivo local `.sensitive-words` (um por linha, fora do git).

## Licença

A definir (P-001), depois da revisão de propriedade intelectual.
