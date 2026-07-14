#!/usr/bin/env node
// Fast frame capture: drive ONE persistent headless Chromium over CDP and
// screenshot every ?t=<sec> frame, instead of cold-launching chromium 180×
// (which is pathologically slow under snapfuse). Node 24 has a global WebSocket.
//
// Usage: node capture-cdp.mjs <chrome-bin> <anim.html-abs-path> <out-frames-dir> <fps> <dur>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [chrome, animPath, outDir, fpsS, durS] = process.argv.slice(2)
const FPS = Number(fpsS), DUR = Number(durS)
const N = Math.floor(DUR * FPS)
const PORT = 9319

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const proc = spawn(chrome, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--force-device-scale-factor=2', '--window-size=1040,680',
  'about:blank',
], { stdio: 'ignore' })

async function cdpTargets() {
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
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}

const wsUrl = await cdpTargets()
ws = new WebSocket(wsUrl)
await new Promise((res) => { ws.onopen = res })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id) }
}
await send('Page.enable')

const base = 'file://' + animPath
for (let i = 0; i < N; i++) {
  const t = Math.round((i / FPS) * 1000) / 1000
  await send('Page.navigate', { url: `${base}?t=${t}` })
  // wait for the page's own fonts.ready → data-ready flag, bounded
  let ready = false
  for (let k = 0; k < 40; k++) {
    const r = await send('Runtime.evaluate', {
      expression: `document.body && document.body.getAttribute('data-ready')==='1'`,
      returnByValue: true,
    })
    if (r?.result?.value) { ready = true; break }
    await sleep(25)
  }
  if (!ready) await sleep(120) // fallback settle
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1040, height: 680, scale: 2 } })
  writeFileSync(`${outDir}/f${String(i).padStart(4, '0')}.png`, Buffer.from(shot.data, 'base64'))
  if (i % 20 === 0) console.log(`  frame ${i} (t=${t})`)
}
console.log(`captured ${N} frames`)
ws.close()
proc.kill('SIGKILL')
process.exit(0)
