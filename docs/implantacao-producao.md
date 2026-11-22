# Implantação em produção (VPS com domínio e TLS)

Guia para colocar uma instância no ar num servidor Linux próprio, acessível por domínio com HTTPS. O cadastro continua fechado: só entra quem for convidado ([ADR-011](adr/ADR-011-acesso-local-por-convite.md)). Para rodar na própria máquina, basta a [instalação self-hosted](../README.md#instalação-self-hosted).

Os exemplos usam `painel.example.com` e `relatorios.example.com`. Os nomes reais da sua instalação ficam só no `.env` do servidor, que nunca vai para o git (RNF-033).

## O que é preciso

- **Servidor:** Linux (testado como alvo: Ubuntu 24.04), 2 vCPU e **4 GB de RAM**. A imagem é construída no próprio servidor, e com 2 GB o build costuma faltar memória. Uns 40 GB de disco para começar; artefatos e relatórios crescem com o uso (a retenção é configurável, [ADR-015](adr/ADR-015-email-e-retencao.md)).
- **Dois nomes de host**, um para o painel e outro para os relatórios. Precisam ser diferentes: os relatórios HTML de terceiros rodam numa origem separada, sem acesso à sessão do painel ([ADR-007](adr/ADR-007-origem-separada-para-relatorios.md)). Um domínio separado para os relatórios isola ainda mais que um subdomínio, mas subdomínio já atende.
- **Docker** com o plugin Compose **2.24.4 ou mais novo**.

## Atalho: instalação guiada

Com o DNS do passo 1 já criado, o script [install.sh](../deploy/compose/install.sh) faz os passos 2 a 5 num servidor novo: instala o Docker se faltar, configura o firewall, baixa o código em `/opt/nexo`, gera o `.env` com segredos novos, sobe tudo e cria o primeiro administrador. Ele pergunta só os dois endereços, o seu nome, o e-mail e o nome da organização.

```bash
curl -fsSL https://raw.githubusercontent.com/Orsi88/nexo/main/deploy/compose/install.sh -o install.sh
less install.sh   # leia antes de rodar
bash install.sh
```

Rodar de novo é seguro: um `.env` existente é mantido. Os passos abaixo descrevem o mesmo processo à mão.

## 1. DNS

No painel de DNS do domínio, crie dois registros `A` (e `AAAA`, se o servidor tiver IPv6) apontando para o IP do servidor:

| Nome | Tipo | Valor |
|---|---|---|
| `painel` | A | IP do servidor |
| `relatorios` | A | IP do servidor |

Confira antes de seguir: `nslookup painel.example.com` precisa devolver o IP do servidor. Sem isso o Caddy não consegue emitir os certificados.

## 2. Servidor

```bash
# Docker e Compose (pule se a imagem do servidor já vier com Docker)
curl -fsSL https://get.docker.com | sh
docker compose version   # 2.24.4 ou mais novo

# Firewall: só SSH e web
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw enable
```

Se o provedor tiver um firewall próprio no painel de controle, libere as mesmas portas (22, 80 e 443) lá também. Só o proxy publica portas; banco, storage, api e worker ficam na rede interna do Compose.

## 3. Código e configuração

```bash
git clone https://github.com/Orsi88/nexo.git /opt/nexo
cd /opt/nexo/deploy/compose
cp .env.example .env
chmod 600 .env
```

Gere um valor diferente para cada segredo. Senhas e chaves em **hex**: a senha do banco entra numa URL de conexão, e os caracteres `/` e `+` do base64 a quebrariam. Só a chave mestra usa base64, que é o formato que ela exige.

```bash
openssl rand -hex 32      # POSTGRES_PASSWORD, APP_DB_PASSWORD, S3_SECRET_KEY (uma vez para cada)
openssl rand -hex 16      # S3_ACCESS_KEY
openssl rand -base64 32   # SECRETS_MASTER_KEY
```

E preencha o `.env`:

```env
POSTGRES_PASSWORD=<hex>
APP_DB_PASSWORD=<hex>
S3_ACCESS_KEY=<hex>
S3_SECRET_KEY=<hex>
SECRETS_MASTER_KEY=<base64>

PUBLIC_BASE_URL=https://painel.example.com
REPORT_ORIGIN_URL=https://relatorios.example.com
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml

# Opcional: sem SMTP, convites e redefinições mostram o link só no painel
SMTP_URL=smtps://usuario:senha@smtp.example.com:465
SMTP_FROM=Nexo <nexo@example.com>
```

A linha `COMPOSE_FILE` faz todo `docker compose ...` nesta pasta usar também o [docker-compose.prod.yml](../deploy/compose/docker-compose.prod.yml). Ele troca as portas 8080/8081 por 80/443 e usa o [Caddyfile.prod](../deploy/compose/Caddyfile.prod), que lê os dois endereços do `.env`. Nenhum arquivo versionado precisa ser editado no servidor, então `git pull` não gera conflito.

Confira a configuração final antes de subir:

```bash
docker compose config --quiet && echo ok
```

## 4. Subir

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f proxy   # acompanhe a emissão dos certificados
```

O primeiro build leva alguns minutos. Quando o proxy mostrar os certificados emitidos, `https://painel.example.com` abre a tela de login.

## 5. Primeiro acesso

Crie o administrador e a primeira organização:

```bash
docker compose run --rm api node apps/api/src/bootstrap.ts \
  --email admin@example.com --name "Seu nome" --org "Sua organização" --slug sua-organizacao
```

O comando imprime um link de uso único para definir a senha. Enquanto a tela não existe, conclua pela API:

```bash
curl -X POST https://painel.example.com/api/auth/password-reset/complete \
  -H "content-type: application/json" -H "origin: https://painel.example.com" \
  -d '{"token": "<token do link>", "password": "<senha com 12 ou mais caracteres>"}'
```

Depois disso, as outras pessoas entram por convite, pelo próprio painel.

## 6. Provedores

O Nexo só faz conexões de saída para os provedores; nenhuma porta extra precisa ser aberta. As integrações são criadas no painel, com um token por provedor:

| Provedor | Permissões do token |
|---|---|
| GitHub Actions (github.com) | **Actions**: leitura e escrita (disparar e cancelar execuções); **Contents** e **Workflows**: leitura e escrita (para gravar o arquivo da pipeline) |
| Azure DevOps (dev.azure.com) | **Build**: Read & execute; **Code**: Read & Write (para gravar o arquivo da pipeline) |

`AZURE_DEVOPS_EXTRA_HOSTS` e `GITHUB_EXTRA_HOSTS` só são necessários para servidores instalados na rede de uma empresa; nesse caso, o servidor do Nexo precisa alcançar essa rede.

## 7. Backup

Três coisas precisam de cópia: o banco, os volumes de arquivos e o `.env`.

```bash
cd /opt/nexo/deploy/compose
mkdir -p /var/backups/nexo

# Banco (diário; o cron abaixo faz isso às 3h e mantém 14 dias)
docker compose exec -T postgres pg_dump -U painel_admin painel | gzip > /var/backups/nexo/painel-$(date +%F).sql.gz
```

```cron
0 3 * * * cd /opt/nexo/deploy/compose && docker compose exec -T postgres pg_dump -U painel_admin painel | gzip > /var/backups/nexo/painel-$(date +\%F).sql.gz && find /var/backups/nexo -name 'painel-*.sql.gz' -mtime +14 -delete
```

- **Arquivos:** os volumes `storage-data` e `artifacts-data` guardam relatórios e artefatos originais. Use o snapshot do provedor ou copie os volumes com o serviço parado.
- **`.env` fora do servidor:** guarde uma cópia num cofre de senhas. Sem a `SECRETS_MASTER_KEY`, as credenciais dos provedores guardadas no banco ficam ilegíveis, mesmo com o backup em mãos.
- **Restaurar o banco:** `gunzip -c painel-AAAA-MM-DD.sql.gz | docker compose exec -T postgres psql -U painel_admin painel`, numa instalação nova antes do primeiro uso.

Copiar os backups só para o mesmo servidor não protege contra a perda dele: mande-os também para outro lugar (outro servidor, bucket ou a sua máquina).

## 8. Atualizar

```bash
cd /opt/nexo
git pull
cd deploy/compose
docker compose up -d --build
```

O passo `migrate` roda sozinho antes da api subir (RNF-032). Faça um backup do banco antes de atualizar.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `docker compose config` reclama de `!override` | Compose antigo; atualize para 2.24.4+ |
| Proxy em loop pedindo certificado | DNS ainda não aponta para o servidor, ou as portas 80/443 estão fechadas no firewall do provedor |
| Painel abre, mas relatórios não carregam no iframe | `REPORT_ORIGIN_URL` diferente do host configurado no DNS, ou igual ao do painel |
| Login falha com erro de origem | `PUBLIC_BASE_URL` diferente do endereço usado no navegador (inclusive `https://`) |
| Integração recusada ao salvar | Token sem as permissões da tabela acima, ou `SECRETS_MASTER_KEY` ausente |
