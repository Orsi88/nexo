# ADR-016 — IA da própria organização e MCP: só leitura, proposta validada, aplicação humana

**Status:** Aceita · 21/11/2026, ao implementar o incremento 8. Resolve P-004 (provedores iniciais) e P-005 (transporte e política de ferramentas MCP).

## Contexto

O onboarding assistido por IA é requisito (RF-172–187, FLX-008), sempre opcional (RN-038, RN-039) e sem poder contornar permissões (RN-040). A especificação exige classificar ferramentas MCP em leitura e mutação, tratar conteúdo externo como não confiável (§19.5, CA-043) e validar a proposta de forma determinística antes de salvar (RN-041, CA-028). Como a instalação é self-hosted (ADR-012), cada organização traz a própria chave e paga o próprio uso.

## Decisão

1. **Provedores (P-004).**
   - `anthropic`: Claude pelo SDK oficial (`@anthropic-ai/sdk`). Modelo padrão `claude-opus-5-5`, com esforço configurável. Nos modelos atuais da API oficial, o fallback do servidor para recusas fica ligado (`fallbacks: "default"`). O histórico guarda as respostas como vieram (blocos de pensamento incluídos), e os resultados das ferramentas voltam numa mensagem só.
   - `openai-compatible`: qualquer API no formato Chat Completions (OpenAI, Ollama, LM Studio, OpenRouter, vLLM...), para quem quer outro provedor ou um modelo local.
   - O teste de conexão roda antes de salvar, e a chave fica cifrada pelo cofre da organização (RN-049). Trocar de provedor não afeta configurações já aplicadas (RF-185).
2. **MCP (P-005).** Só o transporte HTTP "streamable" (JSON-RPC por POST, resposta JSON ou SSE), com cabeçalho de autenticação opcional guardado no cofre. Não há stdio: o servidor do Nexo não executa programas configurados pela interface. Toda ferramenta descoberta nasce **sem liberação**; quem gerencia integrações classifica leitura ou mutação. **Mutação nunca é liberada** para a IA.
3. **Sessão.** Roda no worker, uma tentativa só (chamada de IA custa dinheiro). A IA recebe ferramentas de leitura da plataforma (arquivo, parâmetros, branches, catálogo de recursos) e as ferramentas MCP liberadas para aquela sessão. Antes de pedir, a pessoa confirma que sabe o que vai para o modelo.
4. **Dado externo não é instrução.** Todo resultado de ferramenta volta ao modelo dentro de `<dados_externos fonte="...">`, com qualquer tentativa de fechar o marcador neutralizada, e o prompt de sistema diz que nada ali é ordem. Mesmo que o modelo "obedeça", ele não tem ferramenta de escrita.
5. **Proposta.** A IA entrega pela ferramenta `submit_proposal` só a parte configurável do manifesto, mais fontes e dúvidas. O backend junta com o manifesto da descoberta: a identidade (organização, projeto, provedor, pipeline) sempre vem da descoberta. Parâmetro que o provedor não declara é recusado, recurso fora do catálogo e relatório que o Nexo não lê viram aviso, e tudo passa pelo esquema do manifesto.
6. **Aplicação.** Só quem pode configurar pipelines aplica (CA-044), com a mesma validação do caminho manual e os parâmetros relidos do provedor. A versão nova fica com origem `assist`, sempre em rascunho: aprovar continua sendo um passo humano separado.
7. **Auditoria.** Configurar provedores e MCP, iniciar, rodar (com `actor_kind = assist`, as ferramentas usadas e os tokens), aplicar e descartar sessões ficam auditados, sem credenciais.

## Consequências

**Positivas**

- Sem IA, nada muda: o caminho manual faz tudo.
- O pior caso de uma resposta maliciosa ou errada é uma proposta recusada ou corrigida pela pessoa.
- A organização escolhe o provedor, inclusive um modelo local que não manda dados para fora.

**Negativas**

- Modelos compatíveis com OpenAI variam muito no uso de ferramentas. O teste de conexão confere só a chave e o modelo; a qualidade só aparece na proposta.
- A edição assistida de pipelines já existentes (RF-187, evolução) fica para depois.
- Servidores MCP que só falam stdio precisam de um adaptador HTTP fora do Nexo.

## Referências

- Especificação v1.1: §19.3–19.7, RF-172–187, RN-038–041, RN-049, CA-027–029, CA-043, CA-044, P-004, P-005
- `packages/assist` (provedores, cliente MCP, laço do agente, revisão da proposta), `packages/core/src/assist/service.ts`, migração `0009_assist.sql`
