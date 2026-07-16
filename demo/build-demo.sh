#!/usr/bin/env bash
# Build the claude-review demo assets: a high-fidelity MP4 (primary, for LinkedIn /
# social) and a downsampled GIF (for the README). Both come from the SAME two
# deterministic pages — intro.html (pixel intro) then anim.html (terminal scene) —
# concatenated into one continuous clip.
#
# Output is 1:1 SQUARE (1080×1080) — the split-view is the hero, and square keeps
# both panes wide enough to read while owning the LinkedIn feed. (Portrait 4:5
# starves the two panes and loses the hero benefit; landscape letterboxes in-feed.)
#
#   MP4 : 30fps, full 1080x1080, SMOOTH per-frame grain, H.264 crf 16 (max fidelity).
#   GIF : 13fps, 960px square, STEPPED grain (?gstep) so the file stays small.
#
# Requires: a Chromium/Chrome binary (set CHROME=...) and ffmpeg.
set -eu
cd "$(dirname "$0")"

CHROME="${CHROME:-$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)}"
[ -n "$CHROME" ] || { echo "no chromium/chrome found; set CHROME=/path/to/chrome"; exit 1; }

INTRO_DUR=4.6
TERM_DUR=13.9
HOLD_DUR=1    # beat on the intro's resolved wordmark+tagline before the terminal scene

echo "== capturing MP4 frames (30fps, smooth grain) =="
node capture-combined.mjs "$CHROME" "$PWD" /tmp/cr-mp4-frames 30 "$INTRO_DUR" "$TERM_DUR" 0 "$HOLD_DUR"

echo "== encoding docs/demo.mp4 (H.264 crf16, yuv420p, faststart) =="
ffmpeg -y -framerate 30 -i /tmp/cr-mp4-frames/f%04d.png \
  -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart \
  -vf "scale=1080:1080:flags=lanczos" ../docs/demo.mp4

echo "== capturing GIF frames (13fps, stepped grain) =="
node capture-combined.mjs "$CHROME" "$PWD" /tmp/cr-gif-frames 13 "$INTRO_DUR" "$TERM_DUR" 0.152 "$HOLD_DUR"

echo "== encoding docs/demo.gif (960px, 160-colour palette) =="
ffmpeg -y -framerate 13 -i /tmp/cr-gif-frames/f%04d.png \
  -vf "scale=960:960:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 ../docs/demo.gif

rm -rf /tmp/cr-mp4-frames /tmp/cr-gif-frames
echo "== done =="
echo "  MP4: $(du -h ../docs/demo.mp4 | cut -f1)  ($(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ../docs/demo.mp4))"
echo "  GIF: $(du -h ../docs/demo.gif | cut -f1)"
