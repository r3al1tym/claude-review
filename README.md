# claude-review

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.9%2B-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20WSL-lightgrey.svg)

> **Faster than HTML. Calmer than the terminal.**

A read-only review pane for a single [Claude Code](https://claude.com/claude-code) session. It pins to one session and shows only its **latest response** — rendered as markdown, refreshed in place — so you can read and make decisions in a calm second pane while you drive Claude Code in the first.

![claude-review in a split terminal: Claude Code on the left, the latest response pinned and rendered on the right](docs/demo.gif)

## Features

- **One session, pinned.** Pick the session you care about; the view never drifts to another.
- **Latest response only.** The current answer, rendered as clean markdown — re-anchored to the top each turn, never a scrolling log.
- **Surfaces.** `Tab` cycles `response`, `plan` (from plan mode), and `tasks` (the live task list) for the current turn.
- **Freeze.** Press `f` to hold the view while Claude keeps working; a marker shows when newer content is waiting.
- **Quiet chrome.** No header. A two-line muted footer carries state, session id, scroll position, and keys — nothing competes with the response.
- **Read-only and offline.** It only reads transcript files. No writes, no network, no telemetry. Sole dependency: [`rich`](https://github.com/Textualize/rich).

> Claude Code also has a built-in [`/focus`](https://code.claude.com/docs/en/interactive-mode) command that declutters the live session in place. `claude-review` is the complement — a dedicated, scrollable reading pane alongside it.

## Install

### As a Claude Code skill (recommended)

Install the bundled skill with the [`skills`](https://github.com/vercel-labs/skills) CLI — it detects your agent(s) and places the skill correctly (`~/.claude/skills/` for Claude Code, plus Cursor, Codex, and others):

```bash
npx skills add r3al1tym/claude-review -g
```

Then just ask Claude *"open a review pane for this session"* — it resolves the session, installs the `claude-review` CLI if needed, and hands you the command to run in your other pane. Drop `-g` to install into the current project instead; manage with `npx skills update | ls | rm`.

### As a CLI

```bash
pipx install git+https://github.com/r3al1tym/claude-review
```

Requires Python 3.9+ and a POSIX terminal (Linux, macOS, WSL).

> On modern distros a bare `pip install --user` may fail with `externally-managed-environment` (PEP 668) — use `pipx`, a virtualenv, or `--break-system-packages`. Not yet on PyPI.

## Usage

```bash
claude-review                 # pick a session interactively, then review it
claude-review -s <id-prefix>  # attach directly to a session id (prefix is fine)
claude-review -p <slug>       # review a different project (see below)
claude-review -l              # list recent sessions and exit
claude-review -V              # print version
claude-review -h              # help
```

Run Claude Code in one pane and `claude-review` in the other; the review pane updates to the latest response as Claude works.

To try the UI without a live session, a sample transcript ships in the repo:

```bash
claude-review -p "$PWD/examples"   # from a clone
```

### Keys

| Key | Action |
|-----|--------|
| `f` | freeze / unfreeze auto-update |
| `Tab` | cycle surfaces (response / plan / tasks) |
| `↑` `↓` or `j` `k` | scroll one line |
| `space` / `b` | scroll one page |
| `g` / `G` | jump to top / bottom |
| `s` | switch session (back to the picker) |
| `r` | refresh now (also unfreezes) |
| `q` | quit |

### Project slug

Claude Code stores transcripts under `~/.claude/projects/<slug>`, where `<slug>` is the project's absolute path with path punctuation collapsed to `-` — every `/`, `\` (Windows), drive `:`, `.`, and space becomes `-` (e.g. `/home/you/my.app` → `-home-you-my-app`, `C:\Users\you\repo` → `C--Users-you-repo`).

Without `-p`, `claude-review` derives the project from your current directory: it forward-encodes the cwd, and if that misses, falls back to finding the project whose transcripts record a matching `cwd` — so a dotted or spaced path still resolves. Pass `-p` to review a project you're not `cd`'d into; it accepts either a `<slug>` or an absolute project path. If your `~/.claude` lives elsewhere, set `CLAUDE_CONFIG_DIR`.

This slug encoding is undocumented and reverse-engineered, so if one ever mismatches, the surest fix is `ls ~/.claude/projects/` and pass the literal directory name with `-p`.

## How it works

`claude-review` tails the session's JSONL transcript and reconstructs the current turn — the latest user prompt and everything the assistant produced after it. It extracts the response text, any `ExitPlanMode` plan, and the task list (from `TaskCreate`/`TaskUpdate` events), re-reading only when the file changes and jumping to the top on each fresh turn.

## Limitations

- **Terminal-driven.** Needs an interactive TTY; it's a viewer, not a pipe.
- **Plan surface is best-effort.** Depends on Claude Code emitting `ExitPlanMode` events; without plan mode you'll see `response` (and `tasks`, when present).
- **No horizontal scroll.** Very wide tables are wrapped to fit, not scrolled sideways.
- **Transcript format.** Parses Claude Code's current JSONL layout; a future format change may need a parser update — issues/PRs welcome.

## License

[MIT](LICENSE) © r3al1tym

The JetBrains Mono font files bundled under `demo/` (used only to render the README GIF) are licensed separately under the [SIL Open Font License 1.1](demo/OFL.txt) — they are not part of the installed package.
