#!/usr/bin/env bash
# Instalação de produção num servidor Linux novo (Ubuntu/Debian), com domínio e TLS automático.
# Faz: Docker (se faltar), firewall, código em /opt/nexo, .env com segredos gerados, subida e o
# primeiro administrador. Guia completo: docs/implantacao-producao.md
#
# Uso, como root:
#   curl -fsSL https://raw.githubusercontent.com/Orsi88/nexo/main/deploy/compose/install.sh -o install.sh
#   less install.sh      # leia antes de rodar
#   bash install.sh
#
# Pode rodar de novo: um .env existente é mantido (os segredos nunca são regerados).
set -euo pipefail

DIR=${NEXO_DIR:-/opt/nexo}
REPO=${NEXO_REPO:-https://github.com/Orsi88/nexo.git}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mErro: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "rode como root (sudo bash install.sh)"

ask_url() {
  local prompt=$1 value
  while true; do
    read -rp "$prompt (ex.: https://painel.example.com): " value
    value=${value%/}
    if [[ $value =~ ^https://[a-z0-9.-]+$ ]]; then
      printf '%s' "$value"
      return
    fi
    echo "  Use https:// seguido só do nome do host, sem caminho nem porta."
  done
}

say "Endereços e administrador"
PANEL_URL=$(ask_url "Endereço do painel")
REPORT_URL=$(ask_url "Endereço dos relatórios")
[ "$PANEL_URL" != "$REPORT_URL" ] || fail "painel e relatórios precisam de endereços diferentes (ADR-007)"
read -rp "E-mail do administrador: " ADMIN_EMAIL
read -rp "Seu nome: " ADMIN_NAME
read -rp "Nome da organização: " ORG_NAME
ORG_SLUG=$(printf '%s' "$ORG_NAME" | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')
[ -n "$ORG_SLUG" ] || ORG_SLUG=minha-organizacao

say "Conferindo o DNS"
SERVER_IPS=$(hostname -I 2>/dev/null || true)
for url in "$PANEL_URL" "$REPORT_URL"; do
  host=${url#https://}
  ip=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}')
  if [ -z "$ip" ]; then
    echo "  $host ainda não resolve. Crie o registro A e espere propagar antes de continuar."
    read -rp "  Continuar mesmo assim? [s/N] " ok; [[ $ok =~ ^[sS]$ ]] || exit 1
  elif [[ " $SERVER_IPS " != *" $ip "* ]]; then
    echo "  $host aponta para $ip, que não é um IP deste servidor ($SERVER_IPS)."
    read -rp "  Continuar mesmo assim? [s/N] " ok; [[ $ok =~ ^[sS]$ ]] || exit 1
  else
    echo "  $host -> $ip ok"
  fi
done

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
compose_version=$(docker compose version --short 2>/dev/null || echo 0)
if [ "$(printf '%s\n%s\n' "2.24.4" "${compose_version#v}" | sort -V | head -n1)" != "2.24.4" ]; then
  fail "Docker Compose $compose_version é antigo; precisa de 2.24.4 ou mais novo (apt-get install docker-compose-plugin)"
fi
echo "  Docker Compose $compose_version ok"

say "Firewall (SSH, 80 e 443)"
command -v ufw >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq ufw; }
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
echo "  ok. Se o provedor tiver firewall no painel, libere 22, 80 e 443 lá também."

say "Código em $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
  git clone "$REPO" "$DIR"
fi
cd "$DIR/deploy/compose"

say "Configuração (.env)"
if [ -f .env ]; then
  echo "  .env já existe: mantido como está (segredos não são regerados)."
else
  hex() { openssl rand -hex 32; }
  umask 077
  cat > .env <<EOF
# Gerado por install.sh em $(date -u +%Y-%m-%dT%H:%MZ). Nunca versione este arquivo (RNF-033).
# Guarde uma cópia fora do servidor: sem SECRETS_MASTER_KEY as credenciais dos provedores ficam ilegíveis.
POSTGRES_PASSWORD=$(hex)
APP_DB_PASSWORD=$(hex)
S3_ACCESS_KEY=$(openssl rand -hex 16)
S3_SECRET_KEY=$(hex)
S3_BUCKET=painel-artifacts
SECRETS_MASTER_KEY=$(openssl rand -base64 32)
AZURE_DEVOPS_EXTRA_HOSTS=
GITHUB_EXTRA_HOSTS=
SMTP_URL=
SMTP_FROM=Nexo <nexo@${PANEL_URL#https://}>
PUBLIC_BASE_URL=$PANEL_URL
REPORT_ORIGIN_URL=$REPORT_URL
LOG_LEVEL=info
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
EOF
  chmod 600 .env
  echo "  .env criado com segredos novos."
fi
docker compose config --quiet

say "Subindo (o primeiro build leva alguns minutos)"
docker compose up -d --build

say "Esperando a api ficar pronta"
for _ in $(seq 1 90); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
    echo "  api pronta"
    break
  fi
  sleep 5
done

say "Administrador"
if ! docker compose run --rm api node apps/api/src/bootstrap.ts \
  --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" --org "$ORG_NAME" --slug "$ORG_SLUG"; then
  echo "  O bootstrap não concluiu (o administrador já existe?). Veja: docker compose logs api"
fi

cat <<EOF

Pronto.
  Painel:      $PANEL_URL
  Relatórios:  $REPORT_URL

Próximos passos:
  1. Defina a senha com o link acima. Enquanto a tela não existe:
     curl -X POST $PANEL_URL/api/auth/password-reset/complete \\
       -H "content-type: application/json" -H "origin: $PANEL_URL" \\
       -d '{"token": "<token do link>", "password": "<12 ou mais caracteres>"}'
  2. Copie $DIR/deploy/compose/.env para o seu gerenciador de senhas.
  3. Configure o backup diário do banco (docs/implantacao-producao.md, seção 7).

Os certificados TLS saem no primeiro acesso; acompanhe com: docker compose logs -f proxy
EOF
