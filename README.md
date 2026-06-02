# claude-review

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.9%2B-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20WSL-lightgrey.svg)

A focused **review surface** for a single [Claude Code](https://claude.com/claude-code) session.

Not a log tail. It pins to **one** session you choose and shows only the **latest response**, rendered as markdown for reading and decision-making — refreshing in place. Built for a split terminal: drive Claude Code in one pane, watch its current answer, plan, and task list in the other, without the scrollback noise.

```
    ────────────────────────────────────────────────────────────────────────────────

      The plan moves the auth service first, then the data layer. Three risks
      remain open:

      • session-store cutover has no rollback rehearsal
      • the token format change is not backward-compatible
      • load testing hasn't covered the new rate limiter

    ────────────────────────────────────────────────────────────────────────────────
    ● working  ·  7dab670a                            ↓ 12%   ⇥ response · tasks
    f freeze · ↑↓ scroll · s switch · q quit
```

The response owns the screen. Chrome lives in two muted lines at the bottom: a **status line** (state · session id · scroll position · which surfaces exist, with the active one highlighted) and a **keys line**. No header — the model name, tool calls, and your own prompt are deliberately cut from the review view so nothing competes with the answer.

## Why

Claude Code streams its full transcript — every tool call, file read, and token — to a JSONL file as it works. Watching that raw is noise. When you have several sessions running, a naive "tail the newest file" jumps between them.

`claude-review` does the opposite of a tail:

- **One session, pinned.** Pick the session you care about; it never drifts to another.
- **Latest response only.** The current answer, rendered as clean markdown — not a scrolling log.
- **Content is king.** There's no header; the two-line footer recedes to muted grey, and the response is the only thing at full brightness. Hierarchy comes from *brightness*, not color.
- **Surfaces.** When a turn produces a plan (plan mode) or a task list, `Tab` cycles between `response`, `plan`, and `tasks` views of the same turn.
- **Freeze.** Press `f` to hold the current view while Claude keeps working — read at your own pace; a marker tells you new content is waiting.

## Install

Requires Python 3.9+ and a POSIX terminal (Linux, macOS, WSL).

```bash
# with pipx (recommended — isolated, and sidesteps PEP 668)
pipx install git+https://github.com/r3al1tym/claude-review

# or from a clone
git clone https://github.com/r3al1tym/claude-review
cd claude-review
pipx install .          # or: pip install --user .
```

> **pipx is recommended.** On modern distros (Debian/Ubuntu, Homebrew Python)
> a bare `pip install --user .` may fail with `externally-managed-environment`
> (PEP 668); use `pipx`, a virtualenv, or add `--break-system-packages` if you
> understand the tradeoff.
>
> Not yet published to PyPI. Once it is, `pipx install claude-review` will work directly.

## Usage

```bash
claude-review                 # pick a session interactively, then review it
claude-review -s <id-prefix>  # attach directly to a session id (prefix is fine)
claude-review -p <slug>       # review a different project (see below)
claude-review -l              # list recent sessions and exit
claude-review -V              # print version
claude-review -h              # help
```

The typical flow in a split terminal: run Claude Code on the left, and on the right run `claude-review` and pick the session you're driving. As Claude works, the right pane updates to show its latest response.

### Try it without Claude Code

A sample transcript ships in the repo, so you can see the UI immediately:

```bash
claude-review -p "$PWD/examples"   # from a clone of this repo
```

### Keys (review view)

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

### Claude Code skill (optional)

This repo ships a [Claude Code](https://claude.com/claude-code) **skill** under
[`skill/`](skill/) so you can just say *"open a review pane for this session"* and
Claude resolves the right session id and hands you the command to paste in your
other pane (it never launches the TUI itself — that would hang the turn). The
skill self-installs `claude-review` if it's missing.

To enable it, symlink it into your skills directory:

```bash
ln -s "$PWD/skill" ~/.claude/skills/review-pane
```

### Project slug

Claude Code stores transcripts under `~/.claude/projects/<slug>`, where `<slug>` is the project's absolute path with every `/` replaced by `-` (e.g. `/home/you/myrepo` → `-home-you-myrepo`). With no `-p`, `claude-review` derives the slug from your current directory. Use `-p` to review a project you're not currently `cd`'d into.

## How it works

`claude-review` reads the tail of the session's JSONL transcript and reconstructs the **current turn**: the most recent genuine user prompt and everything the assistant produced after it. It extracts the latest assistant text (the `response` surface), any `ExitPlanMode` plan, and the live task list (replayed from `TaskCreate`/`TaskUpdate` events). It re-reads only when the file changes, and jumps to the top when a fresh turn lands so you always start reading the newest answer from the beginning.

It is **read-only and offline** — it only ever opens transcript files for reading. No writes, no deletes, no network, no telemetry, no subprocesses. The sole dependency is [`rich`](https://github.com/Textualize/rich).

## Notes & limitations

- **Terminal-driven.** It needs an interactive TTY; it's a viewer, not a pipe.
- **Plan surface is best-effort.** It depends on Claude Code emitting `ExitPlanMode` events; if your workflow doesn't use plan mode, you'll just see `response` (and `tasks`, when present).
- **No horizontal scroll.** Very wide markdown tables are wrapped/squeezed to fit the pane, not scrolled sideways.
- **Transcript format.** It parses Claude Code's JSONL transcript layout. If that format changes in a future Claude Code release, parsing may need an update — issues/PRs welcome.

## License

[MIT](LICENSE) © r3al1tym
