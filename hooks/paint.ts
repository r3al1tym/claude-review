// The pane's light, painted as Raster cells in exact 24-bit colour: the lamp
// over the text column, the fore-edge map, and the page itself whenever it
// has to move (the settle) or sit dimmed. Text takes the 256-colour palette,
// so every grey here is an xterm palette entry and a painted page lands on
// exactly the colours its Text drawing shows.

import { INK } from './markdown'
import type { Line } from './markdown'
import { cellsOf, clip, spanCells } from './text'
import type { Span } from './text'

export const GROUND = 0x262626 // the dock's ground, palette 235
export const LAMP = 0xe2a65a // tungsten: the lamp, the pane's one colour

const BASIC = [
  0x0c0c0c, 0xc50f1f, 0x13a10e, 0xc19c00, 0x0037da, 0x881798, 0x3a96dd, 0xcccccc,
  0x767676, 0xe74856, 0x16c60c, 0xf9f1a5, 0x3b78ff, 0xb4009e, 0x61d6d6, 0xf2f2f2,
]
const LEVELS = [0, 95, 135, 175, 215, 255]

// A palette entry as RGB; the sixteen basic colours are the terminal's own,
// so they read as Windows Terminal's defaults.
export function xterm(n: number): number {
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return (v << 16) | (v << 8) | v
  }
  if (n >= 16) {
    const i = n - 16
    return (LEVELS[Math.floor(i / 36)]! << 16) | (LEVELS[Math.floor(i / 6) % 6]! << 8) | LEVELS[i % 6]!
  }
  return BASIC[n] ?? BASIC[7]!
}

export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (shift: number): number => {
    const x = (a >> shift) & 0xff
    return Math.round(x + (((b >> shift) & 0xff) - x) * k) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

// A grid of cells, row-major [codePoint, fg, bg] triplets.
export type Page = { columns: number; rows: number; cells: Uint32Array }

export function blankPage(columns: number, rows: number): Page {
  const cells = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) cells.set([0x20, GROUND, GROUND], i * 3)
  return { columns, rows, cells }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Cells as a Raster takes them: padded base64 of the little-endian words,
// by the runtime's own encoder where it has one.
export function encode(cells: Uint32Array): string {
  const bytes = new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength)
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (native) return native.call(bytes)
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out.push(B64[n >> 18]!, B64[(n >> 12) & 63]!, i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=', i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out.join('')
}

// Lay spans into one row from column `x`, clipped at `end`; a wide glyph
// paints as spaces (a Raster takes width-1 glyphs only), a control as one.
function put(page: Page, y: number, x: number, end: number, spans: readonly Span[], ink: number, bg?: number): number {
  for (const sp of spans) {
    const fg = mix(GROUND, xterm(sp.style?.color ?? INK.body), ink)
    const back = mix(GROUND, sp.style?.bg !== undefined ? xterm(sp.style.bg) : (bg ?? GROUND), ink)
    for (const ch of sp.text) {
      const cp = ch.codePointAt(0) ?? 0x20
      const w = cellsOf(cp)
      if (w === 0) continue
      const glyph = w === 1 && cp >= 0x20 && cp <= 0xffff && !(cp >= 0x7f && cp < 0xa0) ? cp : 0x20
      for (let k = 0; k < w; k++) {
        if (x >= end) return x
        if (x >= 0) page.cells.set([k === 0 ? glyph : 0x20, fg, back], (y * page.columns + x) * 3)
        x += 1
      }
    }
  }
  return x
}

// Where the column sits: its left edge and its measure, in pane columns.
export type Column = { left: number; measure: number }

// The body window as the Text drawing lays it: text rows from the column's
// left edge, code rows as a panel the measure wide (one cell of padding a
// side). `inks` dims a row toward the ground, 1 being full ink.
export function paintPage(window: readonly Line[], col: Column, columns: number, rows: number, inks: readonly number[]): Page {
  const page = blankPage(columns, rows)
  window.slice(0, rows).forEach((l, y) => {
    const ink = inks[y] ?? 1
    if (l.kind === 'text') {
      put(page, y, col.left, columns, l.spans, ink)
      return
    }
    const x0 = put(page, y, col.left, columns, l.prefix, ink)
    const width = Math.max(4, col.measure - spanCells(l.prefix))
    const end = Math.min(columns, x0 + width)
    const panel = xterm(INK.codeBg)
    put(page, y, x0, end, [{ text: ' '.repeat(width) }], ink, panel)
    if (!l.pad) put(page, y, x0 + 1, end - 1, [{ text: clip(l.text, width - 2), style: { color: INK.code } }], ink, panel)
  })
  return page
}

// The lamp: a half-cell line of light over the column, at `level` from the
// ground (0) to full tungsten (1). Its ends are cut square.
export function paintLamp(columns: number, col: Column, level: number): Uint32Array {
  const page = blankPage(columns, 1)
  const light = mix(GROUND, LAMP, level)
  for (let x = col.left; x < Math.min(columns, col.left + col.measure); x++) page.cells.set([0x2580, light, GROUND], x * 3)
  return page.cells
}

// What one row of the reply is, for the fore-edge.
export type Mark = 'blank' | 'text' | 'code' | 'head'
const RANK: Record<Mark, number> = { blank: 0, text: 1, code: 2, head: 3 }

export const markOf = (l: Line): Mark =>
  l.kind === 'code' ? 'code' : l.head !== undefined ? 'head' : l.spans.some(s => s.text.trim() !== '') ? 'text' : 'blank'

// The fore-edge: the whole reply mapped onto `rows` cells, each showing the
// strongest mark it covers. Prose is a thin rule, code a full block, a
// heading a bright tick; the rows in view sit under the lamp.
export function paintEdge(marks: readonly Mark[], rows: number, scroll: number, shown: number): Uint32Array {
  const page = blankPage(1, rows)
  const n = Math.max(1, marks.length)
  const at = (i: number): number => Math.floor((i * n) / rows)
  const lit0 = Math.floor((scroll * rows) / n)
  const lit1 = Math.max(lit0 + 1, Math.ceil(((scroll + shown) * rows) / n))
  for (let y = 0; y < rows; y++) {
    let mark: Mark = 'blank'
    for (let i = at(y); i < Math.max(at(y) + 1, at(y + 1)); i++) {
      const m = marks[i] ?? 'blank'
      if (RANK[m] > RANK[mark]) mark = m
    }
    const lit = y >= lit0 && y < lit1
    const base = { blank: GROUND, text: 0x585858, code: 0x4e4e4e, head: 0xc6c6c6 }[mark]
    const fg = lit ? mix(mark === 'blank' ? GROUND : base, LAMP, mark === 'blank' ? 0.34 : 0.62) : base
    page.cells.set([mark === 'code' ? 0x2588 : 0x2590, fg, GROUND], y * 3)
  }
  return page.cells
}
