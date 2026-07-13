# Contributing

Thanks for looking at `claude-review`. It's a small, single-file tool on purpose,
so contributions that keep it that way are the easiest to accept.

## Ground rules

- **Keep it one file, one dependency.** The tool is a single `claude_review.py`
  with only `rich` at runtime. A change that adds a runtime dependency or splits
  the module needs a strong reason.
- **Read-only and offline at runtime.** No file writes, no subprocesses, no
  network. If a feature seems to need one of those, open an issue first.
- **Treat transcript text as untrusted.** Anything read from a transcript may
  contain arbitrary quoted content — sanitize control/escape bytes before
  rendering (see `sanitize_body` / `oneline`).

## Development

```bash
git clone https://github.com/r3al1tym/claude-review
cd claude-review
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
pytest -q
```

The tests cover the pure parsing/formatting core (turn reconstruction, slug
encoding, task replay, sanitizing). The interactive TUI needs a real TTY and is
verified by hand — if you change rendering or input handling, run
`claude-review -p "$PWD/examples"` and exercise the keys.

## Pull requests

- Add or update a test for any parser/behavior change. A regression that the
  suite would miss is a regression that ships.
- Run `pytest -q` before pushing; CI runs the suite across Python 3.9–3.13 plus
  a clean-room install test.
- Keep commits focused and messages descriptive. Note user-facing changes in
  `CHANGELOG.md` under an `## [Unreleased]` heading if you're not cutting a
  release.
- The parser tracks Claude Code's transcript format, which can change. If you
  hit a format-drift case, a transcript snippet (with sensitive content redacted)
  in the issue or PR is the most useful thing you can include.

## Reporting bugs

Use the issue template. For a parsing/rendering bug, the redacted JSONL line(s)
that reproduce it are worth more than a description.
