---
name: review-pane
description: "Open a claude-review pane — a focused, read-only TUI that shows the latest response (plus plan/tasks) of a single Claude Code session in a split terminal. Use this skill when the user asks to 'launch a claude-review pane', 'open a review pane', 'watch this session in another pane', 'show the latest response on the side', 'review pane for this session', 'put this session in a side pane', or otherwise wants to follow a session's output in a second pane while they keep working here. Self-installs claude-review if missing, resolves the right session id, and hands over the exact command to paste in the other pane."
---

# claude-review pane

`claude-review` is an interactive, read-only terminal viewer that pins to **one**
Claude Code session and renders only its latest response (and `plan`/`tasks`
surfaces), refreshing in place. It runs in a **second terminal pane** while the
user drives Claude Code in this one.

## The one hard rule

**NEVER launch the TUI from a tool call.** `claude-review` (without `-l`) is a
full-screen interactive program that expects a real TTY. Run from a Bash tool
call its stdin is a pipe, so it blocks and never returns — the agent turn hangs
until it is force-killed by timeout. This skill RESOLVES the session id and HANDS
the user a command to run themselves in their other pane. The only sub-commands
you may run yourself are the non-interactive ones: `claude-review -l`, `-V`, `-h`.

## Golden path

### 1. Detect and prepare

Ensure the tool is installed — **don't just print an install command and stop;
run the bundled setup which installs it if missing** (idempotent, instant if
already present). Resolve the script via `$CLAUDE_SKILL_DIR` (set by Claude Code
to this skill's own directory, whatever the install layout):

```bash
bash "${CLAUDE_SKILL_DIR:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/review-pane}}/scripts/setup.sh" 2>&1
```

(`$CLAUDE_SKILL_DIR` is preferred; the `CLAUDE_PLUGIN_ROOT` and literal
`~/.claude/skills/review-pane` entries are fallbacks for older versions / a future
plugin packaging. Do **not** use `$(dirname "$0")` — a SKILL.md body is injected
as instructions, not run as a script, so `$0` is the shell, not this file.)

The script prints one grep-able final line and will:
- ensure `claude-review` is installed (prefers an isolated install; offline from a
  local clone if present, else from the pinned GitHub release),
- confirm `claude-review -V` works and report whether `~/.local/bin` is on PATH.

Read the final line:
- `SETUP_OK <ver>` — good; proceed.
- `SETUP_PATH_INACTIVE <ver>` — installed, but `~/.local/bin` isn't on the current
  PATH. In step 3, hand over the **absolute** form
  `$HOME/.local/bin/claude-review -s <id>`, and tell the user to add
  `~/.local/bin` to PATH (or open a fresh login pane) for the short form to work.
- `SETUP_FAIL <reason>` — tell the user the reason; offer the manual install
  (`pipx install git+https://github.com/r3al1tym/claude-review@v0.4.0`).

### 2. Resolve which session the user means

- **"this session" / "current" / unspecified** (the common case): the env var
  `CLAUDE_CODE_SESSION_ID` **is** the session running right now —
  `printf '%s\n' "$CLAUDE_CODE_SESSION_ID"`. Use it directly; no picker needed.
- **A different session they describe** ("the one about the deploy"): run
  `claude-review -l` (lists `● id  age  model  first-prompt`), match on the prompt
  text, take the 8-char id.
- **A different project**: sessions are per-project. **Don't hand-construct the
  slug** — the encoding collapses several characters (`/`, `.`, space, `\`, drive
  `:`) to `-`, so a guessed slug often misses. Instead pass `-p` an **absolute
  project path** and let the tool encode it: `-p "$PWD/examples"`, or
  `-p /home/u/some.repo`. If you must use a slug, copy the literal directory name
  from `ls ~/.claude/projects/` rather than building it. Confirm with
  `claude-review -l -p <path-or-slug>` if unsure.
- **Env var empty / ambiguous**: don't guess — tell them to run bare
  `claude-review` (interactive picker) or run `claude-review -l` and present the
  choices.

### 3. Hand over the command

Give a single, copy-pasteable line and say to run it in their **other** pane:

```
claude-review -s <id>
```

(prefix `-p <slug>` if it's another project). Use the 8-char id prefix — it's
enough and reads cleaner. Confirm what it resolved to ("this session,
auto-detected" / "the session about X").

## Keys to mention if helpful

`Tab` cycles surfaces (response / plan / tasks) · `↑↓`/`j`/`k` scroll · `f` freezes
the view while Claude keeps working · `s` switches session · `q` quits.

## Notes

- Read-only and offline — only reads transcript files under `~/.claude/projects`
  (or `$CLAUDE_CONFIG_DIR/projects` if that env var relocates `~/.claude`).
- Refreshes in place as this session works; no need to relaunch per turn.
- Windows Terminal / tmux: just give the command — let the user place the pane;
  don't try to spawn panes for them.
- **Platform**: the interactive TUI needs a POSIX terminal — Linux, macOS, and
  **Windows via WSL** all work. On **native Windows** (cmd/PowerShell) the TUI
  won't run; it exits with a clear "use WSL" message (`-l`/`-V`/`-h` still work).
  If the user is on native Windows, tell them to run claude-review inside WSL.
