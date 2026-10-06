#!/usr/bin/env bash
# Тестовые ролики спайка: 20 с, таймкод на кадре, бип каждую секунду.
#   01–13 — H.264, ими проверяли Chrome, Firefox и Safari (results/).
#   vp9-* — то же с видео VP9: их играет даже Chromium без закрытых кодеков
#           (Playwright), поэтому на них работает автоматическая проверка (tools/bench.mjs).
# Нужен ffmpeg с libx264, libx265, libvpx-vp9, libopus.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p samples && cd samples

FONT="${FONT:-$(fc-match -f '%{file}' 'DejaVu Sans Mono:bold' 2>/dev/null || true)}"
D=20
label() {
  if [[ -n "$FONT" && -f "$FONT" ]]; then
    echo "drawtext=fontfile=$FONT:text='%{pts\\:hms}':fontsize=56:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h*0.30,drawtext=fontfile=$FONT:text='$1':fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h*0.58"
  else
    echo "null"
  fi
}
SRC_V="-f lavfi -i testsrc2=size=640x360:rate=24:duration=$D"
SRC_A="-f lavfi -i aevalsrc='if(lt(mod(t\,1)\,0.08)\,0.6*sin(2*PI*880*t)\,0)':s=48000:d=$D"
H264="-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 24"
VP9="-c:v libvpx-vp9 -b:v 400k -g 24 -row-mt 1 -deadline realtime -cpu-used 8"
MP4="-movflags +faststart"
run() { ffmpeg -y -hide_banner -loglevel error "$@"; }
two() { # $1 видеокодек-опции, $2 подпись, $3 файл, $4 доп. опции контейнера
  run $SRC_V $SRC_A $SRC_A -vf "$(label "$2")" -map 0:v -map 1:a -map 2:a $1 \
    -c:a:0 ac3 -b:a:0 448k -ac:a:0 6 -metadata:s:a:0 language=rus -metadata:s:a:0 title='Dub AC-3' -disposition:a:0 default \
    -c:a:1 aac -b:a:1 128k -ac:a:1 2 -metadata:s:a:1 language=eng -metadata:s:a:1 title='Original AAC' -disposition:a:1 0 \
    $4 "$3"
}

run $SRC_V $SRC_A -vf "$(label 'звук — AAC стерео')"   $H264 -c:a aac -b:a 128k -ac 2 01-h264-aac.mkv
run $SRC_V $SRC_A -vf "$(label 'звук — AC-3 5.1')"     $H264 -c:a ac3 -b:a 448k -ac 6 02-h264-ac3-5.1.mkv
run $SRC_V $SRC_A -vf "$(label 'звук — E-AC-3 5.1')"   $H264 -c:a eac3 -b:a 384k -ac 6 03-h264-eac3-5.1.mkv
run $SRC_V $SRC_A -vf "$(label 'звук — DTS 5.1')"      $H264 -c:a dca -strict -2 -b:a 768k -ac 6 04-h264-dts-5.1.mkv
two "$H264" 'звук — 1) AC-3, 2) AAC' 05-h264-ac3+aac.mkv ""
run $SRC_V $SRC_A -vf "$(label 'звук — FLAC стерео')"  $H264 -c:a flac -ac 2 06-h264-flac.mkv
run $SRC_V $SRC_A -vf "$(label 'видео HEVC, звук AAC')" -c:v libx265 -preset veryfast -crf 28 -pix_fmt yuv420p -tag:v hvc1 -x265-params log-level=error -c:a aac -b:a 128k -ac 2 07-hevc-aac.mkv
run $SRC_V $SRC_A -vf "$(label 'MP4 — H.264 + AAC')"   $H264 -c:a aac -b:a 128k -ac 2 $MP4 08-h264-aac.mp4
run $SRC_V $SRC_A -vf "$(label 'MP4 — звук AC-3 5.1')" $H264 -c:a ac3 -b:a 448k -ac 6 $MP4 09-h264-ac3-5.1.mp4
run $SRC_V $SRC_A -vf "$(label 'MP4 — звук E-AC-3 5.1')" $H264 -c:a eac3 -b:a 384k -ac 6 $MP4 10-h264-eac3-5.1.mp4
run $SRC_V $SRC_A -vf "$(label 'MP4 — звук FLAC')"     $H264 -c:a flac -ac 2 -strict -2 $MP4 11-h264-flac.mp4
run $SRC_V $SRC_A -vf "$(label 'MP4 — звук Opus')"     $H264 -c:a libopus -b:a 96k -ac 2 -strict -2 $MP4 12-h264-opus.mp4
two "$H264" 'MP4 — 1) AC-3, 2) AAC' 13-h264-ac3+aac.mp4 "$MP4"

# VP9-варианты для автоматической проверки конвертации в Chromium без закрытых кодеков.
run $SRC_V $SRC_A -vf "$(label 'VP9, звук AC-3 5.1')"   $VP9 -c:a ac3 -b:a 448k -ac 6 vp9-ac3-5.1.mkv
run $SRC_V $SRC_A -vf "$(label 'VP9, звук E-AC-3 5.1')" $VP9 -c:a eac3 -b:a 384k -ac 6 vp9-eac3-5.1.mkv
run $SRC_V $SRC_A -vf "$(label 'VP9, звук DTS 5.1')"    $VP9 -c:a dca -strict -2 -b:a 768k -ac 6 vp9-dts-5.1.mkv
two "$VP9" 'VP9 — 1) AC-3, 2) AAC' vp9-ac3+aac.mkv ""
ls -lh
