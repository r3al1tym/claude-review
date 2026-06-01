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
- Monochrome, content-first design — chrome recedes to grey; the response is the
  only element at full brightness.
- Scroll (line/page/top/bottom), session switching, and refresh.
- `-l` to list sessions, `-s` to attach by id prefix, `-p` to target a project.
