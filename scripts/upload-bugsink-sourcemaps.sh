#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

: "${BUGSINK_URL:?Укажи URL Bugsink}"
: "${BUGSINK_PROJECT:?Укажи имя проекта Bugsink}"
: "${SENTRY_AUTH_TOKEN:?Передай API-токен Bugsink}"
: "${APP_RELEASE:?Укажи полный SHA сборки}"

node scripts/verify-release.mjs .release

node node_modules/@sentry/cli/bin/sentry-cli --url "$BUGSINK_URL" sourcemaps \
  --org bugsinkhasnoorgs --project "$BUGSINK_PROJECT" upload --strict --wait \
  .release

# Uploading must not change the files that will be packaged in Docker.
node scripts/verify-release.mjs .release
