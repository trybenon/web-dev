#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

: "${BUGSINK_URL:?Укажи URL Bugsink}"
: "${BUGSINK_PROJECT:?Укажи имя проекта Bugsink}"
: "${SENTRY_AUTH_TOKEN:?Передай API-токен Bugsink}"

if [ ! -d client/dist ] || [ -z "$(find client/dist -type f -name '*.js.map')" ]; then
  printf '%s\n' "В client/dist нет карт. Сначала выполни npm run build." >&2
  exit 1
fi

npx --yes @sentry/cli@2 sourcemaps inject client/dist
npx --yes @sentry/cli@2 --url "$BUGSINK_URL" sourcemaps \
  --org bugsinkhasnoorgs --project "$BUGSINK_PROJECT" upload client/dist