FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm ci

COPY packages/core/src ./packages/core/src
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/server/src ./packages/server/src
COPY packages/server/tsconfig.json ./packages/server/tsconfig.json
COPY packages/cli/src ./packages/cli/src
COPY packages/cli/tsconfig.json ./packages/cli/tsconfig.json

RUN npm run build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SHAREPLAN_HOST=0.0.0.0 \
    SHAREPLAN_PORT=8788 \
    SHAREPLAN_DATA_DIR=/var/lib/shareplan

WORKDIR /app

RUN mkdir -p /var/lib/shareplan \
  && chown node:node /var/lib/shareplan

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist

USER node

EXPOSE 8788

CMD ["node", "packages/server/dist/cli.js"]
