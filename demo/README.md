# demo assets

Generator for the README's `docs/demo.gif`.

- **`anim.html`** — a self-contained, deterministic mock of a split terminal
  (Claude Code on the left, `claude-review` on the right). It reads
  `?t=<seconds>` from the URL and renders that exact instant of the scene, so
  every frame is reproducible. Bundles JetBrains Mono (`jbm-*.woff2`) for
  offline rendering.
- **`capture.sh`** — screenshots each frame with headless Chromium and stitches
  them into `../docs/demo.gif` with ffmpeg.

## Regenerate

```bash
./capture.sh            # needs chromium/chrome + ffmpeg on PATH
```

To preview a single moment, open `anim.html?t=5.5` in a browser.
