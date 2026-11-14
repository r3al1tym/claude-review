# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-01

claude-review is a Claude Code mod. The pane docks inside Claude Code, beside the conversation.

### Added
- **The mod, `review-pane`.** Install it with `claude plugin marketplace add r3al1tym/claude-review` and `claude plugin install review-pane@claude-review`, or link a clone into `~/.claude/skills/review-pane`. It opens by itself on a terminal 144 columns or wider; `/claude-review` toggles it at any width; *Open on start* in `/config` turns the automatic open off.
- **The reading screen.** A `claude review` rule on top, the reply in a padded column (a 4-cell gutter and a blank row above and below) in the monochrome markdown theme, and a pinned bottom rule and key row with the state on the left and the cues on the right. The rules carry ▲ and ▼ N% overflow cues.
- **Live follow.** The pane refreshes as rows land in the conversation, so it updates while Claude writes.
- **Keys.** `h` `l` turns, arrows `j` `k` PgUp PgDn Home End `g` scroll, `f` freeze, `r` back to live, `t` next surface, `y` copy, `m` the guide with diagnostics, `q` close. The pane takes the keys after ctrl+x then Tab.

### Changed
- A plan leads only while it waits for approval; once approved, the response leads and the plan sits behind it.
- The desktop app and VS Code draw the reply with their own Markdown and buttons.

