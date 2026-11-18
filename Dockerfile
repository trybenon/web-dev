# syntax=docker/dockerfile:1
ARG APP_BUILD_STAGE=build

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
ARG APP_RELEASE
ARG BUGSINK_DSN
RUN VITE_APP_RELEASE="$APP_RELEASE" VITE_BUGSINK_DSN="$BUGSINK_DSN" npm run build \
    && mkdir /out \
    && cp -r --parents client/dist server/dist shared/dist /out/

# Give each bundle a debug ID and keep workspace paths distinct in the upload.
FROM build AS release-build
RUN printf '%s\n' "$APP_RELEASE" | grep -Eq '^[0-9a-f]{40}$' \
    && node_modules/.bin/sentry-cli sourcemaps inject /out

FROM release-build AS release-upload
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG BUGSINK_URL
ARG BUGSINK_PROJECT
ARG BUGSINK_UPLOAD_NONCE
# BuildKit exposes the token only during the upload.
RUN --mount=type=secret,id=bugsink_auth_token,env=SENTRY_AUTH_TOKEN,required=true \
    node_modules/.bin/sentry-cli --url "$BUGSINK_URL" sourcemaps \
      --org bugsinkhasnoorgs --project "$BUGSINK_PROJECT" upload --strict --wait /out

FROM ${APP_BUILD_STAGE} AS app-files
RUN find /out -type f -name '*.map' -delete

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=server --workspace=shared --include-workspace-root=false

FROM base AS runtime
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
COPY --from=app-files /out/ ./
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
