// The pane's light, painted as Raster cells: the lamp over the text column,
// the fore-edge map, and the page itself whenever it has to move (the
// settle) or sit dimmed. A Raster paints colours at 12 bits, so the palette
// (INK) is 12-bit too, and a painted page lands on exactly what its Text
// drawing shows.

import { INK } from './markdown'
import type { Line } from './markdown'
import { cellsOf, clip, spanCells } from './text'
import type { Span } from './text'

export const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)

export const GROUND = rgb(INK.ground)
// The lamp dims as a tungsten filament does: full, it burns warm white;
// lower, it goes amber and then a brown ember, short of the red that reads
// as an error. Stops from 0 (dark) to 1 (full).
const FILAMENT = [0x221a14, 0x553311, 0x995522, 0xdd8833, 0xffbb66]

export function lampColour(level: number): number {
  const at = Math.max(0, Math.min(1, level)) * (FILAMENT.length - 1)
  const i = Math.min(FILAMENT.length - 2, Math.floor(at))
  return mix(FILAMENT[i]!, FILAMENT[i + 1]!, at - i)
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
    const fg = mix(GROUND, rgb(sp.style?.color ?? INK.body), ink)
    const back = mix(GROUND, sp.style?.bg !== undefined ? rgb(sp.style.bg) : (bg ?? GROUND), ink)
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
    const panel = rgb(INK.codeBg)
    put(page, y, x0, end, [{ text: ' '.repeat(width) }], ink, panel)
    if (!l.pad) put(page, y, x0 + 1, end - 1, [{ text: clip(l.text, width - 2), style: { color: INK.code } }], ink, panel)
  })
  return page
}

// The lamp: a line of light along the top edge of the column, cut square at
// the column's ends. A quarter of a cell tall, it swells to half a cell as
// it nears full, so waiting on you reads by its weight as well as its light.
//
// A 256-colour terminal has no ramp between ember and full, so there the
// lamp keeps three palette colours and breathes by its weight instead.
export function paintLamp(columns: number, col: Column, level: number, deep = true): Uint32Array {
  const page = blankPage(columns, 1)
  const full = Math.max(0, Math.min(1, (level - 0.86) / 0.14))
  const light = deep ? lampColour(level) : level < 0.6 ? 0x875f00 : level < 0.95 ? 0xd78700 : 0xffaf5f
  const eighths = deep || level >= 0.6
    ? Math.round(2 + 2 * full)
    : Math.round(1 + 2 * Math.max(0, Math.min(1, (level - 0.14) / 0.3)))
  // the top k eighths lit: the lower (8 - k) eighths block drawn in the ground
  const cell = eighths === 4 ? [0x2580, light, GROUND] : eighths === 1 ? [0x2594, light, GROUND] : [0x2581 + (7 - eighths), GROUND, light]
  for (let x = col.left; x < Math.min(columns, col.left + col.measure); x++) page.cells.set(cell, x * 3)
  return page.cells
}

// What one row of the reply is, for the fore-edge.
export type Mark = 'blank' | 'text' | 'code' | 'head'
const RANK: Record<Mark, number> = { blank: 0, text: 1, code: 2, head: 3 }

export const markOf = (l: Line): Mark =>
  l.kind === 'code' ? 'code' : l.head !== undefined ? 'head' : l.spans.some(s => s.text.trim() !== '') ? 'text' : 'blank'

// The fore-edge, two cells wide: the whole reply mapped onto `rows` cells,
// each showing the strongest mark it covers (prose a thin grey rule, code a
// full block, a heading a bright tick), and beside it a thin bar of lamp
// light along the rows in view.
export function paintEdge(marks: readonly Mark[], rows: number, scroll: number, shown: number): Uint32Array {
  const page = blankPage(2, rows)
  const n = Math.max(1, marks.length)
  const at = (i: number): number => Math.floor((i * n) / rows)
  const lit0 = Math.min(rows - 1, Math.floor((scroll * rows) / n))
  const lit1 = Math.max(lit0 + 1, Math.round(((scroll + shown) * rows) / n))
  const light = lampColour(0.86)
  for (let y = 0; y < rows; y++) {
    let mark: Mark = 'blank'
    for (let i = at(y); i < Math.max(at(y) + 1, at(y + 1)); i++) {
      const m = marks[i] ?? 'blank'
      if (RANK[m] > RANK[mark]) mark = m
    }
    const ink = { blank: GROUND, text: 0x555555, code: 0x444444, head: 0xcccccc }[mark]
    page.cells.set([mark === 'code' ? 0x2588 : 0x2590, ink, GROUND], y * 6)
    if (y >= lit0 && y < lit1) page.cells.set([0x258e, light, GROUND], y * 6 + 3)
  }
  return page.cells
}
