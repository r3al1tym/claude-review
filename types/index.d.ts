export type ReviewTask = { content: string; status: string }

export type ReviewTurn = {
  question: string | null
  text: string | null
  plan: string | null
  // the plan still waits on the person's approval
  planWaiting: boolean
  ask: string | null
}

export type ReviewSnapshot = {
  turns: ReviewTurn[]
  tasks: ReviewTask[]
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

declare module 'claude-code' {
  interface PluginState {
    'review-pane': {
      snapshot: ReviewSnapshot
      view: ReviewView
      working: string[]
    }
  }
}
