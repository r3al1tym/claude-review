# Security

`claude-review` is a read-only Claude Code mod. It reads the current session's conversation through the hooks API and draws a pane. It writes nothing to the session, makes no network calls and touches no files. The only side effect is the clipboard: `y` copies the surface shown through Claude Code's own clipboard call, and only when you press it.

## Threat model

A conversation can contain arbitrary text that Claude quoted from elsewhere: web pages, file contents, tool results, pasted input. The mod treats all of it as untrusted and strips terminal control and escape bytes before drawing it, so viewing a session can't drive your terminal or rewrite your clipboard through smuggled escape sequences. Links are drawn as links only when they are plain `https:` URLs.

## Reporting a vulnerability

If you find a security issue, especially anything that lets crafted conversation text affect the terminal, the clipboard or the filesystem, please report it privately first:

- Open a [GitHub security advisory](https://github.com/r3al1tym/claude-review/security/advisories/new) (preferred), or
- open a regular issue **without** exploit details and ask for a private channel.
