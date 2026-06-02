# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
- `review-pane` Claude Code skill (under `skill/`): say "open a review pane for
  this session" and it resolves the session id and hands over the command,
  self-installing `claude-review` if missing.
- Test suite over the parser/formatter core, and GitHub Actions CI across
  Python 3.9–3.12.
