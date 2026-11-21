# ADR-011 — Acesso local por convite, com links gerados pelo administrador

**Status:** Aceita · Aceita em 20/11/2026, ao iniciar o incremento 1. Resolve P-003 para a primeira entrega.

## Contexto

O login local está confirmado (Q-011, RN-048, RNF-026), mas a especificação deixa em aberto como alguém passa a ter conta: convite, cadastro aberto ou fechado, e recuperação de senha (P-003). O envio de e-mail só chega no incremento 7, então convite e recuperação não podem depender de SMTP agora. A instalação é self-hosted (Q-001), e cada instalação precisa de um primeiro administrador.

## Opções consideradas

- **Admin inicial + convites (cadastro fechado)**
- Cadastro aberto, em que cada pessoa cria a própria conta e organização
- As duas, escolhidas por variável de ambiente

Para convite e recuperação sem e-mail:

- **Link de uso único gerado por um administrador e entregue por fora**
- Adiar a recuperação de senha até existir SMTP

## Decisão

1. **Primeiro acesso.** O comando `bootstrap` (`apps/api/src/bootstrap.ts`) cria o administrador da instância e a primeira organização, com ele como admin dela, e imprime um link de uso único para definir a senha. Ele recusa se já houver um administrador da instância. Nenhuma senha passa por argumento ou variável de ambiente.
2. **Cadastro fechado.** Só entra quem for convidado. Quem pode gerenciar usuários (matriz do §6 e política da organização) convida um e-mail com um papel e recebe um link de uso único. Quem não é admin nunca concede, altera ou remove o papel admin.
3. **Conta que já existe** só aceita um convite autenticada como ela mesma, para ninguém anexar a conta de outra pessoa a uma organização.
4. **Administrador da instância.** Cria organizações e gera links de redefinição de senha. Não ganha acesso aos dados de nenhuma organização: para isso precisa ser membro, como todo mundo. O admin de uma organização **não** gera redefinição de senha, porque a conta pode participar de outras organizações e isso permitiria tomar uma conta que é admin em outra.
5. **Tokens.** 256 bits aleatórios; só o hash SHA-256 fica no banco. O link leva o token no fragmento (`#token=`), que o navegador não envia ao servidor nem em `Referer`. Emitir um link novo revoga o anterior do mesmo tipo. Validade padrão: convite 72 h, redefinição 24 h (configuráveis).
6. **Quando o e-mail existir** (incremento 7), o mesmo token passa a ir por e-mail; o modelo não muda.

## Consequências

**Positivas**

- Nenhuma conta nasce sem que um administrador queira; adequado a uma instalação interna.
- Funciona sem SMTP e sem mudar o modelo quando o e-mail chegar.
- Separar administrador da instância e admin da organização mantém o isolamento entre organizações (RN-002) também na recuperação de acesso.

**Negativas**

- Até o incremento 7, alguém precisa entregar o link por um canal seguro, fora da plataforma.
- Sem a tela (P-013), definir a senha exige chamar a API diretamente.
- Uma oferta SaaS futura vai precisar de cadastro aberto; isso será um novo ADR.

## Referências

- [Documento de arquitetura](../arquitetura.md), §8 (Autenticação)
- Especificação v1.1: Q-011, RN-048, RNF-026, RF-131–140, P-003
