#!/usr/bin/env bash
# Regenerate ../docs/demo.gif from anim.html.
#
# anim.html is a deterministic mock: it reads ?t=<seconds> and renders that
# instant of a scripted split-terminal scene. This script screenshots each
# frame with headless Chromium and stitches them into a looping GIF.
#
# Requires: a Chromium/Chrome binary and ffmpeg.
set -u
cd "$(dirname "$0")"
CHROME="${CHROME:-$(command -v chromium-browser || command -v chromium || command -v google-chrome)}"
[ -n "$CHROME" ] || { echo "no chromium/chrome found; set CHROME=..."; exit 1; }

FPS=13; DUR=10.9
rm -rf frames && mkdir -p frames
N=$(python3 -c "print(int($DUR*$FPS))")
echo "capturing $N frames @ ${FPS}fps"
for i in $(seq 0 $((N-1))); do
  t=$(python3 -c "print(round($i/$FPS,3))")
  printf -v out "frames/f%04d.png" "$i"
  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1040,680 \
    --screenshot="$PWD/$out" --virtual-time-budget=1500 \
    "file://$PWD/anim.html?t=$t" >/dev/null 2>&1
  [ $((i % 20)) -eq 0 ] && echo "  frame $i (t=$t)"
done
echo "captured $(ls frames/*.png | wc -l) frames"

# assemble GIF with a shared optimal palette
ffmpeg -y -framerate $FPS -i frames/f%04d.png \
  -vf "scale=1040:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 ../docs/demo.gif >/dev/null 2>&1
rm -rf frames
echo "wrote ../docs/demo.gif ($(du -h ../docs/demo.gif | cut -f1))"
