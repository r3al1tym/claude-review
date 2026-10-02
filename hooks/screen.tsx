// The terminal pane: a page under a lamp. The reply owns a centred column of
// at most MEASURE cells. Above it the lamp, a line of tungsten light that is
// the session's state, and a head row (an eyebrow or the running head); below
// it one key row. A reply longer than the pane gets a fore-edge, a map of the
// whole reply at the right with the stretch in view lit. Everything is grey
// but the lamp, and the words that speak for it.

import type { ElementTable } from 'claude-code'

import type { ReviewTask, ReviewTurn, ReviewView } from '../types'
import { INK, layout } from './markdown'
import type { Line } from './markdown'
import { GROUND, encode, exact, hex, lampSpans, markOf, mix, paintEdge, paintLamp, paintPage, rgb } from './paint'
import { held } from './motion'
import type { Light } from './motion'
import type { Column, Page } from './paint'
import { cells, clip, oneline, spanCells, wrap } from './text'
import type { Span, Style } from './text'

export const MEASURE = 72
// how far a dimmed answer sinks toward the ground
const DIM = 0.45

export type Surface = { label: string; lines: (width: number) => Line[]; raw: string }

export type Facts = { session: string; model: string; project: string }

export type ScreenInput = {
  columns: number
  rows: number
  isFocused: boolean
  placement: 'dock' | 'inline'
  turn: ReviewTurn
  tasks: ReviewTask[]
  historical: boolean
  working: boolean
  behind: boolean
  cursor: number
  turnCount: number
  view: ReviewView
  facts: Facts | null
  // the prompt to lead with: an earlier turn's, or a new one over the dimmed answer
  prompt: string | null
  // the last answer, dimmed under a new prompt that has no reply yet
  dim: boolean
  // the lamp's light now, whether it holds still, and whether the terminal paints true colour
  lamp: Light
  still: boolean
  deep: boolean
  // what the session waits on the person for
  waiting: 'plan' | 'question' | null
}

export type State = { word: string; style: Style }

const textLine = (spans: Span[]): Line => ({ kind: 'text', spans })
const blank = (): Line => textLine([])

// ---------------------------------------------------------------- surfaces

function taskLines(tasks: readonly ReviewTask[], width: number): Line[] {
  // status by brightness, not hue: done recedes, active is brightest, pending mid
  const look: Record<string, [string, Style]> = {
    completed: ['✓', { color: INK.meta }],
    in_progress: ['▸', { color: INK.brightest, bold: true }],
    pending: ['○', { color: INK.question }],
  }
  return tasks.flatMap(t => {
    const [sym, style] = look[t.status] ?? look.pending!
    return wrap([{ text: oneline(t.content), style }], width, [{ text: ` ${sym}  `, style }], [{ text: '    ' }]).map(textLine)
  })
}

const note = (text: string): Surface => ({
  label: 'waiting',
  lines: width => wrap([{ text, style: { color: INK.link, italic: true } }], width, [{ text: ' ' }]).map(textLine),
  raw: '',
})

// Ordered surfaces for whatever this turn produced, as the CLI builds them:
// what Claude is blocked on leads (a plan awaiting approval, a question),
// then the response, a plan already approved, the tasks.
export function surfacesFor(turn: ReviewTurn, tasks: readonly ReviewTask[], historical: boolean, working: boolean): Surface[] {
  const md = (label: string, src: string): Surface => ({ label, lines: width => layout(src, width), raw: src })
  const out: Surface[] = []
  if (turn.plan && turn.planWaiting) out.push(md('plan', turn.plan))
  if (turn.ask) out.push(md('question', turn.ask))
  if (turn.text) out.push(md('response', turn.text))
  if (turn.plan && !turn.planWaiting) out.push(md('plan', turn.plan))
  if (tasks.length > 0) {
    out.push({ label: 'tasks', lines: width => taskLines(tasks, width), raw: tasks.map(t => `[${t.status}] ${t.content}`).join('\n') })
  }
  if (out.length > 0) return out
  if (historical) return [note('This turn ended without a reply.')]
  return [note('The reply appears here as Claude writes it.')]
}

// ---------------------------------------------------------------- the guide

const HELP_INTRO = ' shows this session\'s latest reply, rendered for reading, beside the conversation. '
  + 'It follows the live turn until you freeze it or step back into an earlier turn. '
  + 'It only reads the conversation; nothing here writes to the session.'

type HelpRow = [readonly string[], string]

const HELP_GROUPS: readonly [string, readonly HelpRow[]][] = [
  ['MOVE', [[['h', 'l'], 'earlier / later turn'], [['↑ ↓', 'j k'], 'scroll a line'], [['pgup', 'pgdn'], 'scroll a page'], [['g'], 'top']]],
  ['HOLD', [[['f'], 'freeze this view'], [['r'], 'back to the live turn']]],
  ['SURFACES', [[['t'], 'next surface'], [['y'], 'copy this surface']]],
  ['PANE', [[['ctrl+x ⇥'], 'give the pane the keys'], [['esc'], 'hand them back'], [['q'], 'close the pane'], [['m'], 'close this guide']]],
]

const HELP_TWO_COL_MIN = 84

function helpSection(title: string, rows: readonly HelpRow[], chips: boolean): Span[][] {
  const ncol = Math.max(...rows.map(([keys]) => keys.length))
  const widths = Array.from({ length: ncol }, (_, i) => Math.max(1, ...rows.map(([keys]) => cells(keys[i] ?? ''))))
  const keyW = widths.reduce((a, w) => a + w + (chips ? 2 : 0), 0) + (ncol - 1)
  const out: Span[][] = [[{ text: title, style: { color: INK.question, bold: true } }]]
  rows.forEach(([keys, desc], n) => {
    if (n > 0 && chips) out.push([]) // air between chip rows so they read as keys
    const line: Span[] = []
    keys.forEach((k, i) => {
      if (i > 0) line.push({ text: ' ' })
      const w = widths[i]!
      if (chips) {
        const left = Math.floor((w - cells(k)) / 2)
        line.push({ text: ` ${' '.repeat(left)}${k}${' '.repeat(w - cells(k) - left)} `, style: { color: INK.badge, bg: INK.rule } })
      } else {
        line.push({ text: k + ' '.repeat(w - cells(k)), style: { color: INK.bright, bold: true } })
      }
    })
    line.push({ text: ' '.repeat(Math.max(0, keyW - spanCells(line) + 2)) })
    line.push({ text: desc, style: { color: INK.question } })
    out.push(line)
  })
  return out
}

function helpLines(s: ScreenInput, width: number, state: State): Line[] {
  const wide = width >= HELP_TWO_COL_MIN
  const rule = textLine([{ text: '─'.repeat(Math.max(1, width)), style: { color: INK.rule } }])
  const out: Line[] = []

  out.push(...wrap([{ text: 'claude review', style: { color: INK.bright, bold: true } }, { text: HELP_INTRO, style: { color: INK.question } }], width).map(textLine))
  out.push(blank(), rule, blank())

  const sections = HELP_GROUPS.map(([title, rows]) => helpSection(title, rows, wide))
  if (wide) {
    // MOVE and PANE on the left, HOLD and SURFACES on the right
    const left = [...sections[0]!, [], ...sections[3]!]
    const right = [...sections[1]!, [], ...sections[2]!]
    const leftW = Math.max(...left.map(spanCells))
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const l = left[i] ?? []
      out.push(textLine([...l, { text: ' '.repeat(leftW - spanCells(l) + 6) }, ...(right[i] ?? [])]))
    }
  } else {
    sections.forEach((sec, i) => {
      if (i > 0) out.push(blank())
      out.push(...sec.map(textLine))
    })
  }

  out.push(blank(), rule, blank())
  const value: Style = { color: INK.quiet }
  const facts: [string, string, Style][] = [
    ['state', state.word, state.style.color === INK.lamp ? state.style : value],
    ['session', s.facts?.session ?? '?', value],
    ['model', s.facts?.model ?? '?', value],
    ['project', s.facts?.project ?? '?', value],
    ['turns', s.turnCount > 0 ? `${s.cursor + 1} of ${s.turnCount} on screen` : '0', value],
    ['pane', `${s.placement}, ${s.columns} × ${s.rows}`, value],
  ]
  const labW = Math.max(...facts.map(([k]) => k.length)) + 2
  out.push(textLine([{ text: 'DIAGNOSTICS', style: { color: INK.meta } }]))
  for (const [k, v, st] of facts) {
    out.push(textLine([{ text: k.padEnd(labW), style: { color: INK.meta } }, { text: clip(oneline(v), Math.max(1, width - labW)), style: st }]))
  }

  return out
}

// ---------------------------------------------------------------- chrome

// Where the column sits in a pane `columns` wide: centred in the gutters, at
// most MEASURE cells, so a line stays a comfortable read on any dock.
export function columnOf(columns: number): Column {
  const gutter = columns >= 60 ? 4 : 2
  const room = Math.max(8, columns - 2 * gutter)
  const measure = Math.min(room, MEASURE)
  return { left: gutter + Math.floor((room - measure) / 2), measure }
}

// The lamp is the one colour on the page; the words that name its state stay
// grey, the state you set yourself (frozen) a step brighter.
export function stateOf(s: Pick<ScreenInput, 'view' | 'waiting' | 'working' | 'turnCount'>): State {
  const quiet: Style = { color: INK.quiet }
  if (s.view.frozen) return { word: 'frozen', style: { color: INK.bright } }
  if (s.waiting) return { word: 'waiting', style: { color: INK.bright } }
  if (s.working) return { word: 'working', style: quiet }
  return { word: s.turnCount > 0 ? 'done' : 'idle', style: quiet }
}

// The row under the lamp: what waits on you, why the page is dim, the
// section in view, or which earlier turn this is; blank when none applies.
// It belongs to the page, so it settles and dims with it.
// The eyebrow over what waits on you, when the surface shown is that thing.
function waitingFor(s: ScreenInput, surface: Surface): string | null {
  if (s.view.help || s.waiting === null) return null
  if (surface.label === 'question' && s.waiting === 'question') return 'Waiting for your answer'
  if (surface.label === 'plan' && s.turn.planWaiting && s.waiting === 'plan') return 'Waiting for your approval'
  return null
}

// A prompt as the page leads with it: `› ` and its words, wrapped to at most
// three rows, the last cut with an ellipsis when it runs on.
function promptRows(prompt: string, width: number, color: string): Span[][] {
  const style = { color }
  const rows = wrap([{ text: oneline(prompt), style }], width, [{ text: '› ', style }], [{ text: '  ' }])
  if (rows.length <= 3) return rows
  const text = (r: readonly Span[]): string => r.map(sp => sp.text).join('')
  return [...rows.slice(0, 2), [{ text: clip(`${text(rows[2]!)} ${text(rows[3]!).trimStart()}`, width), style }]]
}

function headRow(s: ScreenInput, surface: Surface, lines: readonly Line[], scroll: number, col: Column, lifted: boolean): Span[] {
  // what waits on you reads from the left; where you are, from the right
  const at = (text: string, style: Style): Span[] => [{ text: clip(text, col.measure), style }]
  const where = (text: string): Span[] => {
    const t = clip(text, col.measure)
    return [{ text: ' '.repeat(col.measure - cells(t)) }, { text: t, style: { color: INK.quiet, italic: true } }]
  }
  if (s.view.help) return []
  const ask = waitingFor(s, surface)
  if (ask && !lifted) return at(ask, { color: INK.bright, italic: true })
  if (s.dim && s.prompt) return promptRows(s.prompt, col.measure, INK.bright)[0]!
  // a section's own heading at the top of the view needs no running head
  const top = lines[scroll]
  if (scroll > 0 && !(top?.kind === 'text' && top.head !== undefined)) {
    const above = lines.slice(0, scroll).findLast(l => l.kind === 'text' && l.head !== undefined)
    if (above?.kind === 'text' && above.head) return where(oneline(above.head))
  }
  if (s.historical) return where(`Turn ${s.cursor + 1} of ${s.turnCount}`)
  return []
}

function keyRow(s: ScreenInput, col: Column, surfaces: readonly Surface[], active: number, state: State): Span[] {
  const meta: Style = { color: INK.meta }
  // the state word is padded so a change of state never shifts what follows
  const left: Span[] = [{ text: state.word.padEnd(7), style: state.style }]
  if (s.behind) left.push({ text: '   ' }, { text: 'new reply', style: { color: INK.lamp } })

  const right: Span[] = (() => {
    if (s.view.help) return [{ text: '↑↓ scroll · m close', style: meta }]
    if (s.view.flash) return [{ text: `✓ ${s.view.flash}`, style: { color: INK.bright } }]
    if (!s.isFocused) return [{ text: 'ctrl+x ⇥ focus', style: meta }]
    const cues = [s.view.frozen ? 'f unfreeze' : 'f freeze', ...(s.turnCount > 1 ? ['h l turns'] : []), 'm keys']
    return [{ text: cues.join(' · '), style: meta }]
  })()

  // surface tabs, only when there are several; they give way before the cues
  const tabs = (mode: 'full' | 'active' | 'none'): Span[] => {
    if (surfaces.length < 2 || mode === 'none' || s.view.help) return []
    const on: Style = { color: INK.bright, underline: true }
    if (mode === 'active') return [{ text: 't ', style: meta }, { text: surfaces[active]!.label, style: on }, { text: '    ' }]
    return [
      { text: 't ', style: meta },
      ...surfaces.flatMap((sf, i) => [{ text: sf.label, style: i === active ? on : meta }, { text: i < surfaces.length - 1 ? ' · ' : '    ', style: meta }]),
    ]
  }

  let tab: Span[] = []
  for (const mode of ['full', 'active', 'none'] as const) {
    tab = tabs(mode)
    if (spanCells(left) + spanCells(tab) + spanCells(right) + 1 <= col.measure) break
  }
  const pad = Math.max(1, col.measure - spanCells(left) - spanCells(tab) - spanCells(right))

  return [{ text: ' '.repeat(col.left) }, ...left, { text: ' '.repeat(pad) }, ...tab, ...right]
}

// ---------------------------------------------------------------- the tree

const isLink = (href: string): boolean => {
  try {
    return /^https:\/\/[\x21-\x7e]+$/.test(href) && !href.includes('@') && new URL(href).href === href
  } catch {
    return false
  }
}

export type Laid = {
  maxScroll: number
  bodyRows: number
  surfaces: Surface[]
  active: number
  column: Column
  // the body as cells, what a settle starts from
  page: Page
}

// `paint` may take over the body: given the page as cells, it returns the
// cells to draw instead (a settle's frame), or null to draw Text.
export function screen(E: ElementTable<'terminal'>, s: ScreenInput, paint?: (page: Page) => Uint32Array | null): { tree: JSX.Element; laid: Laid } {
  const { Box, Link, Raster, Text } = E
  const W = s.columns
  const col = columnOf(W)
  const bodyW = Math.max(1, W - 2) // the last two columns hold the fore-edge
  const bodyH = Math.max(1, s.rows - 4)

  const state = stateOf(s)
  const surfaces = surfacesFor(s.turn, s.tasks, s.historical, s.working)
  const active = Math.min(s.view.surface, surfaces.length - 1)
  const surface = surfaces[active]!

  // an earlier turn, or a new prompt over the dimmed answer, leads with its
  // prompt, so a reply is never read out of context
  const content = s.view.help ? helpLines(s, col.measure, state) : surface.lines(col.measure)
  // the new prompt rides the head row, and the dimmed answer is named above itself
  // (the new prompt's first row is the head row; the rest of it leads the page)
  const lead = s.view.help ? []
    : s.dim ? [
        ...(s.prompt ? promptRows(s.prompt, col.measure, INK.bright).slice(1).map(textLine) : []),
        blank(),
        textLine([{ text: 'Previous answer', style: { color: INK.quiet, italic: true } }]),
      ]
    : s.prompt ? [...promptRows(s.prompt, col.measure, INK.question).map(textLine), blank()]
    : []
  // what waits on you sits a third of the way down, where the eye rests,
  // when it is short enough to leave the room
  // and its eyebrow travels with it
  const ask = waitingFor(s, surface)
  const lit = (spans: readonly Span[]): Span[] =>
    spans.map(sp => ({ ...sp, style: { ...sp.style, color: hex(held(rgb(sp.style?.color ?? INK.body))) } }))
  // held warm in true colour only: a 256-colour terminal's nearest warm greys are pinks
  const asked = ask === null || !s.deep ? content : content.map(l => (l.kind === 'text' ? { ...l, spans: lit(l.spans) } : l))
  const room = bodyH - lead.length - content.length - 2
  const lifted = ask !== null && room > 2
  const lift = lifted
    ? [...Array.from({ length: Math.floor(room / 3) }, blank), textLine([{ text: ask, style: { color: INK.bright, italic: true } }])]
    : []
  const lines = [...lift, ...lead, ...asked, blank()]

  const maxScroll = Math.max(0, lines.length - bodyH)
  const scroll = Math.max(0, Math.min(s.view.scroll, maxScroll))
  const window = lines.slice(scroll, scroll + bodyH)

  // the page is the head row and the body window, as one grid of cells
  const head = headRow(s, surface, lines, scroll, col, lifted)
  const dimmed = (y: number): boolean => s.dim && scroll + y >= lead.length
  const inks = [1, ...window.map((_, y) => (dimmed(y) ? DIM : 1))]
  // the fore-edge sits beside the body rows, under the head row's spacer
  const marks = maxScroll > 0 ? paintEdge(lines.map(markOf), bodyH, scroll, bodyH) : null
  const page = { ...paintPage([textLine(head), ...window], col, W, bodyH + 1, inks), edge: W - bodyW }
  if (marks) for (let y = 0; y < bodyH; y++) page.cells.set(marks.subarray(y * 6, y * 6 + 6), ((y + 1) * W + bodyW) * 3)
  const painted = paint?.(page) ?? null
  const dimInk = (color: string): string => hex(mix(GROUND, rgb(color), DIM))
  const dim = (spans: readonly Span[]): Span[] => spans.map(sp => ({ ...sp, style: { ...sp.style, color: dimInk(sp.style?.color ?? INK.body) } }))

  const styled = (sp: Span): JSX.Element => {
    const st = sp.style ?? {}
    const props: Record<string, unknown> = {}
    if (st.color !== undefined) props.color = st.color
    if (st.bg !== undefined) props.backgroundColor = st.bg
    if (st.bold) props.bold = true
    if (st.italic) props.italic = true
    if (st.underline) props.underline = true
    if (st.strike) props.strikethrough = true
    const t = <Text {...props}>{sp.text}</Text>
    return st.href && isLink(st.href) ? <Link href={st.href}>{t}</Link> : t
  }
  // an empty Text takes no row, so a blank row is drawn as one space
  const row = (spans: readonly Span[], indent: number): JSX.Element => (
    <Text wrap="truncate-end">{' '.repeat(indent) || (spans.length === 0 ? ' ' : '')}{spans.map(styled)}</Text>
  )

  // the body as Text; consecutive rows of one code block draw as one panel
  const textBody = (): JSX.Element[] => {
    const body: JSX.Element[] = []
    let i = 0
    for (; i < window.length;) {
      const l = window[i]!
      if (l.kind === 'text') {
        body.push(row(dimmed(i) ? dim(l.spans) : l.spans, col.left))
        i += 1
        continue
      }
      const group: Extract<Line, { kind: 'code' }>[] = []
      while (i < window.length) {
        const g = window[i]!
        if (g.kind !== 'code' || g.block !== l.block) break
        group.push(g)
        i += 1
      }
      const preW = spanCells(l.prefix)
      // each row in the grey ramp; dimmed, a block dims with the page
      const parts = group.map(g => (g.pad ? <Text> </Text> : row(s.dim ? dim(g.spans) : g.spans, 0)))
      body.push(
        <Box flexDirection="row">
          {row(l.prefix, col.left)}
          <Box flexDirection="column" width={Math.max(4, col.measure - preW)} paddingX={1} backgroundColor={s.dim ? exact(mix(GROUND, rgb(INK.codeBg), DIM)) : INK.codeBg}>
            {parts}
          </Box>
        </Box>,
      )
    }
    // pad by rows, not elements: a code panel is one element over several rows
    for (; i < bodyH; i++) body.push(<Text> </Text>)
    return body
  }

  const edge = marks
    ? (
        <Box flexDirection="column">
          <Text>{'  '}</Text>
          <Raster key="edge" columns={2} rows={bodyH} cells={encode(marks)} />
        </Box>
      )
    : null

  const tree = (
    <Box flexDirection="column" backgroundColor={INK.ground}>
      {s.still
        // still, the lamp is Text at full colour depth; moving, a Raster the timer repaints
        ? row(lampSpans(paintLamp(W, col, s.lamp, s.deep)), 0)
        : <Raster key="lamp" columns={W} rows={1} cells={encode(paintLamp(W, col, s.lamp, s.deep))} />}
      {painted
        // a settle paints the body and its fore-edge as one grid, so the edge rises with its rows
        ? <Raster key="page" columns={W} rows={bodyH + 1} cells={encode(painted)} />
        : (
            <Box flexDirection="row">
              <Box flexDirection="column" width={bodyW}>{[row(head, col.left), ...textBody()]}</Box>
              {edge}
            </Box>
          )}
      <Text> </Text>
      {row(keyRow(s, col, surfaces, active, state), 0)}
    </Box>
  )

  return { tree, laid: { maxScroll, bodyRows: bodyH, surfaces, active, column: col, page } }
}
