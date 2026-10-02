# Contributing

Thanks for looking at `claude-review`. It is a small Claude Code mod on purpose, so contributions that keep it small are the easiest to accept.

## Ground rules

- **Read-only.** The mod reads the conversation and draws a pane. It writes nothing to the session, makes no network calls and touches no files. If a feature seems to need one of those, open an issue first.
- **Treat conversation text as untrusted.** A reply can quote anything Claude read. Control and escape bytes are stripped before anything is drawn (`clean` and `oneline` in `hooks/text.ts`); keep it that way.
- **One look.** The pane is greyscale chrome with one accent colour, cyan, for the state you set (frozen, new reply). Emphasis comes from weight.

## Development

```bash
git clone https://github.com/r3al1tym/claude-review
ln -s "$PWD/claude-review" ~/.claude/skills/review-pane
```

Every interactive Claude Code session now loads your clone as `review-pane@skills-dir` and reloads it when you save a file. The engine lays the API's TypeScript declarations beside the mod in `.claude-plugin/types/` each time it loads it, and `tsconfig.json` extends them, so your editor and `tsc -p .` type the mod with no setup.

```bash
claude plugin validate .   # what the engine will load, and anything it would refuse
claude plugin test .       # tests/*.test.ts against the engine itself
```

The layout is `hooks/register.tsx` (hooks, state, keys), `hooks/screen.tsx` (the terminal screen), `hooks/markdown.ts` (markdown to rows), `hooks/text.ts` (cells and wrapping) and `hooks/transcript.ts` (turns from the conversation).

## Pull requests

- Add or update a test for any behaviour change, and run `claude plugin test .` before pushing; CI runs validate and the suite.
- If you touch the screen, look at it in a real terminal at a few widths, docked (fullscreen) and inline.
- Note user-facing changes in `CHANGELOG.md` under an `## [Unreleased]` heading.
