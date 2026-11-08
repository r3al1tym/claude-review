import type { PromptOrigin, SessionMessage } from 'claude-code'

import type { ReviewPart, ReviewPrompt, ReviewSnapshot, ReviewTask, ReviewTurn } from '../types'
import { oneline } from './text'

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

// ---------------------------------------------------------------- who sent it

type Source = Pick<ReviewPrompt, 'from' | 'name' | 'continues'>

// The person's own prompts: typed, from the phone or the SDK host, a Slack
// ping or channel of theirs, the follow-up to something they chose, and a
// plugin's submission made as their words. Everything else is background.
const PERSON: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping', 'channel', 'auto-continuation'])

export function sourceOf(origin: PromptOrigin): Source {
  if (origin.kind === 'auto-continuation') return { from: 'person', continues: true }
  if (PERSON.has(origin.kind)) return { from: 'person' }
  switch (origin.kind) {
    case 'plugin': return origin.asUser ? { from: 'person' } : { from: 'plugin', name: origin.name }
    case 'task-notification': return { from: 'task' }
    case 'scheduled-trigger': return { from: 'schedule' }
    case 'peer': case 'peer-send-message': case 'projects-relay': case 'coordinator': return { from: 'session' }
    case 'observer': case 'observer-activity': return { from: 'observer' }
    default: return { from: 'other' }
  }
}

// A row no record speaks for (history from before the pane saw it) is read by
// its words, and only the engine's own shapes count: a slash command's or a
// shell escape's record is neither the person's nor background, as the CLI
// skipped it; a task notification and another session's message or notice are
// background. Any other text is the person's, bracketed or not (`[Image #1]`,
// pasted markup).
function guess(text: string): Source | 'neither' {
  const t = text.trimStart()
  if (/^<(command-|local-command-|bash-)/.test(t)) return 'neither'
  if (t.startsWith('<task-notification>')) return { from: 'task' }
  if (/^(<cross-session-message[\s>]|\[Cross-session [a-z ]+\])/.test(t)) return { from: 'session' }
  return { from: 'person' }
}

const LABEL: Record<Exclude<ReviewPrompt['from'], 'person' | 'plugin'>, string> = {
  task: 'after a task notification',
  schedule: 'after a scheduled prompt',
  session: 'after a message from another session',
  observer: 'after an observer report',
  other: 'after a background message',
}

// The quiet line over a background turn's reply, naming what set it off.
export const labelOf = (s: Source): string =>
  s.from === 'plugin' ? `after a message from ${s.name ? `the ${oneline(s.name)} mod` : 'a mod'}` : s.from === 'person' ? '' : LABEL[s.from]

// A prompt's opening, the key its record is matched to its row by.
export const promptKey = (text: string): string => text.trim().slice(0, 240)

// ---------------------------------------------------------------- where it landed

// A row's print, the same read from `session.append` or `$.session.messages()`
// (which reads one message per stored row, its text blocks joined with
// nothing between them): its role, its tool ids, its text's length and a hash
// of the text. A row the conversation hides (a scheduled prompt, a prompt
// folded into a running turn) is placed after the print of the last row the
// pane can read before it. Null for a row with neither text nor tools, which
// nothing is placed after. The stub, everything but the hash, is what a row is
// checked against before its text is hashed.
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

const stubOf = (role: string, text: string, ids: readonly string[]): string | null =>
  text === '' && ids.length === 0 ? null : `${role}|${ids.join(',')}|${text.length}|`

const printOf = (role: string, text: string, ids: readonly string[]): string | null => {
  const stub = stubOf(role, text, ids)
  return stub === null ? null : stub + hash(text)
}

const idsOf = (m: SessionMessage): string[] =>
  m.role === 'assistant' ? m.toolUses.map(u => u.tool_use_id) : (m.toolResults ?? []).map(r => r.tool_use_id)

export const messagePrint = (m: SessionMessage): string | null => printOf(m.role, m.text, idsOf(m))

// what a hidden row is placed after when nothing readable came before it
export const START = '^'

type Block = { type: string; [field: string]: unknown }

export const blocksText = (content: readonly Block[]): string =>
  content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('')

export function blocksPrint(role: 'user' | 'assistant', content: readonly Block[]): string | null {
  const ids = content.flatMap(b => {
    const id = role === 'assistant' ? (b.type === 'tool_use' ? b.id : undefined) : (b.type === 'tool_result' ? b.tool_use_id : undefined)
    return typeof id === 'string' ? [id] : []
  })
  return printOf(role, blocksText(content), ids)
}

// ---------------------------------------------------------------- surfaces

export function renderQuestion(input: Record<string, unknown>): string | null {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const blocks = questions.flatMap(q => {
    if (typeof q !== 'object' || q === null) return []
    const { header, question, options, multiSelect } = q as Record<string, unknown>
    if (!str(header) && !str(question)) return []
    // the question is its own heading; the header is the short label Claude
    // Code puts on a tab, and stands in only when there is no question
    const lines = [`### ${str(question) ?? str(header)}`]
    // numbered as Claude Code numbers them, so an option here is the key there
    const list = (Array.isArray(options) ? options : []).map(op => (typeof op === 'object' && op !== null ? op : { label: op }) as Record<string, unknown>)
    list.filter(op => str(op.label)).forEach((op, n) => {
      lines.push(str(op.description) ? `${n + 1}. **${str(op.label)}**: ${str(op.description)}` : `${n + 1}. **${str(op.label)}**`)
    })
    if (multiSelect === true) lines.push('_(select all that apply)_')
    return [lines.join('\n\n')]
  })

  return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null
}

// Replays TaskCreate / TaskUpdate over the whole session (ids count from the
// first create, as Claude Code numbers them); TodoWrite's list stands in when
// the session used that instead.
function replayTasks(messages: readonly SessionMessage[]): ReviewTask[] {
  const tasks = new Map<number, ReviewTask>()
  let seq = 0
  let todos: ReviewTask[] | null = null

  for (const use of messages.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))) {
    const input = use.input
    if (use.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      todos = input.todos.flatMap(t => {
        const { content, status } = (t ?? {}) as Record<string, unknown>
        return str(content) ? [{ content: str(content)!, status: str(status) ?? 'pending' }] : []
      })
    } else if (use.tool === 'TaskCreate') {
      if ('subagent_type' in input) continue
      const subject = str(input.subject) ?? str(input.content)
      if (subject) tasks.set(++seq, { content: subject, status: 'pending' })
    } else if (use.tool === 'TaskUpdate') {
      const id = Number(input.taskId)
      const task = tasks.get(id)
      if (!task) continue
      if (input.status === 'deleted') tasks.delete(id)
      else tasks.set(id, { content: str(input.subject) ?? task.content, status: str(input.status) ?? task.status })
    }
  }

  return tasks.size > 0 ? [...tasks.values()] : (todos ?? [])
}

// The plan an assistant row presented, and a question it still waits on.
function noteTools(turn: ReviewTurn, m: SessionMessage): void {
  for (const use of m.toolUses) {
    if (use.tool === 'ExitPlanMode') {
      turn.plan = str(use.input.plan) ?? turn.plan
      turn.planWaiting = use.text === undefined
    }
    // shown while Claude is blocked on it; once answered the reply carries on
    if (use.tool === 'AskUserQuestion') turn.ask = use.text === undefined ? renderQuestion(use.input) : null
  }
}

// ---------------------------------------------------------------- exchanges

const isPromptRow = (m: SessionMessage): boolean => m.role === 'user' && !(m.toolResults?.length) && m.text.trim() !== ''

const newTurn = (question: string | null): ReviewTurn =>
  ({ question, parts: [{ cue: null, texts: [] }], sig: '', plan: null, planWaiting: false, ask: null })

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

// Each prompt the conversation hides, at the row it landed after (-1: before
// every row), placed from the newest back so a print seen twice takes the
// later row. Only rows whose stub a record names have their text hashed.
function placeHidden(messages: readonly SessionMessage[], prompts: readonly ReviewPrompt[]): Map<number, ReviewPrompt[]> {
  const placed = new Map<number, ReviewPrompt[]>()
  const hidden = prompts.filter(p => p.after)
  if (hidden.length === 0) return placed
  const stubs = new Set(hidden.map(p => p.after!.slice(0, p.after!.lastIndexOf('|') + 1)))
  const rowsByPrint = new Map<string, number[]>()
  messages.forEach((m, i) => {
    const stub = stubOf(m.role, m.text, idsOf(m))
    if (stub !== null && stubs.has(stub)) push(rowsByPrint, stub + hash(m.text), i)
  })
  let cursor = messages.length - 1
  for (let n = hidden.length - 1; n >= 0; n--) {
    const p = hidden[n]!
    const i = p.after === START ? -1 : rowsByPrint.get(p.after!)?.findLast(r => r <= cursor)
    if (i === undefined) continue
    cursor = i
    placed.set(i, [p, ...(placed.get(i) ?? [])])
  }
  return placed
}

// An exchange begins at a prompt the person sent, readable or hidden, and
// keeps every text the assistant wrote until the next one. A prompt of theirs
// folded into their running turn joins the exchange where it arrived; one that
// ran as its own turn begins the next. A background turn after it (a schedule,
// a notification, another session) adds its reply under a quiet label, and one
// with no text adds nothing. The rows before the first exchange read as they
// always did, a turn at each plain-text prompt (byPrompt).
function exchanges(messages: readonly SessionMessage[], prompts: readonly ReviewPrompt[]): { lead: number; turns: ReviewTurn[] } {
  // each readable prompt row's record, by its opening, newest row to newest record
  const byKey = new Map<string, ReviewPrompt[]>()
  for (const p of prompts) if (p.landed && p.after === undefined) push(byKey, p.text, p)
  const rowSource = new Map<number, ReviewPrompt>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const p = isPromptRow(m) ? byKey.get(promptKey(m.text))?.pop() : undefined
    if (p) rowSource.set(i, p)
  }
  const hiddenAfter = placeHidden(messages, prompts)

  const out: ReviewTurn[] = []
  // the first row of the first exchange; the exchange, the stretch of it texts
  // go to, and whose turn is running
  const at: { lead: number; turn: ReviewTurn | null; part: ReviewPart | null; owner: 'person' | 'background' | null } =
    { lead: messages.length, turn: null, part: null, owner: null }
  const person = (text: string, folded: boolean, row: number): void => {
    if (folded && at.owner === 'person' && at.turn) {
      at.part = { cue: { kind: 'prompt', text }, texts: [] }
      at.turn.parts.push(at.part)
    } else {
      if (!at.turn) at.lead = row
      at.turn = newTurn(text)
      at.part = at.turn.parts[0]!
      out.push(at.turn)
    }
    at.owner = 'person'
  }
  const background = (source: Source): void => {
    at.owner = 'background'
    at.part = at.turn ? { cue: { kind: 'background', text: labelOf(source) }, texts: [] } : null
    if (at.part) at.turn!.parts.push(at.part)
  }
  // a prompt the pane cannot read, after row `i`: the person's begins an
  // exchange when it began a turn, unless it is the engine carrying on the
  // one in progress, and folded into a running turn joins it; a background
  // one counts only when it began a turn
  const hiddenAt = (i: number): void => {
    for (const p of hiddenAfter.get(i) ?? []) {
      if (p.from === 'person') {
        if (!(p.starts && p.continues)) person(p.text, !p.starts, i + 1)
      } else if (p.starts) background(p)
    }
  }

  hiddenAt(-1)
  messages.forEach((m, i) => {
    if (isPromptRow(m)) {
      const source = rowSource.get(i) ?? guess(m.text)
      if (source !== 'neither') {
        if (source.from === 'person') person(m.text.trim(), false, i)
        else background(source)
      }
    } else if (m.role === 'assistant') {
      if (m.text.trim() !== '') at.part?.texts.push(m.text)
      if (at.turn) noteTools(at.turn, m)
    }
    hiddenAt(i)
  })

  for (const t of out) t.parts = t.parts.filter(pt => pt.cue?.kind !== 'background' || pt.texts.length > 0)
  return { lead: at.lead, turns: out }
}

// The rows before the person's first prompt (all of them, in a session with
// none) read as the CLI read them: a turn at each plain-text prompt, whatever
// sent it, and one for replies that open the window with no prompt above them.
function byPrompt(messages: readonly SessionMessage[]): ReviewTurn[] {
  const out: ReviewTurn[] = []
  let cur: ReviewTurn | null = null
  for (const m of messages) {
    if (isPromptRow(m) && !m.text.trimStart().startsWith('<')) {
      cur = newTurn(m.text.trim())
      out.push(cur)
      continue
    }
    if (m.role !== 'assistant') continue
    if (cur === null) {
      cur = newTurn(null)
      out.push(cur)
    }
    if (m.text.trim() !== '') cur.parts[0]!.texts.push(m.text)
    noteTools(cur, m)
  }
  return out
}

// What a turn's parts hold, cheaply, with its place in the session: every
// cue, and each text by its length and its two ends. A text is a whole row
// and a turn only gathers more of them, so any reply that lands or grows
// changes it, and no read of a text's middle is needed.
const sigOf = (t: ReviewTurn, n: number): string =>
  hash(JSON.stringify([n, t.question, t.parts.map(p => [p.cue, p.texts.map(x => [x.length, x.slice(0, 48), x.slice(-48)])])]))

export function buildSnapshot(messages: readonly SessionMessage[], prompts: readonly ReviewPrompt[] = []): ReviewSnapshot {
  const { lead, turns } = exchanges(messages, prompts)
  const all = [...byPrompt(messages.slice(0, lead)), ...turns]
  all.forEach((t, n) => (t.sig = sigOf(t, n)))
  return { turns: all, tasks: replayTasks(messages) }
}

// ---------------------------------------------------------------- replies

export const hasText = (t: ReviewTurn): boolean => t.parts.some(p => p.texts.length > 0)
export const isBlank = (t: ReviewTurn): boolean => !hasText(t) && !t.plan && !t.ask

// The reply as Markdown, for a surface that draws its own and for the copy:
// each later prompt of the person's where it arrived, each background label
// over the reply it introduces.
export function replyMarkdown(t: ReviewTurn): string {
  return t.parts.flatMap(p => {
    const body = p.texts.join('\n\n')
    const cue = !p.cue ? [] : p.cue.kind === 'prompt' ? [`› ${oneline(p.cue.text)}`] : [`*${p.cue.text}*`]
    return [...cue, ...(body ? [body] : [])]
  }).join('\n\n')
}

// The latest reply: the last exchange that has one, so a new prompt with no
// reply yet leaves it where it was. It changes when any reply in it lands or
// grows, never when a tool runs or a prompt is sent, so "new reply" means one.
export function replySig(snap: ReviewSnapshot): string {
  const at = snap.turns.findLastIndex(t => !isBlank(t))
  const t = snap.turns[at]
  return t ? `${at + 1}:${t.sig}:${hash(JSON.stringify([t.plan, t.ask]))}` : ''
}

export const hasReply = (snap: ReviewSnapshot): boolean => {
  const t = snap.turns[snap.turns.length - 1]
  return Boolean(t && !isBlank(t))
}
