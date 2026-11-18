# Автодеплой

После push в `main` и успешного CI GitHub Actions собирает образ через Docker Compose, загружает карты в Bugsink и публикует образ в GHCR с тегом SHA коммита. На VPS скрипт скачивает готовый образ и запускает его через Compose. Деплои идут по одному. Перед SSH workflow сверяет SHA с актуальным `main`.

## Настройка VPS

Нужны Docker Compose 2.24+, Bash, `curl`, `python3`, `flock`, systemd и вход по SSH на порт 22 от `root`. Используйте отдельный ключ для Actions. Добавьте его публичную часть в `~/.ssh/authorized_keys` на VPS и проверьте, что вход с этим ключом работает без пароля.

На VPS должны существовать сеть `watch-together-net` и прокси, который направляет трафик на `watch-together-web:3000`. Compose обновляет контейнер приложения и публикует его локально на `127.0.0.1:18080`. Caddy и Cloudflare Tunnel остаются в существующей схеме. Перед первым обновлением проверьте, что старому контейнеру не нужны дополнительные подключения и тома.

```sh
docker compose version
docker network inspect watch-together-net
install -m 700 -d /opt/watch-together-deploy
```

Дополнительные переменные приложения храните в `/opt/watch-together-deploy/app.env` с правами `600`. Workflow передаёт `BUGSINK_DSN` отдельно. `APP_RELEASE` берётся из образа.

## Настройка GitHub и Bugsink

В **Settings → Secrets and variables → Actions** добавьте:

| Раздел    | Имя                  | Значение                                        |
| --------- | -------------------- | ----------------------------------------------- |
| Secrets   | `DEPLOY_HOST`        | IP или домен VPS                                |
| Secrets   | `DEPLOY_USER`        | `root`                                          |
| Secrets   | `DEPLOY_SSH_KEY`     | Закрытая часть ключа Actions                    |
| Secrets   | `DEPLOY_KNOWN_HOSTS` | Проверенная строка ключа хоста из `known_hosts` |
| Secrets   | `BUGSINK_DSN`        | DSN проекта для клиента и сервера               |
| Secrets   | `BUGSINK_AUTH_TOKEN` | Токен с правом загрузки карт в проект           |
| Variables | `BUGSINK_URL`        | URL панели Bugsink                              |
| Variables | `BUGSINK_PROJECT`    | Slug того же проекта в Bugsink                  |

Для получения строки `known_hosts` используйте `ssh-keygen -F <хост>` после доверенного подключения. Токен Bugsink передаётся только шагу загрузки через BuildKit secret.

Сервер должен иметь доступ к пакету `ghcr.io/trybenon/web-dev`. После первой публикации можно сделать пакет публичным. Для приватного пакета выполните на VPS `docker login ghcr.io -u <логин>` с PAT classic, у которого есть `read:packages` и доступ к пакету. Если скачивание не удалось, исправьте доступ и перезапустите упавший job в Actions.

## Проверка и откат

После merge дождитесь **CI → Deploy main**. Для повторного деплоя текущего `main` можно запустить **CI → Run workflow → main**. Проверка `build` обязательна для слияния PR. Тесты отката в CI используют подставные Docker и HTTP и работают без VPS.

Скрипт скачивает образ до остановки текущего контейнера. После старта проверяет локальный и публичный SHA. При ошибке запуска или healthcheck автоматически возвращает прежнюю версию. Обновление разрывает WebSocket-соединения и сбрасывает комнаты в памяти сервера.

```sh
curl -fsS https://krozmo.online/api/health
# Ожидается {"status":"ok","sha":"<полный SHA коммита main>"}
```

Логи на VPS доступны через `journalctl -u 'watch-together-deploy-*' --no-pager -n 100`. После первого деплоя проверьте в Bugsink, что контрольная ошибка клиента и сервера отображается с исходным файлом и строкой.

Ручной откат после двух успешных деплоев:

```sh
cd /opt/watch-together-deploy
. ./previous.env
bash deploy.sh "$APP_IMAGE" "$APP_SHA" previous-compose.yml "$PWD" \
  https://krozmo.online/api/health previous-monitoring.env
```

Откат использует локальный ID образа из `previous.env`. Сохраните этот образ на VPS. Следующий успешный CI снова развернёт `main`, поэтому для постоянного возврата нужен revert.

После самого первого деплоя исходный контейнер сохранён под именем `watch-together-web-before-autodeploy-<timestamp>`. Чтобы вернуть его, подставьте точное имя из `docker ps -a --filter name=before-autodeploy`:

```sh
cd /opt/watch-together-deploy
flock .deploy.lock bash
# Выполните следующие команды внутри запущенной оболочки:
docker compose --env-file .env -f compose.yml rm --stop --force app
docker rename watch-together-web-before-autodeploy-TIMESTAMP watch-together-web
docker start watch-together-web
rm -f .env compose.yml monitoring.env
curl -fsS http://127.0.0.1:18080/api/health
exit
```

Локальная сборка с Bugsink описана в [README](../README.md#карты-исходников-клиента-и-сервера).
