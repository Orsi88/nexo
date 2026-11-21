# Spike S1: capacidades do Azure DevOps

**Pergunta** ([plano de entregas](../arquitetura.md#14-plano-de-entregas)): quais APIs cobrem parâmetros de YAML, cancelamento, service hooks com assinatura e leitura e escrita de YAML no Repos?

**Estado:** parcial (2026-11-21). As chamadas reais foram feitas numa organização de verdade, com uma pipeline Playwright em agente self-hosted, usando o login interativo de um usuário (não um PAT). As evidências, com nomes, IDs e respostas, ficam fora do repositório, junto com a especificação.

## Matriz de capacidades

| Capacidade (`ConnectorCapabilities`) | API | Resultado |
|---|---|---|
| `read.pipelines` | `GET _apis/build/definitions`, `GET _apis/pipelines` | ✅ Confirmado |
| `read.definition` | `GET _apis/git/repositories/{repo}/items?path=…&version=<branch>` | ✅ Confirmado |
| `read.parameters` | Lidos do YAML (`parameters:`) | ✅ Confirmado; ver achado 1 |
| `read.runs` | `GET _apis/pipelines/{id}/runs`, `GET _apis/build/builds` | ✅ Confirmado; cada execução traz `templateParameters` e `yamlDetails.rootYamlFile.ref` |
| `read.logs` | `GET _apis/build/builds/{id}/logs` | ✅ Confirmado |
| `read.artifacts` | `GET _apis/build/builds/{id}/artifacts` | ✅ A API funciona; a pipeline testada não publica artefatos (achado 5) |
| `read.schedules` | `triggers[].schedules` da definição | ✅ Confirmado (só leitura) |
| `write.triggerRun` | `POST _apis/pipelines/{id}/runs` com `templateParameters` e `resources.repositories.self.refName` | ✅ Confirmado |
| Validação antes do disparo | O mesmo `POST` com `previewRun: true` | ✅ Recusa parâmetro desconhecido e tipo inválido; devolve `finalYaml` resolvido |
| `write.cancelRun` | `PATCH _apis/build/builds/{id}/stages/{stage}` com `state: cancel` | ✅ Confirmado (sem estágios declarados, o estágio é `__default`). `PATCH _apis/build/builds/{id}` com `status: cancelling` não foi testado |
| `write.definitionViaCommit` | `POST _apis/git/repositories/{repo}/pushes` com `oldObjectId` | ✅ Confirmado, inclusive a recusa quando a branch andou (proteção contra conflito) |
| `write.definitionViaPullRequest` | `POST _apis/git/repositories/{repo}/pullrequests` | ⏳ Não testado (não criar PR real sem combinar com o time) |
| `write.definitionViaApi` | — | ❌ Em pipeline YAML a definição mora no Repos; não há API para editar o YAML fora dele |
| `events.webhooks` (service hooks com assinatura) | `POST _apis/hooks/subscriptions` | ⏳ Não testado: precisa de um PAT |
| Permissões mínimas de um PAT | — | ⏳ Não testado: tudo rodou com o login de um usuário |

## Achados que mudam o projeto

1. **O YAML depende da branch.** Branches diferentes declaram conjuntos diferentes de parâmetros. A descoberta de parâmetros precisa ler o YAML na branch da execução (`yamlDetails.rootYamlFile.ref`), não na branch padrão do repositório.
2. **Os valores dos parâmetros não têm tipo fixo no histórico.** Execuções antigas gravaram booleanos como `"True"`/`"False"` e as novas como `true`/`false`. O conector normaliza na leitura.
3. **Há dois enums de resultado.** API Pipelines: result 1 = succeeded, 2 = failed, 4 = canceled. API Build: status 2 = completed; result 2 = succeeded, 8 = failed, 32 = canceled. O conector mapeia os dois para `@painel/contracts`.
4. **O número da execução muda.** Uma pipeline pode trocar o próprio número (`##vso[build.updatebuildnumber]`) e adicionar tags durante a execução. A identidade da execução é o `id`, nunca o número.
5. **Os relatórios precisam ser publicados pela pipeline.** Se a pipeline só envia o resultado por e-mail, não há o que ingerir. O onboarding precisa detectar isso (nenhum artefato nem resultado de teste) e orientar a publicar o relatório do Playwright como artefato. Para o caso real, isso entra no Spike S2.

## Próximos passos

- Criar um PAT de teste com escopo mínimo (Build: read & execute; Code: read & write; Service Hooks: read & write) e repetir a matriz com ele.
- Testar a assinatura de service hooks e a criação de PR.
- Implementar no `connector-azure-devops` as capacidades confirmadas, cada uma com o método e o teste correspondentes (ADR-006).
