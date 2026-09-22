# Backlog

Ideas not yet scheduled. Each item notes what's verified vs. assumed so the work
can start from evidence, not a cold read.

## A distinct "waiting for your input" state

**Shipped part (0.4.1).** The `question` surface: an `AskUserQuestion` turn is
parsed from its `tool_use` block and rendered (question, options, multi-select
hint) as a first-class surface that leads over stale prior text.

**Still open.** When the latest assistant block is a pending interactive
`tool_use` and the file is idle, the pane should say `⏸ waiting for your input`
instead of `(no response yet — Claude is working)`. Tool-permission prompts may
not emit a transcript record the way `AskUserQuestion` does — verify that case
before claiming it is covered. The pane stays read-only: it shows what is being
asked; the user answers in the real Claude Code pane.
