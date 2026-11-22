# ADR-017 — Tokens pessoais de acesso e servidor MCP do Nexo

**Status:** Aceita · 22/11/2026.

## Contexto

O ADR-016 fez do Nexo um **cliente** de MCP: a IA de dentro do painel consulta servidores externos. Falta o caminho inverso: um cliente de IA de quem usa o painel (Claude Code e outros clientes MCP) agir no Nexo para configurar workspaces, projetos, vínculos e manifestos, sem a organização pagar uma IA própria. A API só aceitava a sessão do navegador (cookie + CSRF), que não serve a um programa.

## Opções consideradas

- Token pessoal como um tipo de sessão + servidor MCP que chama as rotas REST existentes
- Tabela própria de tokens, com escopos por operação, e ferramentas MCP chamando os serviços direto
- Sem MCP: documentar a API REST e deixar cada cliente montar as chamadas

## Decisão

1. **Token pessoal de acesso = sessão do tipo `access-token`** (migração `0010`). Reaproveita o hash SHA-256, a revogação e o `actorFor`, que reavalia o papel a cada chamada (RF-140). Diferenças em relação à sessão do navegador:
   - vai só no cabeçalho `Authorization: Bearer`; um token não vale como cookie, e um cookie não vale como token (o prefixo `nexo_pat_` separa os formatos);
   - fica preso à organização em uso na criação: não troca de organização e é revogado se a pessoa perde o acesso a ela;
   - não expira por inatividade; a validade vai de 1 a 365 dias;
   - só é criado pelo painel (um token não cria outro) e aparece uma única vez;
   - trocar a senha revoga os tokens, como já revogava as outras sessões.
2. **Sem CSRF para o token.** O CSRF protege o cookie, que o navegador envia sozinho. O cabeçalho `Authorization` nunca é enviado sozinho, então outro site não consegue forjá-lo.
3. **Permissões = as do papel.** Não há escopos por token nesta versão: o token tem exatamente o que o papel de quem o criou permite naquela organização, e o servidor reavalia a cada chamada.
4. **Servidor MCP em `POST /api/mcp`**: transporte HTTP "streamable" sem sessão, respostas só em JSON, uma mensagem por requisição. Exige token (cookie recebe 403). Cada ferramenta é traduzida para a rota REST correspondente e executada por injeção interna, com o mesmo token. Validação, autorização e auditoria são as mesmas do painel, sem regra duplicada.
5. **Catálogo curado.** Entram estrutura, descoberta e vínculo de pipelines, manifesto, arquivo da pipeline, recursos, perfis e execuções. Ficam de fora:
   - credenciais de integração (segredo não passa pelo modelo);
   - membros e papéis, política de acesso e arquivamento de organização;
   - tokens.

   Ferramentas que mexem fora do Nexo (`run_pipeline`, `apply_pipeline_file`, `cancel_execution`) levam `destructiveHint`, e as instruções do servidor pedem confirmação humana antes delas.

## Consequências

**Positivas**

- Um cliente MCP configura o Nexo com as mesmas regras do painel, e toda ação fica auditada em nome da pessoa.
- Nenhuma tabela nova de identidade: listar, revogar e expirar seguem o caminho já testado das sessões.
- A API REST passa a servir também scripts (CI, automações) com o mesmo token.

**Negativas**

- Sem escopos, um token de admin pode tudo o que o admin pode pelo catálogo. A mitigação é o catálogo curado e a validade curta; escopos ficam para depois.
- Cada chamada MCP resolve o token duas vezes (na rota MCP e na rota REST injetada).
- Sem stream do servidor: notificações (por exemplo, fim de execução) exigem consultar de novo.

## Referências

- [ADR-011](ADR-011-acesso-local-por-convite.md), [ADR-016](ADR-016-ia-propria-e-mcp.md)
- `packages/core/migrations/0010_access_tokens.sql`, `packages/core/src/modules/identity`, `apps/api/src/mcp`, `apps/api/src/routes/mcp.ts`
