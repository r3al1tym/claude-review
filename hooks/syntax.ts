// Code set in the page's grey ramp, the way a book sets a program: keywords
// in bold at the full ink, strings a step down, comments in the quiet grey
// and italic, everything else the body grey. Shade and weight do the work a
// highlighter spends colour on, so the lamp stays the one colour on the page.

import type { Span, Style } from './text'

// the four styles code is set in; the palette (INK) gives them their greys
export type Ramp = { plain: Style; keyword: Style; string: Style; comment: Style }

const words = (s: string): ReadonlySet<string> => new Set(s.split(' '))

const C_LIKE = 'if else for while do switch case default break continue return goto new delete this true false null void static const'
const JS = words(`${C_LIKE} let var function class extends implements interface type enum export import from as async await yield try catch finally throw typeof instanceof in of undefined super public private protected readonly abstract declare namespace keyof satisfies get set`)
const PY = words('def class return if elif else for while in not and or is None True False import from as with try except finally raise pass break continue lambda yield async await global nonlocal assert del match case self')
const RUST = words('fn let mut const static struct enum trait impl pub use mod crate self Self super match if else loop while for in return break continue move ref as where type unsafe async await dyn true false Some None Ok Err')
const GO = words('func package import var const type struct interface map chan go defer select switch case default if else for range return break continue fallthrough goto nil true false')
const SH = words('if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit')
const SQL = words('select from where join left right inner outer on group by order having limit offset insert into values update set delete create table alter drop index as and or not null is in like distinct union all case when then else end')
const C = words(`${C_LIKE} int char long short float double unsigned signed struct union enum typedef sizeof extern auto register inline bool class public private protected virtual template typename namespace using try catch throw nullptr`)

export type Lang = { keywords: ReadonlySet<string>; line: readonly string[]; block: boolean; triple: boolean; fold: boolean }

const LANGS: readonly [RegExp, Lang][] = [
  [/^(js|jsx|ts|tsx|javascript|typescript|mjs|cjs|json5?)$/, { keywords: JS, line: ['//'], block: true, triple: false, fold: false }],
  [/^(py|python|python3)$/, { keywords: PY, line: ['#'], block: false, triple: true, fold: false }],
  [/^(rs|rust)$/, { keywords: RUST, line: ['//'], block: true, triple: false, fold: false }],
  [/^(go|golang)$/, { keywords: GO, line: ['//'], block: true, triple: false, fold: false }],
  [/^(sh|bash|zsh|shell|console|fish)$/, { keywords: SH, line: ['#'], block: false, triple: false, fold: false }],
  [/^(sql|psql|mysql|sqlite)$/, { keywords: SQL, line: ['--'], block: true, triple: false, fold: true }],
  [/^(c|h|cpp|cc|cxx|hpp|c\+\+|cs|csharp|java|kotlin|kt|swift|scala|php|dart)$/, { keywords: C, line: ['//'], block: true, triple: false, fold: false }],
  [/^(yaml|yml|toml|ini|conf|dockerfile|make|makefile|r|rb|ruby|perl)$/, { keywords: words(''), line: ['#'], block: false, triple: false, fold: false }],
  [/^(css|scss|less)$/, { keywords: words(''), line: [], block: true, triple: false, fold: false }],
]

export const langOf = (language: string): Lang | null => LANGS.find(([re]) => re.test(language.toLowerCase()))?.[1] ?? null

// One block's lines as styled spans. A block comment, a triple-quoted string
// or a template literal carries from line to line; a quote with no partner
// on its line is a plain mark (a Rust lifetime, an apostrophe in a word).
export function highlight(lines: readonly string[], language: string, ink: Ramp): Span[][] {
  const { plain: PLAIN, keyword: KEYWORD, string: STRING, comment: COMMENT } = ink
  const lang = langOf(language)
  if (!lang) return lines.map(l => [{ text: l, style: PLAIN }])
  let open: { end: string; style: Style } | null = null
  return lines.map(line => {
    const out: Span[] = []
    const push = (text: string, style: Style): void => {
      const last = out[out.length - 1]
      if (text === '') return
      if (last && last.style === style) last.text += text
      else out.push({ text, style })
    }
    for (let i = 0; i < line.length;) {
      const rest = line.slice(i)
      if (open) {
        const at = line.indexOf(open.end, i)
        const stop = at < 0 ? line.length : at + open.end.length
        push(line.slice(i, stop), open.style)
        if (at >= 0) open = null
        i = stop
        continue
      }
      if (lang.line.some(m => rest.startsWith(m))) {
        push(rest, COMMENT)
        break
      }
      const opener = lang.block && rest.startsWith('/*') ? '/*' : lang.triple && /^("""|''')/.test(rest) ? rest.slice(0, 3) : null
      if (opener) {
        open = { end: opener === '/*' ? '*/' : opener, style: opener === '/*' ? COMMENT : STRING }
        push(opener, open.style)
        i += opener.length
        continue
      }
      const ch = line[i]!
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
        // in Rust a quote opens a char only when it closes within a few cells; else it marks a lifetime
        if (j < line.length && !(ch === "'" && lang.keywords === RUST && j - i > 3)) {
          push(line.slice(i, j + 1), STRING)
          i = j + 1
          continue
        }
        if (ch === '`' && lang.keywords === JS) {
          open = { end: '`', style: STRING }
          push(ch, STRING)
          i += 1
          continue
        }
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0]
      if (word) {
        push(word, lang.keywords.has(lang.fold ? word.toLowerCase() : word) ? KEYWORD : PLAIN)
        i += word.length
        continue
      }
      push(ch, PLAIN)
      i += 1
    }
    return out
  })
}
