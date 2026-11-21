# ADR-014 — Links compartilhados: publicação somente leitura, com expiração obrigatória e mascaramento

**Status:** Aceita · 21/11/2026, ao implementar o incremento 7. Resolve P-002 e P-011 com padrões configuráveis por organização; os valores podem ser revistos sem mudar o modelo.

## Contexto

Links públicos sem login estão confirmados (Q-003, RF-125), mas a política ficou em aberto: expiração padrão, limites, o que pode ser exposto (P-002) e como mascarar (P-011). A especificação exige somente leitura, revogação, expiração, prévia exata do que o visitante vê e nenhum segredo exposto (22.2, RN-046, RN-047, CA-015–017, CA-036, CA-037).

## Decisão

1. **O link é uma publicação, não uma sessão.** Dois alcances: o resultado de uma execução ou o painel de uma pipeline num período (até 90 dias). Dois acessos: público (sem login) ou só membros da organização dona (RF-124).
2. **Token.** 256 bits aleatórios. Só o hash SHA-256 fica no banco, então a URL aparece uma vez. O token vai no fragmento (`/compartilhado#token`) e chega à API no cabeçalho `x-share-token`, nunca em URL de log. Inexistente, expirado e revogado dão a mesma resposta.
3. **Todo link expira.** Padrão de 7 dias e máximo de 90, configuráveis por organização (máximo de até 365). Revogar vale na hora. A organização pode desligar links públicos, e os públicos já criados param de abrir.
4. **O que o visitante vê** sai de uma projeção montada no servidor: resultado, horários, contagem e lista de testes (com a primeira linha do erro) e o resumo de desempenho. Por opção de quem cria: parâmetros, detalhe técnico do erro, branch e versão testada. **Nunca** saem logs, artefatos brutos, endereços do provedor ou do repositório, ids internos, quem pediu, integrações ou configuração.
5. **Mascaramento** em todo texto publicado: credenciais em URL, `Bearer`/`Basic`, atribuições do tipo `senha=`/`token:`, JWT, chaves AWS/GitHub/Slack, chaves privadas, sequências longas com cara de chave e a parte local de e-mails. Parâmetro com nome sensível (senha, token, chave, secret...) fica "oculto" mesmo com "parâmetros" marcado.
6. **Prévia.** A janela de compartilhar mostra a projeção real, a mesma da página pública, e a lista do que ficou de fora.
7. **Isolamento.** O visitante não tem organização: uma função `SECURITY DEFINER` devolve só a organização dona do hash, e o resto da leitura roda sob RLS com esse contexto. Criar, revogar e mudar a política são ações auditadas; as aberturas são contadas no próprio link.
8. **Permissão.** Criar e revogar exige a operação `share` do §6 (admin e gestor sempre; operador conforme a política da organização). Mudar a política de links é só do admin da organização.

## Consequências

**Positivas**

- Nenhuma rota de gestão aceita o link (CA-016), e o token não serve para mais nada além de ler aquela projeção.
- Organizações mais restritivas ajustam a validade ou desligam links públicos sem mudar código.

**Negativas**

- O mascaramento por padrões reduz o risco, mas não garante que nenhum dado sensível apareça de forma inesperada num nome de teste. Por isso o detalhe técnico do erro e os parâmetros ficam desmarcados por padrão.
- Quem perde a URL precisa criar outra, porque o servidor guarda apenas o hash.
- O relatório HTML do Playwright continua fora dos links públicos até o visualizador isolado (ADR-007) servir artefatos, e "acesso anônimo a artefatos brutos" não foi aprovado (22.2).

## Referências

- Especificação v1.1: Q-003, RF-119–125, RN-015, RN-016, RN-046, RN-047, 22.2, CA-015–017, CA-036, CA-037, P-002, P-011
- `packages/core/src/sharing/service.ts`, `packages/core/src/modules/sharing/projection.ts`, migração `0008_distribution.sql`
