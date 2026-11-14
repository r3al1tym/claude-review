# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-11-13

### Added
- **`r latest` in the key row.** Whenever the pane is off the latest reply (on an earlier turn, or held while a newer reply landed), the key row leads with `r latest`, and `r` jumps straight to it.
- **Stepping back freezes the view.** `h` to an earlier turn holds it (the key row says `frozen`) while new replies land; `l` back to the end, `r` or `f` returns to the live turn.

### Changed
- **A turn is an exchange with you.** An exchange begins only at a prompt you sent, and it keeps every text Claude wrote in it, the intermediate ones included. A prompt you send while Claude works joins the exchange where Claude takes it into the running turn, on its own `›` line; one that waits for the turn to end and runs on its own begins the next exchange. A reply to a scheduled prompt, a task notification or another session's message follows your answer under one quiet line naming what set it off (*after a scheduled prompt*); a background turn with no text adds nothing. `h` and `l` step between your exchanges, and the turns before your first prompt in the session stay as they were. The pane records who sent each prompt in its own plugin store, per session, so a resumed session keeps it; history from before that is read by its words: a task notification and another session's message or notice are background, and any other text, `[Image #1]` included, is yours.
- **A new prompt leaves the page alone.** The last answer stays exactly as it was while Claude works on a new prompt: full ink, no settle, and the scroll where you left it. One quiet italic line under the lamp names the prompt being worked on (cut to one row), and the lamp gathers into its breathing ember. The page settles only when the new reply lands. *Previous answer* and the dimming are gone.

### Fixed
- The answer to your question stays on the page when a notification, a scheduled prompt or another session's message arrives after it, and when you send a second question before the first is answered. The pane used to show only the last reply of the last turn.
- Prompts that reach Claude together (typed while a turn ran, then sent in one request) are one exchange: the first keeps the reply, and each later one shows on its own `›` line. Going back to the first used to show an empty exchange, with the answer under the last.
- A reply that grows below the fold relights only its new lines: the rows above stay at their ink while the fore-edge moves.

## [1.1.0] — 2026-10-01

The pane becomes a page under a lamp: one line of warm light over the reply that tells you, from the corner of your eye, whether Claude is working or waiting on you, and a page that never jump-cuts.

### Added
- **The lamp.** A line of light along the top of the column, hottest at its centre and cooling toward its ends like a filament. While Claude works it gathers into a short ember at the centre that breathes slowly; when the turn passes to you it opens across the column and holds; when a plan or a question waits on you it burns full and heavier, and the question or plan leads under a *Waiting for your answer* or *Waiting for your approval* eyebrow, its words held in the lamp's warm light until you answer. At rest the lamp is drawn at full colour depth, so its light runs smooth from the centre to the ends; the ember burns one even colour.
- **The settle.** A new reply never replaces the page in one frame: the old page sinks into the ground, then the new one is lit line by line from the top by the filament above it. Each line lands warm in the lamp's own shape, hottest under its centre, and cools from its ends inward as a filament dies, the agent's emphasis last, in about a second, painted cell by cell. A line enters and leaves whole, every word in the same frame. A code block rises as one panel, and blank rows take no time.
- **The last answer stays.** While a new prompt runs and has no reply yet, your prompt sits under the lamp and the last answer stays below it, named *Previous answer* and dimmed, code panels included, with its headings and weights intact.
- **Questions at the eye line.** A short question or plan waiting on you sits a third of the way down the page, and a question's options are numbered as Claude Code numbers them, so an option in the pane is the key that answers it.
- **The fore-edge.** A reply longer than the pane gets a thin grey bar down its right edge beside the rows in view.
- **The running head.** Scrolled into a long reply, the row under the lamp names the section you are in.

### Changed
- The lamp is the only colour on the page, and what waits on you is the only thing it tints; the words that name its state stay grey.
- The key row's cues read `f freeze · h l turns · m keys`.
- A new prompt over the dimmed answer, or an earlier turn's prompt, wraps to three rows before it is cut.
- Code blocks are set in the page's grey ramp instead of syntax colours: keywords bold at the full ink, strings a step down, comments quiet and italic. Code takes colour only while it passes through the lamp's light in a settle.
- A question is its own heading over its options; the short header label stays on Claude Code's tab.
- The column is centred and at most 72 cells wide, on its own ground; both hairline rules and the `claude review` wordmark are gone, and an earlier turn names itself (*Turn 2 of 5*) in the head row.
- Every colour is a 12-bit value shared by the Text and the painted cells, so a settled frame lands on exactly what Text draws. Running text is a set grey, headings the brightest.
- A table whose rows wrap sets its rows a blank line apart.
- Inline code is set in the brightest ink, without a chip behind it.
- A long code line wraps where a formatter would break it (after a comma, then a bracket, then an operator or space) and hangs its continuation four cells deeper, instead of being cut off.
- A section heading sits on its own text, with air above it and none below; a code panel or a table under it keeps its row of air.

### Fixed
- A blank line inside a code block keeps its row.
- A turn's reply reaches the page before the turn stops counting as working, so the page settles straight from the dimmed answer into the new one.

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

