---
name: Bug report
about: Something rendered wrong, crashed, or a transcript didn't parse
title: ''
labels: bug
---

**What happened**
A clear description of the bug.

**Environment**
- claude-review version (`claude-review -V`):
- Claude Code version:
- OS / terminal (e.g. macOS / iTerm2, Ubuntu / WSL):
- Python version (`python3 --version`):

**Transcript snippet (if a parsing/rendering issue)**
The tool reconstructs a turn from `~/.claude/projects/<slug>/<id>.jsonl`. If a
response/plan/tasks surface looked wrong, paste the relevant JSONL line(s) here —
**with any sensitive content redacted**. This is by far the most useful thing for
diagnosing format-drift issues.

```json

```

**Expected vs actual**
What you expected to see versus what was shown.
