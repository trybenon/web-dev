# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS manifests
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json

FROM manifests AS build
RUN npm ci
COPY . .
RUN npm run build

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=server --workspace=shared --include-workspace-root=false

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/client/dist ./client/dist
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
