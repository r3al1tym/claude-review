import type { SessionMessage } from 'claude-code'

import type { ReviewSnapshot, ReviewTask, ReviewTurn } from '../types'

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

// A prompt is a user row the person wrote: no tool results, and not a
// harness record (`<command-name>`, `<local-command-stdout>`), which the CLI
// skips by its leading `<`.
const promptText = (m: SessionMessage): string | null =>
  m.role === 'user' && !(m.toolResults?.length) && !m.text.trimStart().startsWith('<') ? str(m.text) : null

export function renderQuestion(input: Record<string, unknown>): string | null {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const blocks = questions.flatMap(q => {
    if (typeof q !== 'object' || q === null) return []
    const { header, question, options, multiSelect } = q as Record<string, unknown>
    if (!str(header) && !str(question)) return []
    const lines: string[] = []
    if (str(header)) lines.push(`### ${str(header)}`)
    if (str(question)) lines.push(str(question)!)
    for (const op of Array.isArray(options) ? options : []) {
      const { label, description } = (typeof op === 'object' && op !== null ? op : { label: op }) as Record<string, unknown>
      if (str(label) && str(description)) lines.push(`- **${str(label)}**: ${str(description)}`)
      else if (str(label)) lines.push(`- **${str(label)}**`)
    }
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

// A turn is a prompt and everything the assistant produced after it: its
// latest text, the plan it presented, and a question it still waits on.
export function buildSnapshot(messages: readonly SessionMessage[]): ReviewSnapshot {
  const turns: ReviewTurn[] = []
  let cur: ReviewTurn | null = null

  for (const m of messages) {
    const prompt = promptText(m)
    if (prompt !== null) {
      cur = { question: prompt, text: null, plan: null, planWaiting: false, ask: null }
      turns.push(cur)
      continue
    }
    if (m.role !== 'assistant') continue
    if (cur === null) {
      cur = { question: null, text: null, plan: null, planWaiting: false, ask: null }
      turns.push(cur)
    }
    if (m.text.trim() !== '') cur.text = m.text
    for (const use of m.toolUses) {
      if (use.tool === 'ExitPlanMode') {
        cur.plan = str(use.input.plan) ?? cur.plan
        cur.planWaiting = use.text === undefined
      }
      // shown while Claude is blocked on it; once answered the reply carries on
      if (use.tool === 'AskUserQuestion') cur.ask = use.text === undefined ? renderQuestion(use.input) : null
    }
  }

  return { turns, tasks: replayTasks(messages) }
}

// What the latest turn shows as a reply. It changes when a reply lands or
// grows, never when a tool runs, so "new reply" means one.
export function replySig(snap: ReviewSnapshot): string {
  const t = snap.turns[snap.turns.length - 1]
  return t ? JSON.stringify([snap.turns.length, t.text, t.plan, t.ask]) : ''
}

export const hasReply = (snap: ReviewSnapshot): boolean => {
  const t = snap.turns[snap.turns.length - 1]
  return Boolean(t && (t.text || t.plan || t.ask))
}
