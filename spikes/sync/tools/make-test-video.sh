#!/usr/bin/env bash
# Генерирует тестовое видео для спайка: 90 с, 24 fps, VP9 + Opus в WebM.
#
# Почему именно так:
#   - WebM/VP9/Opus играет во всех браузерах, включая сборки Chromium без
#     проприетарных кодеков (Playwright), поэтому годится для e2e.
#   - На кадре крупный таймкод и номер кадра: две вкладки рядом сразу
#     показывают расхождение на глаз.
#   - Короткий «бип» в начале каждой секунды: при двух открытых вкладках
#     рассинхрон слышен как эхо. Это самый быстрый ручной тест.
#   - Ключевой кадр каждую секунду (-g 24): перемотка дешёвая.
#   - Звуковая дорожка обязательна: без неё Chrome ставит скрытую вкладку
#     на паузу, и фоновые сценарии проверить нельзя.
#
# Запуск: bash tools/make-test-video.sh   (нужен ffmpeg с libvpx-vp9 и libopus)
set -euo pipefail
cd "$(dirname "$0")/.."

FONT="${FONT:-$(fc-match -f '%{file}' 'DejaVu Sans Mono:bold' 2>/dev/null || true)}"
OUT=client/media/test.webm
DUR=90

if [[ -n "$FONT" && -f "$FONT" ]]; then
  TEXT="drawtext=fontfile=${FONT}:text='%{pts\\:hms}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h*0.35,\
drawtext=fontfile=${FONT}:text='кадр %{frame_num}':fontsize=40:fontcolor=yellow:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h*0.55"
else
  echo "Шрифт не найден, таймкод на кадре рисоваться не будет" >&2
  TEXT="null"
fi

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=${DUR}" \
  -f lavfi -i "aevalsrc='if(lt(mod(t\,1)\,0.06)\,0.6*sin(2*PI*880*t)\,0)':s=48000:d=${DUR}" \
  -vf "$TEXT" \
  -c:v libvpx-vp9 -b:v 400k -g 24 -keyint_min 24 -row-mt 1 -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 64k \
  -shortest "$OUT"

ls -lh "$OUT"
