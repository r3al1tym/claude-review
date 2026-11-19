export type ReviewTask = { content: string; status: string }

// What set off a stretch of an exchange's reply after its own prompt: a later
// prompt of the person's that joined the exchange, or a background trigger
// (a schedule, a notification, another session), named in plain words.
export type ReviewCue = { kind: 'prompt' | 'background'; text: string }

// One stretch of an exchange's reply: every text block the assistant wrote in
// it, in order, intermediate ones included.
export type ReviewPart = { cue: ReviewCue | null; texts: string[] }

// An exchange: a prompt the person sent and everything the assistant
// produced until the next one, background turns included.
export type ReviewTurn = {
  question: string | null
  parts: ReviewPart[]
  // what the parts hold, cheaply: changes when any reply lands or grows
  sig: string
  plan: string | null
  // the plan still waits on the person's approval
  planWaiting: boolean
  ask: string | null
}

export type ReviewSnapshot = {
  turns: ReviewTurn[]
  tasks: ReviewTask[]
}

// Where a prompt came from, as `prompt.submit` stamped it, kept in the
// plugin's store per session so a resumed session still knows. `text` is the
// prompt's opening, the key it is matched to its row by.
export type ReviewPrompt = {
  text: string
  // the person, or the background kind that sent it
  from: 'person' | 'task' | 'schedule' | 'session' | 'observer' | 'plugin' | 'other'
  // the plugin that sent it, for `plugin`
  name?: string
  // the engine's follow-up to something the person chose, which carries on
  // the exchange in progress (`auto-continuation`)
  continues?: true
  // typed (or delivered) while a turn was running; only a prompt folded into
  // that turn joins its exchange, which its row decides
  during?: true
  // its row is in the conversation as written
  landed?: true
  // its row is one the conversation hides (a scheduled prompt, a prompt
  // folded into a running turn): it landed right after the row with this
  // print, or before every row (`^`)
  after?: string
  // that hidden row began a turn of its own
  starts?: true
}

// What the pane shows, as the CLI's review loop keeps it: the turn on screen
// (null follows the live one), whether it is frozen and what it froze, the
// surface and scroll, the reply it last caught up to, the guide, a flash.
export type ReviewView = {
  index: number | null
  frozen: boolean
  held: ReviewTurn | null
  surface: number
  scroll: number
  seen: string
  help: boolean
  flash: string | null
}

// What a side question is about: the turn on screen when you pressed a, the
// section and the rows in view then, so the answer holds after a compaction
// drops that turn from the session's context.
export type ReviewAnchor = {
  turn: number
  prompt: string | null
  surface: string
  section: string | null
  passage: string
}

// One side question and its answer, null while the fork runs; `failed` says
// why there is none.
export type ReviewAsk = { at: number; anchor: ReviewAnchor; question: string; answer: string | null; failed?: string }

// Side questions, answered by a fork of the session beside the main thread:
// the anchor while you type one, and every one asked this load.
export type ReviewAside = { asking: ReviewAnchor | null; asks: ReviewAsk[] }

declare module 'claude-code' {
  interface PluginState {
    'review-pane': {
      snapshot: Shaped<ReviewSnapshot>
      view: Shaped<ReviewView>
      working: string[]
      aside: ReviewAside
    }
  }
}
