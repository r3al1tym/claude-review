---
name: Bug report
about: Something rendered wrong, a key misbehaved, or the pane went blank
title: ''
labels: bug
---

**What happened**
A clear description of the bug.

**Environment**
- review-pane version (`claude plugin list`):
- Claude Code version (`claude --version`):
- OS / terminal (e.g. macOS / iTerm2, Ubuntu / WSL / Windows Terminal):
- Placement and size (the `pane` line in the guide, `m`):

**The reply that rendered wrong (if a rendering issue)**
Paste the markdown of the reply, **with any sensitive content redacted**. A reply that reproduces the bug is the most useful thing you can include.

```markdown

```

**Debug log**
Run `claude --debug-file /tmp/cc.log` and paste any lines mentioning `review-pane`.

**Expected vs actual**
What you expected to see versus what was shown.
