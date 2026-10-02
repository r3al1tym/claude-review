// Markdown to rows, in a monochrome reading theme: emphasis comes from weight
// (bold, italic, underline) and a grey ramp, never hue, so the only bright
// thing in the column is the text itself. Code is set in the same ramp, by
// weight and shade (hooks/syntax.ts).

import { cells, clean, wrap } from './text'
import type { Span, Style } from './text'
import { highlight } from './syntax'
import type { Ramp } from './syntax'

// Every colour is a 12-bit one (#rgb doubled): a Raster paints at that depth,
// so Text and the painted page land on the same values.
export const INK = {
  ground: '#222222', // the page
  meta: '#666666', // the quietest words: cues
  body: '#cccccc', // running text
  quiet: '#888888', // running heads, eyebrows, the state word
  question: '#999999', // frames the content: quotes, list marks, prompts
  rule: '#444444', // hairlines
  bright: '#dddddd',
  brightest: '#eeeeee', // headings
  link: '#888888',
  code: '#eeeeee', // inline code: the brightest ink, no chip
  codeBg: '#333333', // a step above the page
  string: '#aaaaaa', // strings in a code block, a step under its body
  badge: '#aaaaaa', // key chips, on the rule's grey
  lamp: '#ddaa66', // tungsten, for the words that speak for the lamp
} as const

// a code block in the grey ramp: keywords bold at the full ink, strings a
// step down, comments quiet and italic
const CODE: Ramp = {
  plain: { color: INK.body },
  keyword: { color: INK.brightest, bold: true },
  string: { color: INK.string },
  comment: { color: INK.quiet, italic: true },
}

export type Line =
  | { kind: 'text'; spans: Span[]; head?: string }
  | { kind: 'code'; prefix: Span[]; text: string; spans: Span[]; language: string; block: number; pad: boolean }

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; header: string[]; align: ('left' | 'right' | 'center')[]; rows: string[][] }

// ---------------------------------------------------------------- inline

const merge = (a: Style | undefined, b: Style): Style => ({ ...a, ...b })

function closing(src: string, from: number, delim: string, guardWord: boolean): number {
  let i = from
  while (i < src.length) {
    const at = src.indexOf(delim, i)
    if (at < 0) return -1
    const before = src[at - 1] ?? ''
    const after = src[at + delim.length] ?? ''
    if (at > from && before !== ' ' && (!guardWord || !/[\p{L}\p{N}]/u.test(after))) return at
    i = at + 1
  }
  return -1
}

export function inline(src: string, base?: Style): Span[] {
  const out: Span[] = []
  let text = ''
  const flush = (): void => {
    if (text !== '') out.push({ text, style: base })
    text = ''
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const rest = src.slice(i)

    if (c === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] ?? '')) {
      text += src[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        let code = src.slice(i + run.length, end).replace(/\n/g, ' ')
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
        out.push({ text: code, style: merge(base, { color: INK.code }) })
        i = end + run.length
        continue
      }
    }

    const link = /^!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
    if (link) {
      flush()
      const [whole, label, href] = link
      const style = merge(base, { color: INK.link, ...(/^https?:\/\//.test(href!) ? { href } : {}) })
      out.push(...inline(label || href!, style))
      i += whole.length
      continue
    }

    const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest)
    if (auto) {
      flush()
      out.push({ text: auto[1]!, style: merge(base, { color: INK.link, href: auto[1] }) })
      i += auto[0].length
      continue
    }

    const strong = /^(\*\*\*|\*\*|__|~~|\*|_)/.exec(rest)
    if (strong) {
      const delim = strong[1]!
      const wordy = delim.startsWith('_')
      const opensWord = !wordy || !/[\p{L}\p{N}]/u.test(src[i - 1] ?? '')
      const next = src[i + delim.length] ?? ''
      const end = opensWord && next !== ' ' && next !== '' ? closing(src, i + delim.length, delim, wordy) : -1
      if (end > 0) {
        flush()
        const style: Style =
          delim === '***' ? { bold: true, italic: true }
          : delim === '**' || delim === '__' ? { bold: true }
          : delim === '~~' ? { strike: true }
          : { italic: true }
        out.push(...inline(src.slice(i + delim.length, end), merge(base, style)))
        i = end + delim.length
        continue
      }
    }

    text += c
    i += 1
  }
  flush()

  return out
}

// ---------------------------------------------------------------- blocks

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (s: string): number => /^ */.exec(s)![0].length
const isBlank = (s: string): boolean => s.trim() === ''
const cellsOf = (row: string): string[] =>
  row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))
}

export function parse(src: string): Block[] {
  return blocks(clean(src).split('\n'))
}

function blocks(lines: readonly string[]): Block[] {
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const [, pad, marks, language] = fence
      const body: string[] = []
      i += 1
      while (i < lines.length && !new RegExp(`^\\s*${marks![0]}{${marks!.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!.slice(Math.min(pad!.length, indentOf(lines[i]!))))
        i += 1
      }
      i += 1
      out.push({ kind: 'code', language: language ?? '', lines: body })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      i += 1
      continue
    }

    if (HR.test(line)) {
      out.push({ kind: 'hr' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && !isBlank(lines[i]!) && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!, lines[i + 1]))) {
        body.push(lines[i]!.replace(QUOTE, ''))
        i += 1
      }
      out.push({ kind: 'quote', blocks: blocks(body) })
      continue
    }

    if (line.includes('|') && lines[i + 1] !== undefined && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = cellsOf(line)
      const align = cellsOf(lines[i + 1]!).map(c => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left') as 'left' | 'right' | 'center')
      const rows: string[][] = []
      i += 2
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
        rows.push(cellsOf(lines[i]!))
        i += 1
      }
      out.push({ kind: 'table', header, align, rows })
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2]!)
      const base = item[1]!.length
      const items: string[][] = []
      let start = ordered ? Number.parseInt(item[2]!, 10) : 1
      let contentIndent = 0
      while (i < lines.length) {
        const cur = lines[i]!
        const m = ITEM.exec(cur)
        if (m && m[1]!.length <= base + 1 && /\d/.test(m[2]!) === ordered) {
          if (items.length === 0) start = ordered ? Number.parseInt(m[2]!, 10) : 1
          contentIndent = m[1]!.length + m[2]!.length + Math.min(m[3]!.length, 4)
          items.push([m[4]!])
          i += 1
          continue
        }
        if (isBlank(cur)) {
          const next = lines[i + 1]
          if (next === undefined || (indentOf(next) < contentIndent && !(ITEM.test(next) && indentOf(next) <= base + 1))) break
          items[items.length - 1]!.push('')
          i += 1
          continue
        }
        if (indentOf(cur) >= contentIndent) {
          items[items.length - 1]!.push(cur.slice(contentIndent))
          i += 1
          continue
        }
        // a lazy continuation of the item's paragraph
        const prev = items[items.length - 1]!
        if (!isBlank(prev[prev.length - 1] ?? '') && !startsBlock(cur, lines[i + 1])) {
          prev.push(cur.trim())
          i += 1
          continue
        }
        break
      }
      out.push({ kind: 'list', ordered, start, items: items.map(it => blocks(it)) })
      continue
    }

    const para: string[] = []
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      const l = lines[i]!
      // a hard break: two trailing spaces or a backslash
      para.push(/( {2,}|\\)$/.test(l) ? `${l.replace(/( {2,}|\\)$/, '')}\n` : l.trim())
      i += 1
    }
    out.push({ kind: 'para', text: para.join(' ').replace(/\n /g, '\n') })
  }

  return out
}

// ---------------------------------------------------------------- layout

const text = (spans: Span[]): Line => ({ kind: 'text', spans })
const blank = (): Line => text([])

function prefixed(lines: Line[], first: Span[], rest: Span[]): Line[] {
  return lines.map((l, n) => {
    const pre = n === 0 ? first : rest
    return l.kind === 'text' ? { ...l, spans: [...pre, ...l.spans] } : { ...l, prefix: [...pre, ...l.prefix] }
  })
}

let blockSeq = 0

// The lamp redraws the pane many times a second while it moves, so a reply is
// laid out once per width and the drawing reuses it. Lines are never mutated.
const laidOut = new Map<string, Line[]>()

export function layout(src: string, width: number): Line[] {
  const key = `${width}\u0000${src}`
  const hit = laidOut.get(key)
  if (hit) return hit
  const lines = stack(parse(src), Math.max(8, width), { color: INK.body }, false)
  if (laidOut.size >= 16) laidOut.delete(laidOut.keys().next().value!)
  laidOut.set(key, lines)
  return lines
}

// Blocks sit a blank row apart, except a list right under its line inside a
// list item, which rich keeps tight, and a section heading's first block.
function stack(list: readonly Block[], width: number, base: Style | undefined, inItem: boolean): Line[] {
  const out: Line[] = []
  list.forEach((b, n) => {
    const prev = list[n - 1]
    // a section heading sits on its own text: air above it, none below; a
    // code panel or a table keeps its row of air, as a form of its own
    const tight = (inItem && b.kind === 'list' && prev?.kind === 'para') || (prev?.kind === 'heading' && prev.level > 1 && b.kind !== 'code' && b.kind !== 'table')
    if (n > 0 && !tight) out.push(blank())
    out.push(...block(b, width, base))
  })
  return out
}

function block(b: Block, width: number, base: Style | undefined): Line[] {
  switch (b.kind) {
    case 'heading': {
      const style: Style = b.level === 1 ? { bold: true, underline: true } : b.level <= 3 ? { bold: true } : { bold: true, italic: true }
      const spans = inline(b.text, merge(base, { ...style, color: INK.brightest }))
      // every row of a heading carries its words, for the running head and the fore-edge
      const head = spans.map(s => s.text).join('')
      const rows = wrap(spans, width)
      if (b.level !== 1) return rows.map((r): Line => ({ kind: 'text', spans: r, head }))
      return rows.map((r): Line => {
        const pad = Math.max(0, Math.floor((width - r.reduce((w, s) => w + cells(s.text), 0)) / 2))
        return { kind: 'text', spans: [{ text: ' '.repeat(pad) }, ...r], head }
      })
    }
    case 'para':
      return wrap(inline(b.text, base), width).map(text)
    case 'hr':
      return [text([{ text: '─'.repeat(width), style: { color: INK.rule } }])]
    case 'code': {
      const id = ++blockSeq
      const row = (spans: Span[], pad: boolean): Line =>
        ({ kind: 'code', prefix: [], text: spans.map(sp => sp.text).join(''), spans, language: b.language, block: id, pad })
      const set = highlight(b.lines, b.language, CODE)
      // the panel pads a cell a side
      return [row([], true), ...b.lines.flatMap((l, n) => fold(set[n]!, softWrap(l, width - 2))).map(sp => row(sp, false)), row([], true)]
    }
    case 'quote': {
      const quoteStyle = merge(base, { color: INK.question, italic: true })
      const bar: Span = { text: '▌ ', style: { color: INK.question, italic: true } }
      return prefixed(stack(b.blocks, width - 2, quoteStyle, false), [bar], [bar])
    }
    case 'list': {
      const last = b.start + b.items.length - 1
      const markW = b.ordered ? String(last).length + 2 : 3
      const out: Line[] = []
      b.items.forEach((item, n) => {
        const mark = b.ordered ? ` ${String(b.start + n).padStart(markW - 2)} ` : ' • '
        const body = stack(item, width - markW, base, true)
        out.push(...prefixed(body.length > 0 ? body : [blank()], [{ text: mark, style: { color: INK.question } }], [{ text: ' '.repeat(markW) }]))
      })
      return out
    }
    case 'table':
      return table(b, width, base)
  }
}

// A code line wider than the panel wraps where a formatter would break it:
// after a comma first, then after an opening bracket, then after an operator
// or a space, taking the latest such break in the line's second half, else
// cutting where it must. Each continuation hangs four cells under the line's
// own indent, deeper than the next block level, so it never reads as a new
// statement.
const BREAKS: readonly RegExp[] = [/,/, /[({[]/, /[=:|&?+-]/, /\s/]

export function softWrap(line: string, width: number): string[] {
  if (cells(line) <= width || width < 8) return [line]
  const hang = ' '.repeat(Math.min((/^ */.exec(line)?.[0].length ?? 0) + 4, Math.floor(width / 2)))
  const out: string[] = []
  let rest = [...line]
  for (let first = true; cells(rest.join('')) > width; first = false) {
    let fit = 0
    for (let used = 0; fit < rest.length && (used += cells(rest[fit]!)) <= width;) fit++
    const floor = Math.max(first ? 1 : hang.length + 1, Math.floor(fit / 2))
    let cut = fit
    for (const brk of BREAKS) {
      const at = rest.slice(0, fit).findLastIndex((ch, i) => i + 1 >= floor && brk.test(ch) && rest[i + 1] !== undefined)
      if (at >= 0) {
        cut = at + 1
        break
      }
    }
    out.push(rest.slice(0, cut).join('').trimEnd())
    rest = [...hang, ...rest.slice(cut).join('').trimStart()]
  }
  out.push(rest.join(''))
  return out
}

// A line's styled spans laid onto the rows softWrap cut it into: each row
// after the first opens with its hang, and the spaces a cut trimmed drop out.
function fold(spans: readonly Span[], rows: readonly string[]): Span[][] {
  const chars = spans.flatMap(sp => [...sp.text].map(ch => ({ ch, style: sp.style })))
  let p = 0
  return rows.map((r, n) => {
    const out: Span[] = []
    const body = n === 0 ? r : r.trimStart()
    if (body.length < r.length) out.push({ text: r.slice(0, r.length - body.length) })
    if (n > 0) while (p < chars.length && /\s/.test(chars[p]!.ch)) p++
    for (const ch of body) {
      const style = chars[p]?.ch === ch ? chars[p]!.style : undefined
      p++
      const last = out[out.length - 1]
      if (last && last.style === style) last.text += ch
      else out.push(style ? { text: ch, style } : { text: ch })
    }
    return out
  })
}

function table(b: Extract<Block, { kind: 'table' }>, width: number, base: Style | undefined): Line[] {
  const ncol = Math.max(b.header.length, ...b.rows.map(r => r.length))
  const grid = [b.header, ...b.rows].map(r => Array.from({ length: ncol }, (_, c) => inline(r[c] ?? '', base)))
  const natural = Array.from({ length: ncol }, (_, c) => Math.max(1, ...grid.map(r => r[c]!.reduce((w, s) => w + cells(s.text), 0))))
  const gap = 2
  const room = width - 1 - gap * (ncol - 1)
  const widths = [...natural]
  // shrink the widest column a cell at a time until the table fits
  while (widths.reduce((a, w) => a + w, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 4) break
    widths[widest]! -= 1
  }

  const out: Line[] = []
  const cellsOfRow = grid.map((row, r) => row.map((cell, c) => wrap(r === 0 ? cell.map(s => ({ ...s, style: merge(s.style, { bold: true }) })) : cell, widths[c]!)))
  // once any row wraps, rows sit a blank apart so each reads as one record
  const airy = cellsOfRow.slice(1).some(row => row.some(w => w.length > 1))
  cellsOfRow.forEach((wrapped, r) => {
    if (airy && r > 1) out.push(text([]))
    const height = Math.max(...wrapped.map(w => w.length))
    for (let k = 0; k < height; k++) {
      const spans: Span[] = [{ text: ' ' }]
      wrapped.forEach((w, c) => {
        const content = w[k] ?? []
        const used = content.reduce((a, s) => a + cells(s.text), 0)
        const free = Math.max(0, widths[c]! - used)
        const align = b.align[c] ?? 'left'
        const left = align === 'right' ? free : align === 'center' ? Math.floor(free / 2) : 0
        if (left > 0) spans.push({ text: ' '.repeat(left) })
        spans.push(...content)
        if (c < ncol - 1) spans.push({ text: ' '.repeat(free - left + gap) })
      })
      out.push(text(spans))
    }
    if (r === 0) out.push(text([{ text: ' ' }, { text: '─'.repeat(widths.reduce((a, w) => a + w, 0) + gap * (ncol - 1)), style: { color: INK.rule } }]))
  })

  return out
}
