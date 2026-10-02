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
import { encode, markOf, paintEdge, paintLamp, paintPage } from './paint'
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
  // the lamp's level now, 0 to 1
  lamp: number
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
  if (historical) return [note('(this turn produced no response text)')]
  return [note(working ? '(no response yet, Claude is working)' : '(no response yet)')]
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
  const value: Style = { color: INK.meta }
  const facts: [string, string, Style][] = [
    ['state', state.word, state.style.color === INK.lamp ? state.style : value],
    ['session', s.facts?.session ?? '?', value],
    ['model', s.facts?.model ?? '?', value],
    ['project', s.facts?.project ?? '?', value],
    ['turns', s.turnCount > 0 ? `${s.cursor + 1} of ${s.turnCount} on screen` : '0', value],
    ['pane', `${s.placement}, ${s.columns} × ${s.rows}`, value],
  ]
  const labW = Math.max(...facts.map(([k]) => k.length)) + 2
  out.push(textLine([{ text: 'DIAGNOSTICS', style: { color: INK.rule } }]))
  for (const [k, v, st] of facts) {
    out.push(textLine([{ text: k.padEnd(labW), style: { color: INK.rule } }, { text: clip(oneline(v), Math.max(1, width - labW)), style: st }]))
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

export function stateOf(s: Pick<ScreenInput, 'view' | 'waiting' | 'working' | 'turnCount'>): State {
  const lamp: Style = { color: INK.lamp }
  const quiet: Style = { color: INK.quiet }
  if (s.view.frozen) return { word: 'frozen', style: lamp }
  if (s.waiting) return { word: 'waiting', style: lamp }
  if (s.working) return { word: 'working', style: quiet }
  return { word: s.turnCount > 0 ? 'done' : 'idle', style: quiet }
}

// The row under the lamp: what waits on you, why the page is dim, the
// section in view, or which earlier turn this is; blank when none applies.
function headRow(s: ScreenInput, surface: Surface, lines: readonly Line[], scroll: number, col: Column): Span[] {
  const at = (text: string, style: Style): Span[] => [{ text: ' '.repeat(col.left) }, { text: clip(text, col.measure), style }]
  if (s.view.help) return []
  if (surface.label === 'question' && s.waiting === 'question') return at('Waiting for your answer', { color: INK.lamp })
  if (surface.label === 'plan' && s.turn.planWaiting && s.waiting === 'plan') return at('Waiting for your approval', { color: INK.lamp })
  if (s.dim) return at('The last answer, until the new one lands', { color: INK.quiet, italic: true })
  // a section's own heading at the top of the view needs no running head
  const top = lines[scroll]
  if (scroll > 0 && !(top?.kind === 'text' && top.head !== undefined)) {
    const above = lines.slice(0, scroll).findLast(l => l.kind === 'text' && l.head !== undefined)
    if (above?.kind === 'text' && above.head) return at(oneline(above.head), { color: INK.quiet })
  }
  if (s.historical) return at(`Turn ${s.cursor + 1} of ${s.turnCount}`, { color: INK.quiet })
  return []
}

function keyRow(s: ScreenInput, col: Column, surfaces: readonly Surface[], active: number, state: State): Span[] {
  const meta: Style = { color: INK.meta }
  // the state word is padded so a change of state never shifts what follows
  const left: Span[] = [{ text: state.word.padEnd(7), style: state.style }]
  if (s.behind) left.push({ text: '   ' }, { text: 'new reply', style: { color: INK.lamp } })

  const right: Span[] = (() => {
    if (s.view.help) return [{ text: '↑↓ scroll · m close', style: meta }]
    if (s.view.flash) return [{ text: `✓ ${s.view.flash}`, style: { color: INK.lamp } }]
    if (!s.isFocused) return [{ text: 'ctrl+x ⇥ focus', style: meta }]
    const cues = [s.view.frozen ? 'f unfreeze' : 'f freeze', ...(s.turnCount > 1 ? ['h l turns'] : []), 'm more']
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
  const { Box, Code, Link, Raster, Text } = E
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
  const lead = !s.view.help && s.prompt
    ? [textLine([{ text: clip(`› ${oneline(s.prompt)}`, col.measure), style: { color: s.dim ? INK.bright : INK.question } }]), blank()]
    : []
  const lines = [...lead, ...content, blank()]

  const maxScroll = Math.max(0, lines.length - bodyH)
  const scroll = Math.max(0, Math.min(s.view.scroll, maxScroll))
  const window = lines.slice(scroll, scroll + bodyH)

  const inks = window.map((_, y) => (s.dim && scroll + y >= lead.length ? DIM : 1))
  const page = paintPage(window, col, bodyW, bodyH, inks)
  const painted = paint?.(page) ?? (s.dim ? page.cells : null)

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
        body.push(row(l.spans, col.left))
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
      const parts: JSX.Element[] = []
      for (let k = 0; k < group.length;) {
        if (group[k]!.pad) {
          parts.push(<Text> </Text>)
          k += 1
          continue
        }
        const run: string[] = []
        while (k < group.length && !group[k]!.pad) {
          // a blank line inside a block keeps its row
          run.push(clip(group[k]!.text, col.measure + 8) || ' ')
          k += 1
        }
        const language = /^[\w+#.-]{1,24}$/.test(l.language) ? l.language : undefined
        parts.push(run.some(r => r.trim() !== '')
          ? <Code source={run.join('\n')} wrap="truncate-end" {...(language ? { language } : {})} />
          : <Box flexDirection="column">{run.map(() => <Text> </Text>)}</Box>)
      }
      body.push(
        <Box flexDirection="row">
          {row(l.prefix, col.left)}
          <Box flexDirection="column" width={Math.max(4, col.measure - preW)} paddingX={1} backgroundColor={INK.codeBg}>
            {parts}
          </Box>
        </Box>,
      )
    }
    // pad by rows, not elements: a code panel is one element over several rows
    for (; i < bodyH; i++) body.push(<Text> </Text>)
    return body
  }

  const edge = maxScroll > 0
    ? <Raster key="edge" columns={2} rows={bodyH} cells={encode(paintEdge(lines.map(markOf), bodyH, scroll, bodyH))} />
    : null

  const tree = (
    <Box flexDirection="column" backgroundColor={INK.ground}>
      <Raster key="lamp" columns={W} rows={1} cells={encode(paintLamp(W, col, s.lamp))} />
      {row(headRow(s, surface, lines, scroll, col), 0)}
      <Box flexDirection="row">
        <Box flexDirection="column" width={bodyW}>
          {painted ? <Raster key="page" columns={bodyW} rows={bodyH} cells={encode(painted)} /> : textBody()}
        </Box>
        {edge}
      </Box>
      <Text> </Text>
      {row(keyRow(s, col, surfaces, active, state), 0)}
    </Box>
  )

  return { tree, laid: { maxScroll, bodyRows: bodyH, surfaces, active, column: col, page } }
}
