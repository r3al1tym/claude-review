# Troubleshooting

## "No project dir" / session not found

`claude-review` finds transcripts under `~/.claude/projects/<slug>` (or
`$CLAUDE_CONFIG_DIR/projects/` if you've relocated `~/.claude`). If a lookup
misses:

1. Run `ls ~/.claude/projects/` to see the real directory names.
2. Pass the literal one with `-p`, e.g. `claude-review -p -home-you-myrepo`.
   `-p` also accepts an absolute project path: `claude-review -p /home/you/myrepo`.

You shouldn't usually need this — when run without `-p`, `claude-review`
forward-encodes your current directory, and if that misses it falls back to
scanning transcripts for the project whose recorded `cwd` matches. The escape
hatch above covers the rare cases the fallback can't (see the length cap below).

## How the project slug is encoded

By default Claude Code stores each project's transcripts under
`~/.claude/projects/<slug>`, where `<slug>` is the project's absolute path with
**every non-alphanumeric character replaced by `-`**. That includes `/`, `\`
(Windows), the drive `:`, `.`, space, `_`, `+`, `@`, parentheses — everything
that isn't a letter or digit. Case is preserved.

Examples:

| Project path | Slug |
|---|---|
| `/home/you/myrepo` | `-home-you-myrepo` |
| `/home/you/my.app` | `-home-you-my-app` |
| `/home/you/my_repo` | `-home-you-my-repo` |
| `/home/you/repo/.claude/skills` | `-home-you-repo--claude-skills` |
| `C:\Users\you\repo` | `C--Users-you-repo` |

**Length cap.** If the encoded slug exceeds 200 characters, Claude Code
truncates it and appends a hash of the original path. That hash isn't portably
reproducible, so for very long project paths `claude-review`'s forward-encode
won't match the on-disk directory — its `cwd`-scan fallback handles that case
(it reads the `cwd` recorded inside each transcript, so it's exact regardless of
length). If even that fails, use the `ls ~/.claude/projects/` + `-p` escape
hatch above.

This encoding is undocumented and reverse-engineered (verified against the
Claude Code binary), so it may change in a future Claude Code release.

## Relocated config directory

If you run Claude Code with a non-default config location, set the same value
for `claude-review`:

```bash
export CLAUDE_CONFIG_DIR=/path/to/your/.claude
```

`claude-review` reads transcripts from `$CLAUDE_CONFIG_DIR/projects/`.

## Native Windows

The interactive view needs a POSIX terminal. On Windows, run `claude-review`
inside **WSL** — native `cmd`/PowerShell isn't supported (it exits with a clear
message). `--help`, `--version`, and `-l` work everywhere.
