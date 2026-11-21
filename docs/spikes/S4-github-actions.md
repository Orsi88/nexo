# Spike S4: capacidades do GitHub Actions

**Pergunta:** a API do GitHub cobre o que o Nexo precisa para tratar um workflow do GitHub Actions como pipeline (listar, ler parâmetros, disparar sabendo qual execução nasceu, acompanhar, cancelar, logs e artefatos)?

**Estado:** concluído (2026-11-21). Chamadas reais em dois repositórios públicos de teste, primeiro com o `gh` e depois com o próprio conector (`packages/connector-github`). Os nomes dos repositórios e da conta ficam fora deste repositório.

## Matriz de capacidades

| Capacidade (`ConnectorCapabilities`) | API | Resultado |
|---|---|---|
| `read.pipelines` | `GET /user/repos` (filtrado pelo dono da integração) e `GET /repos/{o}/{r}/actions/workflows` | ✅ Confirmado |
| `read.definition` | `GET /repos/{o}/{r}/contents/{caminho do workflow}?ref=` | ✅ Confirmado |
| `read.parameters` | `on.workflow_dispatch.inputs` do YAML, lido na ref pedida | ✅ Confirmado (string, boolean, number, choice, environment) |
| `read.runs` | `GET /repos/{o}/{r}/actions/workflows/{id}/runs?created=>=` e `GET .../actions/runs/{id}` | ✅ Confirmado |
| `read.logs` | `GET .../actions/runs/{id}/jobs` + `GET .../actions/jobs/{job}/logs` (redireciona para o armazenamento) | ✅ Confirmado; vem com códigos de cor do terminal, que o conector remove |
| `read.artifacts` | `GET .../actions/runs/{id}/artifacts` e `GET .../actions/artifacts/{id}/zip` | ✅ Confirmado |
| `read.schedules` | `on.schedule` do YAML | ⏳ Não implementado |
| `write.triggerRun` | `POST .../actions/workflows/{id}/dispatches` com `return_run_details: true` | ✅ Confirmado: **200 com `workflow_run_id`** (ver achado 1) |
| `write.cancelRun` | `POST .../actions/runs/{id}/cancel` | ✅ Confirmado: 202, e a execução termina como `completed/cancelled` |
| Edição do workflow | Contents API (commit) ou PR | ⏳ Fora deste spike (incremento 4) |
| `events.webhooks` | Webhooks do repositório | ⏳ Não testado |

## Achados que mudam o projeto

1. **O disparo devolve o id da execução.** Com `return_run_details: true`, o GitHub responde 200 com `workflow_run_id`, `run_url` e `html_url`. Sem isso (204, como em GitHub Enterprise antigo) não dá para saber qual execução é a do pedido; o conector declara "não suportado" em vez de adivinhar.
2. **Só dispara quem tem `workflow_dispatch`.** Um workflow só com `push`/`pull_request` aparece e tem as execuções lidas, mas o disparo é recusado (422). O onboarding precisa avisar e sugerir a linha `workflow_dispatch:` no YAML.
3. **O YAML vale na ref do disparo.** Dá para disparar numa branch que tem `workflow_dispatch` mesmo que a branch padrão ainda não tenha.
4. **Não há tags nem número mutável.** O `run_number` é fixo; a versão testada, se houver, vem de parâmetro (entrada do `workflow_dispatch`) ou de um artefato.
5. **A API não devolve as entradas usadas numa execução.** Execuções iniciadas fora do Nexo aparecem sem parâmetros; as do Nexo guardam os parâmetros do pedido.
6. **Relatório de testes:** os dois repositórios passaram a gerar JUnit (`node --test --test-reporter=junit` e `vitest --reporter=junit`) publicado como artefato `test-results`, que o processador `junit-xml` vai ler no incremento 5.

## Permissões mínimas do token

Token *fine-grained* limitado aos repositórios usados:

- **Actions:** Read and write (listar, disparar, cancelar, logs, artefatos);
- **Contents:** Read-only (ler o YAML do workflow);
- **Metadata:** Read-only (obrigatória, entra sozinha).

## Próximos passos

- Ler `on.schedule` para mostrar os agendamentos (`read.schedules`).
- Webhooks do GitHub para atualização imediata, em vez de consulta periódica.
- Criar workflow pelo Nexo a partir de um modelo (requisito novo, sobre o incremento 4).
