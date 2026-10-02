// The pane's light, painted as Raster cells: the lamp over the text column,
// the fore-edge map, and the page itself whenever it has to move (the
// settle) or sit dimmed. A Raster paints colours at 12 bits, so the palette
// (INK) is 12-bit too, and a painted page lands on exactly what its Text
// drawing shows.

import { INK } from './markdown'
import type { Line } from './markdown'
import type { Light } from './motion'
import { cellsOf, spanCells } from './text'
import type { Span } from './text'

export const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)

// A colour as Text takes it, snapped to 12 bits as a Raster paints it, so a
// dimmed Text page and its painted cells are the same colour.
export const hex = (n: number): string =>
  `#${[16, 8, 0].map(sh => (Math.round(((n >> sh) & 0xff) / 17) * 17).toString(16).padStart(2, '0')).join('')}`

// A colour at full depth, for a Text-only shade that falls between two
// 12-bit steps (a dimmed code panel).
export const exact = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

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

// A grid of cells, row-major [codePoint, fg, bg] triplets. `units` gives each
// row the first row of the form it belongs to (a code block's rows share one),
// so the form moves as a whole; `edge` counts the columns at the right that
// hold the fore-edge, which rise with their rows and take no time of their own;
// `column` is the text column, whose centre sits under the lamp's.
export type Page = { columns: number; rows: number; cells: Uint32Array; units?: number[]; edge?: number; column?: Column }

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
    // a dimmed page dims its ink and its code panels alike
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
  const page: Page = { ...blankPage(columns, rows), units: Array.from({ length: rows }, (_, y) => y), column: col }
  window.slice(0, rows).forEach((l, y) => {
    const prev = window[y - 1]
    if (l.kind === 'code' && prev?.kind === 'code' && prev.block === l.block) page.units![y] = page.units![y - 1]!
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
    if (!l.pad) put(page, y, x0 + 1, end - 1, l.spans, ink, panel)
  })
  return page
}

// The lamp: a line of light along the top edge of the column, cut square at
// its ends. Gathered, it is an ember EMBER cells long at the column's centre;
// open, it spans the column. A quarter of a cell tall, it swells to half a
// cell as it nears full, so waiting on you reads by its weight as well.
//
// A 256-colour terminal has no ramp between ember and full, so there the
// lamp keeps three palette colours and the ember breathes by its weight.
const EMBER = 10

export function paintLamp(columns: number, col: Column, light: Light, deep = true): Uint32Array {
  const page = blankPage(columns, 1)
  const { level } = light
  const full = Math.max(0, Math.min(1, (level - 0.86) / 0.14))
  const colour = deep ? lampColour(level) : level < 0.66 ? 0x875f00 : level < 0.95 ? 0xd78700 : 0xffaf5f
  const eighths = deep || level >= 0.66
    ? Math.round(2 + 2 * full)
    : Math.round(1 + 2 * Math.max(0, Math.min(1, (level - 0.3) / 0.3)))
  // the top k eighths lit: the lower (8 - k) eighths block drawn in the ground
  const cell = eighths === 4 ? [0x2580, colour, GROUND] : eighths === 1 ? [0x2594, colour, GROUND] : [0x2581 + (7 - eighths), GROUND, colour]
  const ember = Math.min(EMBER, col.measure)
  const lit = Math.round(ember + (col.measure - ember) * Math.max(0, Math.min(1, light.span)))
  const x0 = col.left + Math.floor((col.measure - lit) / 2)
  for (let x = x0; x < Math.min(columns, x0 + lit); x++) {
    // a filament: hottest at the centre, cooling along the filament curve to
    // the ends, each cell its own colour and nothing outside the line lit; an
    // ember is short enough to burn even, and the cooling grows as it opens
    const d = Math.abs(x + 0.5 - (x0 + lit / 2)) / Math.max(1, lit / 2)
    const c = deep ? lampColour(level * (1 - 0.42 * Math.max(0, Math.min(1, light.span)) * d * d)) : colour
    page.cells.set(cell[1] === GROUND ? [cell[0]!, GROUND, c] : [cell[0]!, c, GROUND], x * 3)
  }
  return page.cells
}

// The lamp's cells as Text spans at full colour depth. A Raster paints at 12
// bits, which shows as steps along the filament; a lamp that holds still is
// drawn as Text instead, so its light runs smooth from the centre to the ends.
export function lampSpans(cells: Uint32Array): Span[] {
  const out: Span[] = []
  for (let i = 0; i < cells.length; i += 3) {
    const style = { color: exact(cells[i + 1]!), bg: exact(cells[i + 2]!) }
    const last = out[out.length - 1]
    const ch = String.fromCodePoint(cells[i]!)
    if (last && last.style?.color === style.color && last.style.bg === style.bg) last.text += ch
    else out.push({ text: ch, style })
  }
  return out
}

// The fore-edge, a scrollbar a cell in from the pane's edge: a thin grey bar
// beside the rows in view, grey so the lamp stays the page's only light.
export function paintEdge(total: number, rows: number, scroll: number, shown: number): Uint32Array {
  const page = blankPage(2, rows)
  const n = Math.max(1, total)
  const lit0 = Math.min(rows - 1, Math.floor((scroll * rows) / n))
  const lit1 = Math.max(lit0 + 1, Math.round(((scroll + shown) * rows) / n))
  for (let y = lit0; y < Math.min(rows, lit1); y++) page.cells.set([0x258e, 0x666666, GROUND], y * 6 + 3)
  return page.cells
}
