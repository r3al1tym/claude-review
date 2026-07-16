# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — 2026-07-15

### Fixed
- **Questions are now visible.** When Claude asks a multiple-choice question via
  the `AskUserQuestion` tool, the whole message — the question and its options —
  lives inside the tool call, with no accompanying text block. The parser only
  read text blocks, so the pane showed the *previous* turn's stale answer, or went
  blank ("no response yet — Claude is working") while Claude was in fact blocked
  waiting on your choice. `AskUserQuestion` is now a first-class `question` surface
  that leads over any stale prior text and renders the question, each option's
  label + description, and a multi-select hint. This is the common shape for a
  grilling/decision session, where following the questions is the whole point.

## [0.4.0] — 2026-07-13

Correctness and safety hardening for a wider audience. A review surface has to be
trustworthy to *look at* and faithful to what actually happened in the session —
this release closes gaps in both.

### Fixed
- **Terminal-escape safety.** Response, plan, and task text is now stripped of
  control/escape bytes before rendering. A transcript can quote arbitrary content
  (web-fetch output, file contents, tool results), and `rich` does not strip
  `ESC` — so before this, merely *viewing* a session could drive the terminal or
  rewrite the clipboard via OSC 52. The body is now sanitized like the picker
  already was, keeping newlines and tabs so Markdown still renders.
- **Resume / attachment / skill prompts are recognized.** `--continue` and
  auto-compact resume ("Continue from where you left off."), skill invocations,
  and image/attachment prompts arrive as a content *block-list*, not a bare
  string. These now update the question and reset the view instead of leaving the
  pane showing the previous turn's prompt against a stale answer.
- **Task list reconstructed from the whole session, not the tail.** Task ids are
  assigned from the first record, so counting them within the 500 KB tail window
  could mark the wrong task done (or drop an update) in long sessions. Tasks are
  now replayed over the entire file. The batch (`tasks` array) and subagent-spawn
  `TaskCreate` shapes are handled, so neither miscounts ids nor injects a blank row.
- **JSONL records no longer split on Unicode separators.** Parsing split on real
  newlines only; `str.splitlines()` also breaks on U+2028/U+2029/U+0085 (which
  Node does not escape), which could shatter a record and lose the response.
- A malformed non-object line (or an explicit `"message": null`) is skipped
  instead of crashing the whole picker/list.
- `-s <prefix>` attaches to the most recently active matching session, not an
  arbitrary one, when a prefix is ambiguous.
- `list_sessions` tolerates a transcript deleted between listing and sorting.
- `y` copy reports `too large to copy` past the OSC 52 size many terminals
  silently truncate, instead of a false `copied`.

### Changed
- CI now sweeps Python 3.13 and fails the build if the release tag the docs pin
  isn't pushed to origin (so a documented install can never 404). PyPI classifiers
  list each supported Python version.

## [0.3.0] — 2026-06-03

Mouse scroll and clipboard copy — a review surface should be easy to scroll and
quote from.

### Added
- **Mouse-wheel scrolling.** Enables xterm `alternateScroll` (`?1007h`) so the
  wheel scrolls the response, while leaving native click-drag text selection
  intact (no full mouse capture). Wheel events arriving as SS3 cursor keys
  (`ESC O A/B`) are now handled too.
- **`y` copies the active surface** (response / plan / tasks) — the raw,
  unwrapped source text — to the clipboard via OSC 52 (a stdout escape: no
  subprocess, no file write, no network, and works over SSH). A transient
  `✓ copied` note flashes in the footer. This is the reliable way to grab a long
  response in full, since the alternate screen has no scrollback to drag-select.

## [0.2.1] — 2026-06-03

Pre-release polish.

### Fixed
- `--help`/`-V`/`-l` now work from a source checkout without `rich` installed
  (the import is guarded); the interactive view prints a clean "install rich"
  hint instead of a traceback.
- `-V` from a source checkout reports the real version (`0.2.1+source`) instead
  of `0.0.0+source`.

## [0.2.0] — 2026-06-03

Cross-platform correctness and clean-setup robustness. A portability audit
(verified against real transcripts and a fresh-container install) found the slug
derivation broke for any project path containing a `.` or space — on every OS —
so this is a recommended upgrade for all users.

### Fixed
- **Project slug derivation** now mirrors Claude Code's real encoding: `/`, `.`,
  space, `\` (Windows), drive `:`, `_`, `+`, and every other non-alphanumeric
  character all collapse to `-` (previously only `/`). Projects under
  dotted/spaced/underscored paths (incl. nested `.claude`/`.config` dirs) no
  longer fail with "no project dir".
- Added an authoritative fallback that resolves the project by scanning
  transcripts for a matching recorded `cwd` — OS- and version-proof.
- Native Windows: `--help`/`-l` no longer crash with `UnicodeEncodeError`
  (stdout/stderr forced to UTF-8); the interactive TUI degrades with a clear
  "use WSL" message instead of a raw `ModuleNotFoundError`.

### Added
- Honor `CLAUDE_CONFIG_DIR` to locate a relocated `~/.claude` tree.
- Wait (with a spinner) for a brand-new session's first transcript instead of
  erroring on the launch race.
- Format-drift banner: if Claude Code's transcript format changes, say so
  instead of silently showing "Claude is working".
- Empty-state now lists available projects to choose from.
- CI matrix extended to macOS and Windows; cross-OS slug encoding unit tests.

## [0.1.0] — 2026-06-01

Initial release.

### Added
- Single-session review TUI: pins to one Claude Code session and renders only
  the latest response, refreshing in place.
- Interactive session picker with live-session markers, age, and model.
- Surfaces: `response`, `plan` (from `ExitPlanMode`), and `tasks` (replayed from
  `TaskCreate`/`TaskUpdate`), cycled with `Tab`.
- Freeze (`f`): hold the current view while Claude keeps working, with a marker
  when new content is waiting.
- Monochrome, content-first design — no header; chrome recedes to a two-line
  footer (status line + keys), and the response is the only element at full
  brightness.
- Scroll (line/page/top/bottom), session switching, and refresh.
- CLI flags: `-l` list sessions, `-s` attach by id prefix, `-p` target a project,
  `-V` print version, `-h` help. `-p` accepts both project slugs (leading-dash
  paths) and absolute paths, plus the `--project=<value>` form.
- A bundled sample transcript under `examples/` so the UI can be tried without
  Claude Code installed.
- `review-pane` Claude Code skill (under `skills/review-pane/`): say "open a review pane for
  this session" and it resolves the session id and hands over the command,
  self-installing `claude-review` if missing.
- Test suite over the parser/formatter core, and GitHub Actions CI across
  Python 3.9–3.12.
