// The pane's two motions, as pure functions of time: the settle, when a new
// reply takes the page, and the lamp's level for the state the session is in.

import { GROUND, mix } from './paint'
import type { Page } from './paint'

// The settle: the old page sinks into the ground together, then the new one
// rises a line at a time from the top. A row the two pages share holds still.
const SINK_MS = 180
const RISE_MS = 260
const STAGGER_SPAN_MS = 320

const stagger = (rows: number): number => Math.min(16, STAGGER_SPAN_MS / Math.max(1, rows))
export const settleMs = (rows: number): number => SINK_MS + stagger(rows) * Math.max(0, rows - 1) + RISE_MS

const easeIn = (p: number): number => p * p
const easeOut = (p: number): number => 1 - (1 - p) ** 3

export function settleFrame(from: Page, to: Page, t: number): Uint32Array {
  const out = new Uint32Array(to.cells.length)
  const rowLen = to.columns * 3
  const sink = easeIn(Math.min(1, t / SINK_MS))
  for (let y = 0; y < to.rows; y++) {
    const at = y * rowLen
    const same = from.cells.subarray(at, at + rowLen).every((v, i) => v === to.cells[at + i])
    const start = SINK_MS + stagger(to.rows) * y
    for (let i = at; i < at + rowLen; i += 3) {
      if (same || t >= start + RISE_MS) {
        out.set(to.cells.subarray(i, i + 3), i)
      } else if (t < start) {
        out.set([from.cells[i]!, mix(from.cells[i + 1]!, GROUND, sink), mix(from.cells[i + 2]!, GROUND, sink)], i)
      } else {
        const rise = easeOut((t - start) / RISE_MS)
        out.set([to.cells[i]!, mix(GROUND, to.cells[i + 1]!, rise), mix(GROUND, to.cells[i + 2]!, rise)], i)
      }
    }
  }
  return out
}

// The lamp. Working, it breathes low and slow; done, it holds soft; waiting
// on you, it burns full. A change of state eases over LAMP_EASE_MS.
export type LampState = 'working' | 'done' | 'waiting'

const BREATH_MS = 3600
const LAMP_EASE_MS = 600
const STEADY: Record<Exclude<LampState, 'working'>, number> = { done: 0.42, waiting: 1 }

export type Lamp = { state: LampState; since: number; from: number }

const target = (state: LampState, t: number, since: number): number =>
  state === 'working' ? 0.22 + 0.36 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t - since)) / BREATH_MS)) : STEADY[state]

export function lampLevel(lamp: Lamp, t: number): number {
  const p = Math.min(1, Math.max(0, (t - lamp.since) / LAMP_EASE_MS))
  const eased = p * p * (3 - 2 * p)
  return lamp.from + (target(lamp.state, t, lamp.since) - lamp.from) * eased
}

// The lamp moves while it breathes or eases; otherwise it holds still.
export const lampMoving = (lamp: Lamp, t: number): boolean => lamp.state === 'working' || t - lamp.since < LAMP_EASE_MS

// A new state starts its ease from wherever the light is now.
export const relight = (lamp: Lamp | null, state: LampState, t: number): Lamp =>
  lamp === null ? { state, since: t - LAMP_EASE_MS, from: target(state, t, t) }
    : lamp.state === state ? lamp : { state, since: t, from: lampLevel(lamp, t) }
