# ADR-015 — E-mail pelo SMTP da instalação e retenção aplicada pelo worker

**Status:** Aceita · 21/11/2026, ao implementar o incremento 7. Concretiza o item 6 do ADR-011 e resolve P-010 com os prazos sugeridos em 22.1, configuráveis por organização.

## Contexto

O incremento 7 traz e-mail (RF-126–130, CA-018) e retenção configurável (Q-008, RF-146, 22.1). A instalação é self-hosted (ADR-012): cada empresa tem o próprio servidor de e-mail e o próprio armazenamento, e não existe serviço central do projeto.

## Decisão

### E-mail

1. **SMTP da instalação**, por variáveis de ambiente: `SMTP_URL` (`smtp://` com STARTTLS ou `smtps://`) e `SMTP_FROM`. Sem elas, nada entra na fila e as telas dizem que o e-mail não está configurado.
2. **Fila de saída no banco** (`notifications_emails`), gravada na mesma transação do fato que gerou o e-mail. O worker envia (nodemailer), com até 5 tentativas e espera crescente, e cada tentativa fica no histórico (RF-130).
3. **Usos:** regra de evento com canal e-mail (até 20 destinatários; o aviso no painel continua existindo), convite e redefinição de senha (o mesmo link de uso único do ADR-011, que continua aparecendo para quem gerou) e e-mail de teste.
4. **Conteúdo sensível.** Convite e redefinição levam link de uso único: o corpo é apagado depois do envio (ou da última falha). A linha de uma redefinição da instância não tem organização e só é visível numa transação também sem organização.
5. O e-mail de aviso leva o resumo (resultado, testes, desempenho) e o link para o painel, que exige login. Ele não gera link público automaticamente.

### Retenção

1. Política por organização, com os padrões de 22.1: **artefatos originais 90 dias** (cobre relatórios, prints, vídeos e traces, que chegam dentro deles), **testes e métricas detalhados 365 dias** e **histórico de e-mails 90 dias**.
2. O worker aplica a política de hora em hora, uma organização por vez e sob RLS. O arquivo do artefato é apagado e o registro fica como `expired`. Os detalhes de testes e métricas somem, mas o estado da execução (o que rodou, como terminou, o tipo de falha) fica.
3. Logs não são guardados pelo Nexo (são lidos do provedor na hora), então não entram na política.
4. Cada aplicação que apagou algo é auditada (`retention.apply`).

## Consequências

**Positivas**

- Nenhuma dependência externa nova além do SMTP que a empresa já tem.
- Falha de SMTP não bloqueia nada: a execução termina, o aviso aparece no painel e o e-mail tenta de novo.

**Negativas**

- Sem SMTP, convites continuam dependendo de alguém entregar o link.
- Os metadados das execuções não expiram nesta versão; isso fica para quando houver volume real que justifique (P-010 continua aberta quanto a volumes e orçamento).
- "Relatórios preservados explicitamente" (22.1) ainda não existem: todo artefato segue o prazo da organização.

## Referências

- Especificação v1.1: RF-126–130, RF-146, Q-008, 22.1, CA-018, P-010
- [ADR-011](ADR-011-acesso-local-por-convite.md), item 6
- `packages/core/src/notifications/email.ts`, `packages/core/src/admin/retention.ts`, `apps/worker/src/mailer.ts`
