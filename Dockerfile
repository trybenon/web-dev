# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS manifests
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json

FROM manifests AS build-dependencies
RUN npm ci
COPY . .

FROM build-dependencies AS build
ARG APP_RELEASE
ARG BUGSINK_DSN
RUN VITE_APP_RELEASE="$APP_RELEASE" VITE_BUGSINK_DSN="$BUGSINK_DSN" npm run build

# Compilers, debug ID injection and source map checks all run inside Docker.
FROM build-dependencies AS release-build
ARG APP_RELEASE
ARG BUGSINK_DSN
ENV APP_RELEASE=$APP_RELEASE
RUN BUGSINK_DSN="$BUGSINK_DSN" npm run build:release && npm run check:release

# Only the upload instruction can access the token; it never enters image layers.
FROM release-build AS uploaded-release
ARG BUGSINK_URL
ARG BUGSINK_PROJECT
ARG BUGSINK_UPLOAD_NONCE
RUN --mount=type=secret,id=bugsink_auth_token,required=true \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/bugsink_auth_token)" \
    BUGSINK_URL="$BUGSINK_URL" BUGSINK_PROJECT="$BUGSINK_PROJECT" \
    npm run upload:sourcemaps
RUN find .release/client/dist .release/server/dist .release/shared/dist -name '*.map' -delete

# CI exercises packaging without requiring a real Bugsink token or sending events.
FROM release-build AS release-check-files
RUN find .release/client/dist .release/server/dist .release/shared/dist -name '*.map' -delete

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=server --workspace=shared --include-workspace-root=false

FROM base AS runtime-base
ARG APP_RELEASE
LABEL org.opencontainers.image.source="https://github.com/trybenon/web-dev" \
    org.opencontainers.image.revision=$APP_RELEASE
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_RELEASE=$APP_RELEASE
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=manifests /app/server/package.json ./server/package.json
COPY --from=manifests /app/shared/package.json ./shared/package.json
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]

FROM runtime-base AS release
COPY --from=uploaded-release /app/.release/server/dist ./server/dist
COPY --from=uploaded-release /app/.release/shared/dist ./shared/dist
COPY --from=uploaded-release /app/.release/client/dist ./client/dist

FROM runtime-base AS release-check
COPY --from=release-check-files /app/.release/server/dist ./server/dist
COPY --from=release-check-files /app/.release/shared/dist ./shared/dist
COPY --from=release-check-files /app/.release/client/dist ./client/dist

# Local Docker Compose continues to build directly from source.
FROM runtime-base AS runtime
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/client/dist ./client/dist
