#!/usr/bin/env bash
# Длинный «фильм» для замера скорости конвертации: H.264 720p ~3 Мбит/с + звук 5.1.
# Кусок в 10 минут кодируется один раз, потом склеивается копированием до нужной длины.
#   MINUTES=120 AUDIO=ac3 bash tools/make-big-sample.sh   →  samples/big-120min-ac3.mkv
# AUDIO: ac3 | eac3 | dts
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p samples
MINUTES="${MINUTES:-120}"
AUDIO="${AUDIO:-ac3}"
case "$AUDIO" in
  ac3)  ACODEC="-c:a ac3 -b:a 448k" ;;
  eac3) ACODEC="-c:a eac3 -b:a 640k" ;;
  dts)  ACODEC="-c:a dca -strict -2 -b:a 1509k" ;;
  *) echo "AUDIO: ac3 | eac3 | dts" >&2; exit 1 ;;
esac
PIECE="samples/.piece-$AUDIO.mkv"
OUT="samples/big-${MINUTES}min-$AUDIO.mkv"
if [[ ! -f "$PIECE" ]]; then
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=1280x720:rate=24:duration=600" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=600" \
    -c:v libx264 -preset ultrafast -b:v 3M -maxrate 3M -bufsize 6M -g 48 -pix_fmt yuv420p \
    -ac 6 $ACODEC "$PIECE"
fi
LOOPS=$(( (MINUTES + 9) / 10 - 1 ))
ffmpeg -y -hide_banner -loglevel error -stream_loop "$LOOPS" -i "$PIECE" -t "$((MINUTES * 60))" -map 0 -c copy "$OUT"
ls -lh "$OUT"
