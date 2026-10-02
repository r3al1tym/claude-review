// The terminal pane, laid out as the CLI's render_screen: no header, the
// response owns the column. Chrome is three rows: a top rule carrying the
// wordmark, a bottom rule carrying the overflow cue, and one key row with
// the state on the left and the cues on the right. Every frame element is
// greyscale; the one colour marks the state you set (frozen, new reply).

import type { ElementTable } from 'claude-code'

import type { ReviewTask, ReviewTurn, ReviewView } from '../types'
import { INK, layout } from './markdown'
import type { Line } from './markdown'
import { cells, clip, oneline, spanCells, wrap } from './text'
import type { Span, Style } from './text'

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
}

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

function helpLines(s: ScreenInput, width: number, state: [string, string, Style]): Line[] {
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
  const [dot, word, style] = state
  const value: Style = { color: INK.meta }
  const facts: [string, string, Style][] = [
    ['state', `${dot} ${word}`, word === 'frozen' ? style : value],
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

// A hairline rule with text inset into it, left (the wordmark) and right (an
// overflow cue), so labels sit exactly where the content edge is.
function insetRule(width: number, gutter: number, left: string | null, right: string | null): Span[] {
  const rule: Style = { color: INK.rule }
  const spans: Span[] = [{ text: ' '.repeat(gutter) }, { text: '──', style: rule }]
  let used = gutter + 2
  const rt = right ? ` ${right} ` : null
  if (left) {
    const budget = width - used - gutter - 2 - (rt ? cells(rt) + 2 : 0)
    const lt = clip(` ${left} `, Math.max(1, budget))
    spans.push({ text: lt, style: { color: INK.badge, bg: INK.rule } })
    used += cells(lt)
  }
  if (rt) {
    spans.push({ text: '─'.repeat(Math.max(0, width - used - cells(rt) - 2 - gutter)), style: rule })
    spans.push({ text: rt, style: { color: INK.meta } }, { text: '──', style: rule })
  } else {
    spans.push({ text: '─'.repeat(Math.max(0, width - used - gutter)), style: rule })
  }
  return spans
}

function keyRow(s: ScreenInput, gutter: number, surfaces: readonly Surface[], active: number, state: [string, string, Style]): Span[] {
  const meta: Style = { color: INK.meta }
  const [dot, word, style] = state
  // the state word is padded so a change of state never shifts what follows
  const left: Span[] = [{ text: ' '.repeat(gutter) }, { text: `${dot} ${word.padEnd(7)}`, style }]
  if (s.behind) left.push({ text: '   ' }, { text: 'new reply', style: { color: INK.accent } })

  const right: Span[] = (() => {
    if (s.view.help) return [{ text: '↑↓ scroll · m close', style: meta }]
    if (s.view.flash) return [{ text: `✓ ${s.view.flash}`, style: { color: INK.accent } }]
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
    if (spanCells(left) + spanCells(tab) + spanCells(right) + gutter <= s.columns) break
  }
  const pad = Math.max(1, s.columns - spanCells(left) - spanCells(tab) - spanCells(right) - gutter)

  return [...left, { text: ' '.repeat(pad) }, ...tab, ...right]
}

// ---------------------------------------------------------------- the tree

const isLink = (href: string): boolean => {
  try {
    return /^https:\/\/[\x21-\x7e]+$/.test(href) && !href.includes('@') && new URL(href).href === href
  } catch {
    return false
  }
}

export type Laid = { maxScroll: number; bodyRows: number; surfaces: Surface[]; active: number }

export function screen(E: ElementTable<'terminal'>, s: ScreenInput): { tree: JSX.Element; laid: Laid } {
  const { Box, Code, Link, Text } = E
  const W = s.columns
  const gutter = W >= 60 ? 4 : 2
  const inner = Math.max(8, W - 2 * gutter)
  const bodyH = Math.max(1, s.rows - 3)

  const state: [string, string, Style] = s.view.frozen
    ? ['■', 'frozen', { color: INK.accent }]
    : s.working ? ['●', 'working', { color: INK.meta }] : ['○', 'idle', { color: INK.meta }]

  const surfaces = surfacesFor(s.turn, s.tasks, s.historical, s.working)
  const active = Math.min(s.view.surface, surfaces.length - 1)

  // vertical air and the gutter make the content its own column; an earlier
  // turn leads with the prompt it answered, so it is never read out of context
  const content = s.view.help ? helpLines(s, inner, state) : surfaces[active]!.lines(inner)
  const lead = !s.view.help && s.historical && s.turn.question
    ? [textLine([{ text: clip(`› ${oneline(s.turn.question)}`, inner), style: { color: INK.question } }]), blank()]
    : []
  const lines = [blank(), ...lead, ...content, blank()]

  const maxScroll = Math.max(0, lines.length - bodyH)
  const scroll = Math.max(0, Math.min(s.view.scroll, maxScroll))
  const window = lines.slice(scroll, scroll + bodyH)

  const styled = (sp: Span): JSX.Element => {
    const st = sp.style ?? {}
    const props: Record<string, unknown> = {}
    if (st.color !== undefined) props.color = `ansi256(${st.color})`
    if (st.bg !== undefined) props.backgroundColor = `ansi256(${st.bg})`
    if (st.bold) props.bold = true
    if (st.italic) props.italic = true
    if (st.underline) props.underline = true
    if (st.strike) props.strikethrough = true
    const t = <Text {...props}>{sp.text}</Text>
    return st.href && isLink(st.href) ? <Link href={st.href}>{t}</Link> : t
  }
  const row = (spans: readonly Span[], indent: number): JSX.Element => (
    <Text wrap="truncate-end">{' '.repeat(indent)}{spans.map(styled)}</Text>
  )

  // consecutive rows of one code block draw as one panel, its lines one Code
  const body: JSX.Element[] = []
  let i = 0
  for (; i < window.length;) {
    const l = window[i]!
    if (l.kind === 'text') {
      body.push(row(l.spans, gutter))
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
        run.push(clip(group[k]!.text, inner + 8))
        k += 1
      }
      const language = /^[\w+#.-]{1,24}$/.test(l.language) ? l.language : undefined
      parts.push(run.some(r => r.trim() !== '')
        ? <Code source={run.join('\n')} wrap="truncate-end" {...(language ? { language } : {})} />
        : <Box flexDirection="column">{run.map(() => <Text> </Text>)}</Box>)
    }
    body.push(
      <Box flexDirection="row">
        {row(l.prefix, gutter)}
        <Box flexDirection="column" width={Math.max(4, inner - preW)} paddingX={1} backgroundColor={`ansi256(${INK.codeBg})`}>
          {parts}
        </Box>
      </Box>,
    )
  }
  // pad by rows, not elements: a code panel is one element over several rows
  for (; i < bodyH; i++) body.push(<Text> </Text>)

  const more = maxScroll > 0 && scroll < maxScroll
  const top = insetRule(W, gutter, 'claude review', scroll > 0 ? '▲' : null)
  const bottom = insetRule(W, gutter, null, more ? `▼ ${Math.round((100 * scroll) / maxScroll)}%` : null)

  const tree = (
    <Box flexDirection="column">
      {row(top, 0)}
      {body}
      {row(bottom, 0)}
      {row(keyRow(s, gutter, surfaces, active, state), 0)}
    </Box>
  )

  return { tree, laid: { maxScroll, bodyRows: bodyH, surfaces, active } }
}
