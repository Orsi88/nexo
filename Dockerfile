# Imagens da instalação self-hosted (ADR-001, RNF-032).
# A api, o worker, o report-origin e a migração usam a mesma imagem "runtime"; o proxy serve o painel web.
# O Node.js 24 executa TypeScript direto (remoção de tipos), sem etapa de compilação do backend.

ARG NODE_IMAGE=node:24.22.3-alpine3.24

FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/assist/package.json packages/assist/
COPY packages/connector-azure-devops/package.json packages/connector-azure-devops/
COPY packages/connector-github/package.json packages/connector-github/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/processor-junit/package.json packages/processor-junit/
COPY packages/processor-k6/package.json packages/processor-k6/
COPY packages/processor-playwright/package.json packages/processor-playwright/
COPY packages/processor-sdk/package.json packages/processor-sdk/

FROM manifests AS prod-deps
RUN npm install --omit=dev --no-audit --no-fund

FROM manifests AS web-build
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build:web

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# Pasta dos artefatos: o volume novo herda o dono daqui, e o processo roda como "node".
RUN mkdir -p /data/artifacts && chown node:node /data/artifacts
USER node
CMD ["node", "apps/api/src/main.ts"]

FROM caddy:2.11.9-alpine AS proxy
COPY deploy/compose/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv/web
