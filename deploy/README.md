# Автодеплой main

После push/merge в `main` workflow `CI` выполняет все проверки, включая e2e
и тесты отката. Только после их успеха вызывается `Deploy`: он собирает
клиент, сервер и shared один раз, добавляет debug ID и загружает карты
исходников в Bugsink внутри многостадийной Docker-сборки, вызываемой
`docker compose build --push app`. После обработки карт упаковывает эти же файлы в
образы `linux/amd64` и `linux/arm64`, публикует
`ghcr.io/trybenon/web-dev:<полный-SHA>` и запускает деплой по SSH.
`APP_RELEASE` записан в образ, клиент собран с тем же `VITE_APP_RELEASE`.
Production-сборка не компилируется на хосте GitHub Runner. На VPS выполняются
`docker compose pull` и `docker compose up`: скачанный образ повторно не собирается.

## Сборка и запуск через Compose

Обычный локальный запуск без настроек мониторинга:

```bash
docker compose up --build --detach --wait
```

Полный production-вариант с Bugsink: заполнить параметры из `.env.example`
в локальном `.env`, затем из корня репозитория выполнить:

```bash
export APP_RELEASE="$(git rev-parse HEAD)"
make run-release
# Или без make:
docker compose -f docker-compose.yml -f compose.release.yml up --build --detach --wait
```

Только сборка — `make build-release` или
`docker compose -f docker-compose.yml -f compose.release.yml build app`.
Для публикации двух архитектур добавляется `-f compose.publish.yml` и
используется `build --push app`. Само приложение запускается одним Node-процессом
в контейнере: Vue, API и WebSocket. Docker/Compose достаточно для сборки и запуска;
Node/npm на хосте нужны только для разработки и отдельных тестов.

Токен передаётся через `build.secrets` и `RUN --mount=type=secret`.
Успешная загрузка карт является обязательной стадией production-образа.
При повторной сборке той же версии `make` задаёт `BUGSINK_UPLOAD_NONCE`,
чтобы повторить загрузку карт без повторной компиляции. Actions задаёт
nonce из номера запуска и попытки. Прямой Compose-вызов без nonce может
переиспользовать уже успешную загрузку из кеша; для принудительной загрузки
добавить `BUGSINK_UPLOAD_NONCE=$(date +%s)` перед командой.

`concurrency` разрешает только один деплой одновременно. Перед сборкой и
перед отправкой на сервер workflow сверяет SHA с текущим `main`, пропуская
устаревшие запуски. На VPS дополнительная блокировка `flock` защищает от
одновременного ручного отката. Запуск через systemd позволяет скрипту
завершиться и выполнить откат при потере SSH-соединения с GitHub Runner.

## Схема сервера

```text
krozmo.online → Cloudflare Tunnel → watch-together-proxy:8080
             → watch-together-web:3000
```

Production Compose управляет только приложением: контейнер
`watch-together-web`, сеть `watch-together-net`, порт `127.0.0.1:18080`.
Сеть должна уже существовать. Caddy и cloudflared продолжают работать
отдельно. Рабочие файлы автодеплоя находятся в `/opt/watch-together-deploy`;
исходный checkout `/opt/watch-together` для деплоя не нужен.

При обновлении контейнер пересоздаётся: активные WebSocket-соединения
обрываются, комнаты в памяти сервера теряются. Перерыв длится время
перезапуска приложения.

## Однократная подготовка

Нужны Linux с systemd, Docker Engine, Docker Compose **2.24+**, Bash,
`curl`, `python3` и `flock` (пакет `util-linux`). Workflow рассчитан на SSH
пользователя `root`: он вызывает системный `systemd-run`. SSH-порт — 22.

После входа на VPS проверить:

```bash
docker compose version
docker network inspect watch-together-net
docker ps --format '{{.Names}} {{.Image}}'
command -v systemd-run curl python3 flock
install -m 700 -d /opt/watch-together-deploy
```

Дополнительные настройки можно сохранить в
`/opt/watch-together-deploy/app.env` (права `600`). `BUGSINK_DSN` Actions
доставляет отдельно в `monitoring.env`, который имеет приоритет над `app.env`.
`APP_RELEASE` в эти файлы не добавлять: версия берётся из образа.
Перед первым запуском проверить, нужны ли переменные, mounts или
другие параметры старого контейнера: production Compose описывает
приложение без постоянных volumes.

### SSH-ключ для Actions

На своём Mac создать отдельный ключ и добавить его публичную часть на VPS.
Вторая команда один раз запросит текущий пароль сервера:

```bash
ssh-keygen -t ed25519 -C github-actions-watch-together -N '' -f ~/.ssh/watch-together-actions
cat ~/.ssh/watch-together-actions.pub | ssh root@179.253.72.23 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
ssh -i ~/.ssh/watch-together-actions -o IdentitiesOnly=yes -o BatchMode=yes root@179.253.72.23 'docker compose version'
```

В репозитории открыть **Settings → Secrets and variables → Actions → New
repository secret**:

| Secret               | Значение                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `DEPLOY_HOST`        | `179.253.72.23`                                                   |
| `DEPLOY_USER`        | `root`                                                            |
| `DEPLOY_SSH_KEY`     | Полное содержимое `~/.ssh/watch-together-actions` (закрытый ключ) |
| `DEPLOY_KNOWN_HOSTS` | Проверенная запись SSH host key для VPS                           |

На Mac закрытый ключ можно скопировать в буфер, затем вставить прямо в
поле GitHub Secret:

```bash
pbcopy < ~/.ssh/watch-together-actions
```

Запись host key взять из `known_hosts` после доверенного входа на сервер:

```bash
ssh-keygen -F 179.253.72.23 -f ~/.ssh/known_hosts | sed '/^#/d' | pbcopy
```

Не коммитить ключи и не помещать их в Issues, логи CI или переписку.
Workflow использует `StrictHostKeyChecking=yes` с этой записью.

### Настройки Bugsink

В **Repository secrets** добавить:

| Secret               | Значение                                              |
| -------------------- | ----------------------------------------------------- |
| `BUGSINK_DSN`        | DSN проекта для клиента и сервера                     |
| `BUGSINK_AUTH_TOKEN` | API-токен с правом загрузки debug files в этот проект |

Во вкладке **Variables** добавить:

| Variable          | Значение                                                 |
| ----------------- | -------------------------------------------------------- |
| `BUGSINK_URL`     | Адрес панели Bugsink, например `https://bugsink.example` |
| `BUGSINK_PROJECT` | Slug проекта, соответствующего DSN                       |

Токен доступен проверке наличия настроек и Compose build secret.
В Dockerfile он смонтирован только на время инструкции загрузки карт;
он не передаётся в Vite, Docker build args, образ или на VPS.
Сервер получает DSN через SSH в файл с правами `600`.
При автоматическом откате восстанавливается и конфигурация мониторинга.

Сборка проверяет `sourcesContent`, совпадение debug ID, SHA и хешей файлов.
В CI вызываются ошибки Vue в Chromium и собранного серверного
JS: SDK должны сохранить release/debug ID, а карты — восстановить исходные
`.vue`/`.ts` файлы и строки кода. Chromium перехватывает внешний HTTP,
серверный SDK использует транспорт в памяти: тестовые события не уходят
в Bugsink.

### Доступ к образу в GHCR

Actions публикует образ через свой `GITHUB_TOKEN` с `packages: write`.
Серверу нужен доступ к чтению образа. Выбрать один способ:

- После первой публикации открыть пакет `web-dev` в профиле владельца →
  **Package settings → Change visibility → Public**. Затем повторить CI
  для текущего `main`. Публичный контейнер скачивается без авторизации.
- Для приватного пакета один раз выполнить `docker login ghcr.io -u trybenon`
  на VPS от `root`, вводя PAT classic со scope `read:packages` в запрос пароля.

Первое скачивание недоступного пакета завершится ошибкой до остановки
работающего приложения. Публичность репозитория сама по себе не делает
новый пакет публичным.

## Первый запуск и проверка

Влить изменения в `main` после ревью и дождаться `CI → Deploy main`.
Если настройки были добавлены позже, в Actions открыть **CI → Run workflow →
main**: повторно пройдут проверки и затем деплой текущего коммита.
Запуск CI для другой ветки production не обновляет.

Скрипт сначала скачивает образ. Старый контейнер, запущенный вручную,
останавливается и переименовывается в
`watch-together-web-before-autodeploy-<timestamp>`. Он сохраняется вместе
со своей конфигурацией для отката. Compose создаёт новое приложение с
прежним именем, ожидает healthcheck и проверяет:

1. `http://127.0.0.1:18080/api/health` — локальный SHA нового образа.
2. `https://krozmo.online/api/health` — публичный ответ с тем же SHA.

При ошибке нового контейнера, недоступном публичном адресе или другом SHA
скрипт возвращает прошлый образ/контейнер; workflow остаётся красным.
После успешного обновления:

```bash
curl -fsS "https://krozmo.online/api/health?check=$(date +%s)"
# {"status":"ok","sha":"<полный SHA коммита main>"}
```

На VPS журнал доступен через:

```bash
journalctl -u 'watch-together-deploy-*' --no-pager -n 100
cd /opt/watch-together-deploy
docker compose --env-file .env -f compose.yml ps
docker compose --env-file .env -f compose.yml logs --tail 100 app
```

## Ручной откат

После хотя бы двух успешных управляемых деплоев сохранены `previous.env`
и `previous-compose.yml`. `APP_IMAGE` в `previous.env` содержит точный
локальный image ID предыдущего контейнера, поэтому повторный push того
же тега не изменит цель отката. Не удалять этот образ через image prune,
пока он нужен для отката.

На VPS от `root`:

```bash
cd /opt/watch-together-deploy
set -a
. ./previous.env
set +a
bash /opt/watch-together-deploy/deploy.sh "$APP_IMAGE" "$APP_SHA" /opt/watch-together-deploy/previous-compose.yml /opt/watch-together-deploy https://krozmo.online/api/health /opt/watch-together-deploy/previous-monitoring.env
```

Ручной откат тоже проверяет публичный SHA и восстанавливает текущую версию,
если откат не прошёл проверку. Следующий успешный CI на `main` снова
развернёт `main`; для постоянного возврата сделать revert через PR.

Для возврата к исходному контейнеру после самого первого деплоя найти его
полное имя командой `docker ps -a --filter name=before-autodeploy`, затем:

```bash
cd /opt/watch-together-deploy
flock .deploy.lock bash
# Следующие команды выполнять внутри shell, удерживающего блокировку:
docker compose --env-file .env -f compose.yml rm --stop --force app
docker rename watch-together-web-before-autodeploy-TIMESTAMP watch-together-web
docker start watch-together-web
rm -f .env compose.yml monitoring.env
curl -fsS http://127.0.0.1:18080/api/health
exit
```

## Проверки изменений

```bash
bash -n scripts/deploy.sh
shellcheck scripts/deploy.sh scripts/upload-bugsink-sourcemaps.sh
python3 -m unittest discover -s scripts -p 'test_deploy.py' -v
APP_IMAGE=ghcr.io/trybenon/web-dev:test docker compose -f deploy/compose.yml config --quiet
npm run test -- --run server/src/app.test.ts
docker compose build app
# Сборка production-стадий без реального токена и отправки ошибок:
APP_RELEASE="$(git rev-parse HEAD)" BUGSINK_DSN=https://public@bugsink.invalid/1 docker compose -f docker-compose.yml -f compose.check.yml build app artifacts
```

Тесты скрипта подставляют Docker и HTTP и проверяют успешное обновление,
ошибку registry до остановки приложения, откат при ошибке старта, неверный
локальный/публичный SHA и переход со старого ручного контейнера.
Реальную SSH-доставку, запуск systemd и доступность домена подтверждает
первый деплой на подготовленный VPS.
Отображение кода в вашей панели Bugsink дополнительно проверяется
контрольными ошибками после настройки доступа и первого деплоя.

Справка: [события GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[GHCR и аутентификация](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[карты исходников Bugsink](https://www.bugsink.com/docs/sourcemaps/),
[ожидание готовности Compose](https://docs.docker.com/reference/cli/docker/compose/up/).
