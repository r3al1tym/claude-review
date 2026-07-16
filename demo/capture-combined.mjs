#!/usr/bin/env node
// Combined capture: pixel INTRO (intro.html) then the terminal SCENE (anim.html),
// as one continuous frame sequence, driven over CDP by a single persistent
// headless Chromium (fast; avoids cold-launching chromium per frame under snapfuse).
// Both files are deterministic: they read ?t=<sec> and render that exact instant.
//
// Usage: node capture-combined.mjs <chrome-bin> <demo-dir-abs> <out-frames-dir> <fps> <introDur> <termDur> [gstep] [holdDur]
//   gstep (optional): grain time-step passed to intro.html (?gstep=). 0/omitted = smooth per-frame
//   grain (for the high-fidelity MP4). Pass e.g. 0.152 only if capturing frames destined ONLY for a GIF.
//   holdDur (optional, default 1): seconds to freeze on the intro's final resolved frame before the
//   terminal scene — a beat to let the wordmark + tagline read. 0 = no hold (straight cut).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [chrome, demoDir, outDir, fpsS, introS, termS, gstepS, holdS] = process.argv.slice(2)
const FPS = Number(fpsS)
const GSTEP = gstepS ? Number(gstepS) : 0
const HOLD_DUR = holdS !== undefined ? Number(holdS) : 1
const INTRO_FRAMES = Math.round(Number(introS) * FPS)
const HOLD_FRAMES = Math.round(HOLD_DUR * FPS)
const TERM_FRAMES = Math.round(Number(termS) * FPS)
const PORT = 9321

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// SQUARE 1:1 output: 540 CSS px at deviceScaleFactor 2 → 1080×1080 frames.
// The exact viewport is forced via Emulation.setDeviceMetricsOverride below
// (a small --window-size gets clamped to the OS min and letterboxes the frame).
const CSS = 540
const proc = spawn(chrome, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1200,1200',
  'about:blank',
], { stdio: 'ignore' })

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await r.json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP did not come up')
}

let ws, msgId = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, { res }))
}

ws = new WebSocket(await cdpTarget())
await new Promise((res) => { ws.onopen = res })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id) }
}
await send('Page.enable')
// Force an exact square CSS viewport — bypasses OS window min-size clamping.
await send('Emulation.setDeviceMetricsOverride', { width: CSS, height: CSS, deviceScaleFactor: 2, mobile: false })

let frame = 0
async function shoot(fileBase, t, extra = '') {
  await send('Page.navigate', { url: `file://${demoDir}/${fileBase}?t=${t}${extra}` })
  let ready = false
  for (let k = 0; k < 60; k++) {
    const r = await send('Runtime.evaluate', {
      expression: `document.body && document.body.getAttribute('data-ready')==='1'`,
      returnByValue: true,
    })
    if (r?.result?.value) { ready = true; break }
    await sleep(25)
  }
  if (!ready) await sleep(140)
  const shot = await send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: CSS, height: CSS, scale: 2 },
  })
  writeFileSync(`${outDir}/f${String(frame).padStart(4, '0')}.png`, Buffer.from(shot.data, 'base64'))
  frame++
}

const introExtra = GSTEP > 0 ? `&gstep=${GSTEP}` : ''
console.log(`intro: ${INTRO_FRAMES} frames, hold: ${HOLD_FRAMES} frames, terminal: ${TERM_FRAMES} frames @ ${FPS}fps  (gstep=${GSTEP})`)
for (let i = 0; i < INTRO_FRAMES; i++) {
  await shoot('intro.html', Math.round((i / FPS) * 1000) / 1000, introExtra)
  if (i % 30 === 0) console.log(`  intro frame ${i}`)
}
// Hold on the intro's final resolved frame (wordmark + tagline settled) — a beat
// before the terminal scene. Re-shoots the exact last intro instant HOLD_FRAMES times.
const holdT = Math.round(((INTRO_FRAMES - 1) / FPS) * 1000) / 1000
for (let h = 0; h < HOLD_FRAMES; h++) {
  await shoot('intro.html', holdT, introExtra)
  if (h % 30 === 0) console.log(`  hold frame ${h}`)
}
for (let j = 0; j < TERM_FRAMES; j++) {
  await shoot('anim.html', Math.round((j / FPS) * 1000) / 1000)
  if (j % 30 === 0) console.log(`  terminal frame ${j}`)
}
console.log(`captured ${frame} frames total`)
ws.close()
proc.kill('SIGKILL')
process.exit(0)
