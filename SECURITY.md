# Security

`claude-review` is a local, read-only viewer. At runtime it opens Claude Code
transcript files under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`)
in read mode only — it writes no files, runs no subprocesses, and makes no
network connections. It's a single Python file with one dependency (`rich`), so
you can read the whole thing before you run it.

## Threat model

A transcript can contain arbitrary text that Claude quoted from elsewhere —
web-fetch output, file contents, tool results, pasted input. `claude-review`
treats all transcript-derived text as untrusted and strips terminal
control/escape bytes before rendering it, so viewing a session can't drive your
terminal or rewrite your clipboard through smuggled escape sequences.

The clipboard copy (`y`) uses an OSC 52 escape sequence written to your own
terminal's stdout — it spawns no process and touches no network. It only fires
when you press `y`.

## Reporting a vulnerability

If you find a security issue — especially anything that lets a crafted
transcript affect the terminal, the clipboard, or the filesystem beyond
read-only transcript access — please report it privately first:

- Open a [GitHub security advisory](https://github.com/r3al1tym/claude-review/security/advisories/new)
  (preferred), or
- open a regular issue **without** exploit details and ask for a private channel.

Please don't file a public issue with a working exploit before there's a fix.
A single-file tool means fixes ship fast; expect an initial response within a
few days.
