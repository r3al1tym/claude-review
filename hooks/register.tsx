import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { ReviewSnapshot, ReviewTurn, ReviewView } from '../types'
import { lampLight, lampMoving, relight, settleFrame, settleMs } from './motion'
import type { Lamp, LampState } from './motion'
import { encode, paintLamp } from './paint'
import type { Column, Page } from './paint'
import { columnOf, screen, surfacesFor } from './screen'
import type { Facts, Laid } from './screen'
import { buildSnapshot, hasReply, replySig } from './transcript'

const PANE = 'claude-review'
const EMPTY_TURN: ReviewTurn = { question: null, text: null, plan: null, planWaiting: false, ask: null }
const FIRST_VIEW: ReviewView = { index: null, frozen: false, held: null, surface: 0, scroll: 0, seen: '', help: false, flash: null }

const snapshot = atom({ plugin: 'review-pane', key: 'snapshot' } as const, { turns: [], tasks: [] })
const view = atom({ plugin: 'review-pane', key: 'view' } as const, FIRST_VIEW)
// the ids of the turns running now: the main one and any agent's
const working = atom({ plugin: 'review-pane', key: 'working' } as const, [])

// The last layout drawn, so a scroll or a key clamps to the content it moves
// over. A cache only: a reload starts it over and the next draw refills it.
let laid: Laid = {
  maxScroll: Number.MAX_SAFE_INTEGER, bodyRows: 10, surfaces: [], active: 0,
  column: { left: 0, measure: 0 }, page: { columns: 0, rows: 0, cells: new Uint32Array(0) },
}

const latest = (snap: ReviewSnapshot): number => Math.max(0, snap.turns.length - 1)

// The turn on screen, as the CLI's turn_at: a pin holds only on a turn that
// exists, and a frozen view keeps the turn it froze.
function onScreen(snap: ReviewSnapshot, v: ReviewView): { turn: ReviewTurn; cursor: number; historical: boolean } {
  const last = snap.turns.length - 1
  const cursor = v.index !== null && v.index >= 0 && v.index <= last ? v.index : last
  const turn = (v.frozen && v.held) || snap.turns[cursor] || EMPTY_TURN
  return { turn, cursor, historical: cursor >= 0 && cursor < last }
}

const isBlank = (t: ReviewTurn): boolean => !t.text && !t.plan && !t.ask

// What the page shows. A new turn that has nothing to show yet keeps the last
// answer on the page, dimmed under the new prompt, so the page never empties
// while Claude works; an earlier turn leads with the prompt it answered.
function display(snap: ReviewSnapshot, v: ReviewView, busy: boolean) {
  const at = onScreen(snap, v)
  const prev = snap.turns[at.cursor - 1]
  if (busy && !at.historical && !v.frozen && isBlank(at.turn) && prev && !isBlank(prev)) {
    return { ...at, turn: prev, dim: true, prompt: at.turn.question }
  }
  return { ...at, dim: false, prompt: at.historical ? at.turn.question : null }
}

const isFollowing = (snap: ReviewSnapshot, v: ReviewView): boolean =>
  !v.frozen && (v.index === null || v.index >= snap.turns.length - 1)

// Show the live turn and mark its reply seen; back to the top only when the
// reply changed since the view last showed it.
const catchUp = (snap: ReviewSnapshot, v: ReviewView): ReviewView => {
  const sig = replySig(snap)
  if (sig !== v.seen) return { ...v, index: null, frozen: false, held: null, seen: sig, surface: 0, scroll: 0 }
  return v.index === null && !v.frozen && v.held === null ? v : { ...v, index: null, frozen: false, held: null }
}

async function refresh($: EngineInterface): Promise<void> {
  const snap = buildSnapshot(await $.session.messages())
  await update($, snapshot, () => snap)
  await update($, view, v => (isFollowing(snap, v) ? catchUp(snap, v) : v))
}

// Rows land in bursts (a response's blocks, a tool's result), so a refresh
// waits for the burst to settle rather than reading the session per row.
let pending: { cancel: () => void } | null = null
function soon($: EngineInterface): void {
  pending?.cancel()
  pending = $.clock.after(120, () => {
    pending = null
    void isOpen($).then(isShown => (isShown ? refresh($) : undefined))
  })
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function open($: EngineInterface): Promise<boolean> {
  drawnPage = null // a pane that opens is complete on arrival; nothing settles
  await refresh($)
  return (await $.ui.open({ id: PANE, title: 'Review' })).isPlaced
}

// ---------------------------------------------------------------- keys

const clampScroll = (n: number): number => Math.max(0, Math.min(n, laid.maxScroll))

// Every key closes a flash; with the guide up, any key but a scroll closes it.
async function key($: EngineInterface, act: (snap: ReviewSnapshot, v: ReviewView) => ReviewView, scrolls = false): Promise<void> {
  const snap = await read($, snapshot)
  await update($, view, v => {
    const base = { ...v, flash: null }
    if (base.help && !scrolls) return { ...base, help: false, scroll: 0 }
    return act(snap, base)
  })
}

// Point the view at turn `index`; a frozen view holds what it now shows.
const show = (snap: ReviewSnapshot, v: ReviewView, index: number): ReviewView => {
  const at = Math.max(0, Math.min(index, latest(snap)))
  return { ...v, index: at, held: v.frozen ? (snap.turns[at] ?? null) : null, surface: 0, scroll: 0 }
}

const earlier = (snap: ReviewSnapshot, v: ReviewView): ReviewView => {
  const { cursor } = onScreen(snap, v)
  return cursor > 0 ? show(snap, v, cursor - 1) : v
}

const later = (snap: ReviewSnapshot, v: ReviewView): ReviewView => {
  const { cursor } = onScreen(snap, v)
  if (cursor >= latest(snap)) return v
  return cursor + 1 === latest(snap) && !v.frozen ? catchUp(snap, v) : show(snap, v, cursor + 1)
}

const freeze = (snap: ReviewSnapshot, v: ReviewView): ReviewView => {
  if (!v.frozen) return { ...v, frozen: true, held: onScreen(snap, v).turn }
  const thawed = { ...v, frozen: false, held: null }
  // unfreezing on the live turn resumes it
  return onScreen(snap, thawed).cursor >= latest(snap) ? catchUp(snap, thawed) : thawed
}

const scrollBy = (n: number) => (_: ReviewSnapshot, v: ReviewView): ReviewView => ({ ...v, scroll: clampScroll(v.scroll + n) })

const nextSurface = (_: ReviewSnapshot, v: ReviewView): ReviewView => {
  const count = Math.max(1, laid.surfaces.length)
  return { ...v, surface: (Math.min(v.surface, count - 1) + 1) % count, scroll: 0 }
}

async function copySurface($: EngineInterface, press: UiPressArgument): Promise<void> {
  if ((await read($, view)).help) return key($, (_, v) => v)
  const surface = laid.surfaces[laid.active]
  const text = surface?.raw ?? ''
  const copied = text === '' ? null : await $.ui.copy({ text, surface: press.surface })
  const flash = copied === null ? 'nothing to copy' : copied.isCopied ? `copied ${surface!.label}` : `copy failed: ${copied.reason}`
  await key($, (_, v) => ({ ...v, flash }))
}

const HOTKEYS = ['h', 'l', 'j', 'k', 'g', 'f', 'r', 't', 'y', 'm', 'q'] as const

async function pressKey($: EngineInterface, k: string, press: UiPressArgument): Promise<void> {
  switch (k) {
    case 'h': return key($, earlier)
    case 'l': return key($, later)
    case 'j': return key($, scrollBy(1), true)
    case 'k': return key($, scrollBy(-1), true)
    case 'g': return key($, (_, v) => ({ ...v, scroll: 0 }), true)
    case 'f': return key($, freeze)
    case 'r': return key($, catchUp)
    case 't': return key($, nextSurface)
    case 'y': return copySurface($, press)
    case 'm': return key($, (_, v) => (v.help ? v : { ...v, help: true, scroll: 0 }))
    case 'q': return $.ui.close({ id: PANE }).then(() => undefined)
  }
}
const hotkey = (k: string): string => `key-${k}`

// ---------------------------------------------------------------- light

// The lamp and the settle move by blits between draws: a timer repaints their
// Rasters at frame rate and stops when the motion ends or the pane is gone.
type Timer = { cancel: () => void }

let lamp: Lamp | null = null
let lampAt: { columns: number; column: Column; deep: boolean } | null = null

// Claude Code paints 256 colours under tmux or without COLORTERM=truecolor;
// read once a load, a guess the lamp needs only for how it breathes.
let deep: boolean | null = null
async function trueColour($: EngineInterface): Promise<boolean> {
  const colorterm = (await $.env.get('COLORTERM').catch(() => undefined)) ?? ''
  const tmux = (await $.env.get('TMUX').catch(() => undefined)) ?? ''
  return /^(truecolor|24bit)$/i.test(colorterm) && tmux === ''
}
let lampTimer: Timer | null = null

function stopLamp(): void {
  lampTimer?.cancel()
  lampTimer = null
}

async function lampTick($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  if (!lamp || !lampAt) return stopLamp()
  const cells = encode(paintLamp(lampAt.columns, lampAt.column, lampLight(lamp, t), lampAt.deep))
  const res = await $.ui.blit({ requestId: PANE, key: 'lamp', cells })
  if (res.deny || !lampMoving(lamp, t)) stopLamp()
}

function runLamp($: EngineInterface): void {
  if (!lampTimer) lampTimer = $.clock.every(50, () => void lampTick($))
}

// The body last drawn, as cells, and the session's reply then: when the
// reply changes under a following view, the new page settles in from it. A
// settle runs `from` to `to` over settleMs.
let drawnPage: { page: Page; sig: string } | null = null
let settle: { from: Page; to: Page; start: number } | null = null
let settleTimer: Timer | null = null

function endSettle($: EngineInterface): void {
  settle = null
  settleTimer?.cancel()
  settleTimer = null
  $.ui.invalidate('ui.render') // the settled page draws as Text again
}

async function settleTick($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  if (!settle || t - settle.start >= settleMs(settle.to.rows)) return endSettle($)
  const cells = encode(settleFrame(settle.from, settle.to, t - settle.start))
  // the first frames can come before the drawing that holds the Raster is
  // mounted; past that, a refused blit means the pane is gone or redrawn
  const { deny } = await $.ui.blit({ requestId: PANE, key: 'page', cells })
  if (deny && t - settle.start > SETTLE_GRACE_MS) endSettle($)
}

const SETTLE_GRACE_MS = 150

function runSettle($: EngineInterface): void {
  if (!settleTimer) settleTimer = $.clock.every(16, () => void settleTick($))
}

const sameSize = (a: Page, b: Page): boolean => a.columns === b.columns && a.rows === b.rows

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'claude-review',
      description: 'Toggle the review pane: the latest response, plan and tasks of this session',
    })
    // a headless run has no surface to draw on, so it never opens unasked
    if (options.openOnStart && (await $.session.surfaces()).length > 0) void open($)

    return next(e)
  })

  on('command.run', { command: 'claude-review' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Review pane closed.' }
    }

    return { text: (await open($)) ? 'Review pane opened.' : 'Review pane is waiting for a wider terminal.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, ids => [...ids.filter(id => id !== e.turnId), e.turnId])
    return next(e)
  })

  // the reply lands before the turn stops counting as working, so a dimmed
  // answer settles straight into the new one, and the lamp comes up after
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await isOpen($))) await refresh($)
    await update($, working, ids => ids.filter(id => id !== e.turnId))

    return result
  })

  // the pane follows the conversation as its rows land, as the CLI follows
  // the transcript file; a closed pane reads nothing
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && (e.door === 'prompt' || e.door === 'response' || e.door === 'tool-result')) soon($)

    return stored
  })

  // The terminal pane draws exactly its body's rows plus one, so the engine
  // has a row to scroll and passes every scroll key here; the pane moves its
  // own window under the pinned chrome and the engine's window never moves.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.contentRows !== e.bodyRows + 1) return next(e)
    const step = Math.abs(e.by) >= e.contentRows
      ? Math.sign(e.by) * Number.MAX_SAFE_INTEGER
      : Math.abs(e.by) === e.bodyRows ? Math.sign(e.by) * laid.bodyRows
      : e.pointer ? e.by * 3 : e.by
    await key($, (_, v) => ({ ...v, scroll: clampScroll(v.scroll + step) }), true)

    // the engine's window stays at the top, whatever moved it before
    return next({ ...e, offset: 0 })
  })

  // the hotkeys ride on Buttons drawn hidden; the focus ring never lands on one
  on('ui.focus', { requestId: PANE }, async ($, e, next) =>
    (e.element?.startsWith('key-') ? { deny: 'a hotkey, not a control' } : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const v = await read($, view)
    const busy = (await read($, working)).length > 0
    const { turn, cursor, historical, dim, prompt } = display(snap, v, busy)
    const isLatest = !historical
    const behind = !isFollowing(snap, v) && hasReply(snap) && replySig(snap) !== v.seen

    if (e.surface === 'terminal') {
      const T = E as typeof E & Parameters<typeof screen>[0]
      // the guide's diagnostics never cost the drawing: a fact that fails reads '?'
      const facts: Facts | null = v.help
        ? {
            session: await $.session.id().catch(() => '?'),
            model: (await $.session.model().catch(() => '?')).replace(/^.*?(?=claude-)/, '').replace(/^claude-/, ''),
            project: (await $.session.cwd().catch(() => '?')).replace(/^\/home\/[^/]+/, '~'),
          }
        : null
      // the lamp speaks for the live turn, whichever turn is on the page
      const now = await $.clock.now()
      const live = snap.turns[snap.turns.length - 1]
      const waiting = live?.ask ? 'question' : live?.plan && live.planWaiting ? 'plan' : null
      const lampState: LampState = waiting ? 'waiting' : busy ? 'working' : 'done'
      lamp = relight(lamp, lampState, now)
      deep ??= await trueColour($)
      lampAt = { columns: e.props.bodyColumns, column: columnOf(e.props.bodyColumns), deep }

      // the reply as the snapshot has it, so the settle starts on the draw that
      // first shows it; a key that moves the view changes no reply and is instant
      const sig = replySig(snap)
      const following = isFollowing(snap, v)
      const paint = (page: Page): Uint32Array | null => {
        const before = drawnPage
        drawnPage = { page, sig }
        if (settle && sameSize(settle.to, page)) {
          settle.to = page
          return settleFrame(settle.from, page, now - settle.start)
        }
        settle = null
        if (!before || before.sig === sig || !following || v.help || !sameSize(before.page, page)) return null
        settle = { from: before.page, to: page, start: now }
        runSettle($)
        return settleFrame(before.page, page, 0)
      }

      const drawn = screen(T, {
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        isFocused: e.props.isFocused,
        placement: e.props.placement,
        turn,
        tasks: isLatest ? snap.tasks : [],
        historical,
        working: busy,
        behind,
        cursor,
        turnCount: snap.turns.length,
        view: v,
        facts,
        prompt,
        dim,
        lamp: lampLight(lamp, now),
        deep,
        waiting,
      }, paint)
      laid = drawn.laid
      if (lampMoving(lamp, now)) runLamp($)
      const { Box, Button, Text } = T

      return (
        <Box flexDirection="column">
          {drawn.tree}
          <Text> </Text>
          <Box display="none">
            {HOTKEYS.map(k => <Button key={hotkey(k)} label={k} hotkey={k} onPress={press => pressKey($, k, press)} />)}
          </Box>
        </Box>
      )
    }

    // Other surfaces draw with their own type and scroll the tree themselves:
    // the same column, drawn by the surface's Markdown.
    const { Box, Button, Markdown, Text } = E
    const surfaces = surfacesFor(turn, isLatest ? snap.tasks : [], historical, busy)
    const active = Math.min(v.surface, surfaces.length - 1)
    laid = { ...laid, maxScroll: 0, bodyRows: 10, surfaces, active }
    const shown = surfaces[active]!
    const body = shown.raw !== '' ? shown.raw : '_No response yet._'
    const position = snap.turns.length === 0 ? 'no turns yet'
      : `turn ${cursor + 1} of ${snap.turns.length}${v.frozen ? ' · frozen' : isFollowing(snap, v) ? ' · live' : ''}`

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        <Text dimColor>{position}</Text>
        {historical && turn.question ? <Text dimColor>{`› ${turn.question.replace(/\s+/g, ' ').slice(0, 200)}`}</Text> : null}
        <Markdown key="body" text={body.length <= 9800 ? body : `${body.slice(0, 9800)}\n\n_Cut at 9800 characters. Copy for the full text._`} />
        <Box flexDirection="row" gap={2}>
          {surfaces.length > 1 ? surfaces.map((sf, i) => (
            <Button key={`surface-${sf.label}`} label={sf.label} plain dimColor={i !== active} onPress={() => key($, (_, w) => ({ ...w, surface: i, scroll: 0 }))} />
          )) : null}
          <Button key="earlier" label="earlier" plain dimColor onPress={press => pressKey($, 'h', press)} />
          <Button key="later" label="later" plain dimColor onPress={press => pressKey($, 'l', press)} />
          <Button key="freeze" label={v.frozen ? 'unfreeze' : 'freeze'} plain dimColor onPress={press => pressKey($, 'f', press)} />
          <Button key="copy" label="copy" plain dimColor onPress={press => pressKey($, 'y', press)} />
        </Box>
      </Box>
    )
  })
}
