# Backlog

Ideas not yet scheduled. Each item notes what's verified vs. assumed so the work
can start from evidence, not a cold read.

## Surface interactive "waiting for input" turns

**Problem.** When a Claude Code turn ends by waiting on the user (an
`AskUserQuestion` prompt, or a tool-permission prompt), the review pane often
shows nothing useful — and if the turn had no lead-in prose, it falls through to
`(no response yet — Claude is working)`. That's misleading: Claude isn't working,
it's blocked on the user.

**Root cause (verified, not a flush/JSONL limitation).** The assistant message
carrying the question is written and flushed to the transcript *before* the user
answers (Claude Code needs it on disk to render the prompt UI), so the data is
fully readable. The gap is in `parse_turn`: it only reconstructs three surfaces —
`response` text, `plan` (`ExitPlanMode`), and `tasks` (`Task*`). It never parses
the `AskUserQuestion` `tool_use` block. The question text + options live in that
block's `input` (`questions[].question`, `questions[].options[].label`) — present
on disk, just unsurfaced. Confirmed against a real transcript: an
`AskUserQuestion` turn is `thinking → [text?] → tool_use`, and when the text block
is absent the pane shows the false "working" state.

**Proposed fix (mirrors the format-drift banner).**
1. Add an `ask` surface: parse the `AskUserQuestion` block and render the
   question(s) + options, so the side pane shows *what's being asked*.
2. Add a distinct waiting state: when the latest assistant block is a pending
   interactive `tool_use` and the file is idle, show `⏸ waiting for your input`
   instead of "Claude is working".
3. Tests for both, ship as a minor release.

**Caveats to resolve during implementation.**
- The pane stays read-only by design — it renders the question; the user still
  answers in the real Claude Code pane.
- Tool-permission prompts may not emit a transcript record the same way
  `AskUserQuestion` does — verify that case before claiming it's covered.
