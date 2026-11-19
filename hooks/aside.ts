// Side questions: a question about the turn on screen, answered by a fork of
// the session ($.model.fork) beside the main thread, which never sees it and
// keeps working. The fork has the session's transcript and no tools; the
// prompt quotes what the person is looking at, so the answer holds after a
// compaction has dropped that turn from the session's context.

import type { ReviewAnchor, ReviewAsk, ReviewTurn } from '../types'

// The passage quoted to the fork, at most: about a pane of prose.
export const PASSAGE_MAX = 4000

export const asideKey = (turn: number, prompt: string | null): string => `${turn}\u0000${prompt ?? ''}`

// The asks about this turn, in the order asked.
export const asksFor = (asks: readonly ReviewAsk[], turn: number, at: ReviewTurn): ReviewAsk[] =>
  asks.filter(a => asideKey(a.anchor.turn, a.anchor.prompt) === asideKey(turn, at.question))

const fence = (text: string): string => text.replace(/^>>>|^<<</gm, m => ` ${m}`)

export function asidePrompt(anchor: ReviewAnchor, earlier: readonly ReviewAsk[], question: string, turnCount: number): string {
  const lines = [
    'A side question from the review pane. The user is reading an earlier part of this conversation in a pane beside it while your main work carries on in its own turn, which this reply never reaches.',
    'Answer only this question, in Markdown, in a few short paragraphs at most. Do not continue the main task or say what you will do next. You have no tools here: when an answer needs a file read, a command or a change, say so in one line, and the user can send the question to the main session.',
    '',
    `Turn ${anchor.turn + 1} of ${turnCount}${anchor.prompt ? `, which answered the prompt: "${anchor.prompt.replace(/\s+/g, ' ').slice(0, 400)}"` : ''}.`,
    `The ${anchor.surface} surface${anchor.section ? `, section "${anchor.section}"` : ''}. What the user sees:`,
    '<<<',
    fence(anchor.passage.slice(0, PASSAGE_MAX)),
    '>>>',
  ]
  const answered = earlier.filter(a => a.answer !== null)
  if (answered.length > 0) {
    lines.push('', 'Side questions already asked about this turn:')
    for (const a of answered) lines.push(`Q: ${a.question}`, `A: ${a.answer}`)
  }
  lines.push('', `Question: ${question}`)
  return lines.join('\n')
}

// The prompt `s` sends to the main session: the question and what it is about.
export function sessionPrompt(ask: ReviewAsk): string {
  const at = ask.anchor
  const excerpt = at.passage.replace(/\s+/g, ' ').trim().slice(0, 300)
  const where = `turn ${at.turn + 1}${at.section ? `, section "${at.section}"` : ''}`
  return `${ask.question}\n\n(Asked from the review pane about ${where}: "${excerpt}${at.passage.length > 300 ? '…' : ''}")`
}

// The aside as Markdown, for copying and for surfaces that draw Markdown.
export function asideMarkdown(asks: readonly ReviewAsk[]): string {
  return asks.map(a => {
    const head = `> ${a.question.replace(/\n/g, ' ')}${a.anchor.section ? `\n>\n> _${a.anchor.section}_` : ''}`
    const body = a.answer ?? (a.failed ? `_No answer: ${a.failed}._` : '_Answering…_')
    return `${head}\n\n${body}`
  }).join('\n\n---\n\n')
}
