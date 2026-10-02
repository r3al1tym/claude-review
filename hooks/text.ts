// Cells and wrapping for the terminal pane. The pane lays out its own rows
// (as the CLI does with rich's render_lines), so the chrome stays pinned and
// the overflow cues know exactly how much is above and below.

export type Style = {
  color?: string // #rrggbb
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  href?: string
}

export type Span = { text: string; style?: Style }

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1faff], [0x20000, 0x3fffd],
]

const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff],
]

const within = (cp: number, ranges: readonly [number, number][]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

// How many cells one code point takes: 0, 1 or 2.
export const cellsOf = (cp: number): number => (within(cp, ZERO) ? 0 : within(cp, WIDE) ? 2 : 1)

export function cells(s: string): number {
  let n = 0
  for (const ch of s) n += cellsOf(ch.codePointAt(0) ?? 0)
  return n
}

// Control bytes a transcript may carry (pasted ANSI, OSC 52) never reach the
// screen: C0 and C1 go, newline stays, tab becomes spaces.
export const clean = (s: string): string =>
  s.replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')

export const oneline = (s: string): string => clean(s).replace(/\s+/g, ' ').trim()

export const spanCells = (spans: readonly Span[]): number => spans.reduce((n, s) => n + cells(s.text), 0)

// Cut to at most `width` cells, with an ellipsis when anything was dropped.
export function clip(s: string, width: number): string {
  if (cells(s) <= width) return s
  let out = ''
  for (const ch of s) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

type Piece = { text: string; style?: Style; space: boolean }

// Greedy word wrap over styled spans. `first` and `rest` prefix the first and
// following rows (a list marker, then its hanging indent). A `\n` inside a
// span is a hard break; a word wider than the row is cut by cells.
export function wrap(spans: readonly Span[], width: number, first: readonly Span[] = [], rest: readonly Span[] = first): Span[][] {
  const pieces: Piece[] = []
  for (const span of spans) {
    for (const part of span.text.split(/(\n| +)/)) {
      if (part === '') continue
      pieces.push({ text: part, style: span.style, space: part !== '\n' && part.trim() === '' })
    }
  }

  const rows: Span[][] = []
  let row: Span[] = [...first]
  let used = spanCells(first)
  let empty = true

  const push = (): void => {
    rows.push(row)
    row = [...rest]
    used = spanCells(rest)
    empty = true
  }

  for (const p of pieces) {
    if (p.text === '\n') {
      push()
      continue
    }
    if (p.space) {
      if (!empty) {
        row.push({ text: ' ', style: p.style })
        used += 1
      }
      continue
    }
    let word = p.text
    if (!empty && used + cells(word) > width) {
      while (row.length > 0 && row[row.length - 1]!.text === ' ') {
        row.pop()
        used -= 1
      }
      push()
    }
    // a word wider than the row: cut it by cells
    while (cells(word) > width - used) {
      let head = ''
      for (const ch of word) {
        if (cells(head + ch) > width - used) break
        head += ch
      }
      if (head === '') head = [...word][0] ?? ''
      row.push({ text: head, style: p.style })
      word = word.slice(head.length)
      push()
    }
    if (word !== '') {
      row.push({ text: word, style: p.style })
      used += cells(word)
      empty = false
    }
  }
  if (!empty || rows.length === 0 || row.length > rest.length) rows.push(row)

  return rows.map(r => {
    while (r.length > 0 && r[r.length - 1]!.text === ' ') r.pop()
    return r
  })
}
