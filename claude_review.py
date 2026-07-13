#!/usr/bin/env python3
"""claude-review — a focused review surface for a single Claude Code session.

Not a log tail. It pins to ONE session you choose and shows only the latest
response, rendered for reading and decision-making, refreshing in place. Built
for a split terminal: drive Claude Code in one pane, watch its latest answer,
plan, and task list in the other — without the scrollback noise.

  claude-review                 pick a session interactively, then review it
  claude-review -s <id-prefix>  attach directly to a session id (prefix ok)
  claude-review -p <path|slug>  review a different project (see note below)
  claude-review -l              list recent sessions and exit (no TUI)
  claude-review -V              print version and exit
  claude-review -h              this help

In the review view:
  f          freeze / unfreeze auto-update (hold the view while Claude works)
  Tab        cycle surfaces (response / plan / tasks), when present
  ↑/↓ or j/k scroll line  ·  space / b  scroll page  ·  g / G  top / bottom
  s          switch session (back to picker)
  r          refresh now (also unfreezes)  ·  q  quit

Project slug: by default Claude Code stores transcripts under
~/.claude/projects/<slug>, where <slug> is the project's absolute path with EVERY
non-alphanumeric character replaced by '-' (so '/', '\\', drive ':', '.', space,
'_', '+', etc. all become '-'; case is kept) — e.g. /home/you/my.app ->
-home-you-my-app, C:\\Users\\you\\repo -> C--Users-you-repo. Very long paths are
truncated with a hash suffix. This encoding is reverse-engineered, so the surest
fix if a slug ever mismatches is to `ls ~/.claude/projects/` and pass the literal
dir name with -p. With no -p, claude-review derives the project from your current
directory: it forward-encodes the cwd, and if that misses (long path, or an
encoding quirk), finds the project whose transcripts record a matching cwd. Set
CLAUDE_CONFIG_DIR to point at a relocated ~/.claude.
"""
import sys, os, re, json, glob, time, shutil

# Single source of truth for the version when running from a source checkout
# (pip-installed runs read it from package metadata instead). Kept in sync with
# pyproject.toml by a release-hygiene test.
__version__ = "0.4.0"

# termios/tty/select are POSIX-only and only needed for the interactive TUI.
# Imported lazily inside RawInput so that --help, --version, and -l still work
# (and fail gracefully) on non-POSIX platforms instead of crashing at import.
select = termios = tty = None

HOME = os.path.expanduser("~")
# Claude Code honors CLAUDE_CONFIG_DIR to relocate the whole ~/.claude tree
# (dotfile managers, multi-account). Respect it so we find transcripts there.
_cfg = os.environ.get("CLAUDE_CONFIG_DIR")
CONFIG_DIR = os.path.abspath(os.path.expanduser(_cfg)) if _cfg else os.path.join(HOME, ".claude")
PROJ_ROOT = os.path.join(CONFIG_DIR, "projects")
TAIL_BYTES = 500_000          # how far back to read for the current turn
LIVE_WINDOW = 6.0             # mtime fresher than this => session is "live"
POLL = 0.25                   # input/refresh poll interval (s)


# ----------------------------------------------------------------------------- parsing
def _split_records(raw):
    """Split decoded bytes into JSONL records on REAL newlines only.

    str.splitlines() also breaks on U+2028, U+2029, U+0085, VT, FF, and FS/GS/RS
    — none of which Node's JSON.stringify escapes — so a transcript line whose
    text contains one would be shattered into invalid-JSON fragments and the turn
    would render as "(no response yet)". Splitting on "\\n" alone avoids that.
    The trailing element after a final newline is empty; drop it (and any blank
    line) so callers get the same clean record list splitlines() used to give."""
    text = raw.decode("utf-8", "replace")
    return [ln.rstrip("\r") for ln in text.split("\n") if ln.rstrip("\r")]


def tail_lines(path, nbytes=TAIL_BYTES):
    """Read the last nbytes of a file, return complete records (drop leading partial)."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - nbytes))
            raw = fh.read()
        lines = _split_records(raw)
        if size > nbytes and lines:
            lines = lines[1:]               # first line is probably truncated
        return lines
    except OSError:
        return []


def all_lines(path):
    """Every complete record of a file (see _split_records). Used for session-wide
    state (tasks) that must be counted from the first record, not just the tail."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        return _split_records(raw)
    except OSError:
        return []


def is_real_prompt(content):
    """A genuine user prompt is a non-empty plain string (or a content block-list
    holding one) that isn't a tool result, command wrapper, or stdout echo (those
    start with '<'). Resume/attachment/skill prompts arrive as a list of blocks."""
    return _prompt_text(content) is not None


def _prompt_text(content):
    """The user-visible prompt text, or None if this content isn't a real prompt.
    Handles both the plain-string form and the block-list form Claude Code emits
    for --continue/auto-compact resume ("Continue from where you left off."),
    skill invocations, and image/attachment prompts."""
    def _clean(s):
        s = s.strip() if isinstance(s, str) else ""
        return s if (s and not s.lstrip().startswith("<")) else None
    if isinstance(content, str):
        return _clean(content)
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                t = _clean(b.get("text"))
                if t:
                    parts.append(t)
        return "\n".join(parts) or None
    return None


def _task_subject(inp):
    """Subject line for a TaskCreate, or None to SKIP this call. Real transcripts
    carry three TaskCreate shapes: the todo form ({"subject",...}), the batch form
    ({"tasks": "<json array string>"}) handled separately by the caller, and a
    subagent-spawn form ({"subagent_type","prompt",...}) that is NOT a todo-list
    entry and must not inject a blank row."""
    if "subagent_type" in inp:
        return None
    return inp.get("subject") or inp.get("content") or None


def _reconstruct_tasks(lines):
    """Replay TaskCreate/TaskUpdate over the WHOLE session to rebuild the task
    list. Task ids are assigned sequentially from the first record (Claude Code's
    "Task #N"), so this must count from the start of the file, not the tail window
    — counting within the tail renumbers tasks and makes TaskUpdate mark the wrong
    row (or none). Tasks are cheap, session-wide state, so a full scan is cheap
    and correct."""
    tasks = {}            # id -> {subject, status}
    seq = 0
    for ln in lines:
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if not isinstance(o, dict) or o.get("type") != "assistant":
            continue
        for b in (o.get("message") or {}).get("content", []) or []:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name")
            inp = b.get("input", {}) or {}
            if name == "TaskCreate":
                # Batch form: input.tasks is a JSON string of {content,status,...}.
                batch = inp.get("tasks")
                if isinstance(batch, str):
                    try:
                        items = json.loads(batch)
                    except Exception:
                        items = []
                    for it in items if isinstance(items, list) else []:
                        if not isinstance(it, dict):
                            continue
                        seq += 1
                        tasks[seq] = {"subject": it.get("content") or it.get("subject") or "",
                                      "status": it.get("status") or "pending"}
                    continue
                subject = _task_subject(inp)
                if subject is None:            # subagent spawn, not a todo — skip
                    continue
                seq += 1
                tasks[seq] = {"subject": subject, "status": "pending"}
            elif name == "TaskUpdate":
                try:
                    tid = int(inp.get("taskId"))
                except (TypeError, ValueError):
                    tid = None
                if tid in tasks:
                    st = inp.get("status")
                    if st == "deleted":
                        tasks.pop(tid, None)
                    elif st:
                        tasks[tid]["status"] = st
                    if inp.get("subject"):
                        tasks[tid]["subject"] = inp["subject"]
    # surface the task list (pending/active/done) in id order
    return [{"status": tasks[i]["status"], "content": tasks[i]["subject"]}
            for i in sorted(tasks)] or None


def parse_turn(path):
    """Extract the CURRENT turn: the last real user prompt and everything the
    assistant produced after it (from the tail), plus the session-wide task list
    (rebuilt from the whole file — see _reconstruct_tasks)."""
    q = None
    texts = []
    plan = None
    model = None
    assistant_seen = 0    # how many assistant records appeared in this tail
    parsed_ok = False     # did any assistant content block match our known schema
    for ln in tail_lines(path):
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if not isinstance(o, dict):
            continue
        t = o.get("type")
        if t == "user":
            c = (o.get("message") or {}).get("content")
            pt = _prompt_text(c)
            if pt is not None:
                q = pt
                texts, plan = [], None              # new turn resets (tasks persist)
        elif t == "assistant":
            assistant_seen += 1
            m = o.get("message") or {}
            model = m.get("model") or model
            content = m.get("content")
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                # any recognized block type means the schema still parses — even
                # tool_use / thinking, which produce no visible surface this turn.
                if b.get("type") in ("text", "tool_use", "thinking", "redacted_thinking"):
                    parsed_ok = True
                if b.get("type") == "text" and b.get("text", "").strip():
                    texts.append(b["text"])
                elif b.get("type") == "tool_use" and b.get("name") == "ExitPlanMode":
                    plan = (b.get("input") or {}).get("plan")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    tasklist = _reconstruct_tasks(all_lines(path))
    return {
        "path": path,
        "id": os.path.basename(path).replace(".jsonl", ""),
        "question": q,
        "text": texts[-1] if texts else None,
        "plan": plan,
        "tasks": tasklist,
        "model": model,
        "mtime": mtime,
        # format-drift signal: assistant records exist but NONE of their content
        # blocks matched our known schema -> our parser is likely stale.
        "format_drift": assistant_seen > 0 and not parsed_ok,
    }


def oneline(s):
    """Collapse a prompt to a single safe line: drop control/escape chars that
    would corrupt the terminal (a prompt may contain pasted ANSI), keep spaces.
    rich's Text does NOT strip these, so both the picker and -l need it."""
    return "".join(c if (c.isprintable() or c == " ") else " " for c in (s or ""))


# Control/escape bytes to strip from any transcript-derived text before rendering.
# A transcript can quote arbitrary attacker-controlled content (web-fetch output,
# file contents, tool results), and rich.Markdown does NOT strip ESC — so an
# unsanitized body could smuggle terminal escape sequences that drive the terminal
# or, via OSC 52, silently rewrite the clipboard just by being VIEWED. That would
# invert claude-review's whole "read-only, safe to look at" posture. We drop C0
# controls (0x00-0x1F) and DEL (0x7F) but KEEP \n and \t so markdown still renders,
# and drop the C1 range (0x80-0x9F), which some terminals treat as control intros.
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def sanitize_body(s):
    """Strip terminal control/escape bytes from a body destined for the pager,
    preserving newlines and tabs so Markdown structure survives. See _CTRL_RE."""
    if not s:
        return s
    return _CTRL_RE.sub("", s)


def short_model(m):
    if not m:
        return "?"
    return m.replace("claude-", "").replace("-20", "·")[:14]


def fmt_age(seconds):
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


# ----------------------------------------------------------------------------- terminal control
# Wheel scroll without breaking native text selection: we enable xterm
# "alternateScroll" (?1007h), which makes the mouse wheel emit arrow keys on the
# alternate screen — the existing scroll handling picks those up. We deliberately
# do NOT enable full mouse tracking (?1000h), which would capture clicks and kill
# the terminal's own click-drag selection — the opposite of what a review surface
# wants. With alternateScroll the wheel scrolls AND you can still select text.
ALT_SCROLL_ON = "\x1b[?1007h"
ALT_SCROLL_OFF = "\x1b[?1007l"


def _emit(seq):
    """Write a raw control sequence straight to the terminal (best-effort)."""
    try:
        sys.stdout.write(seq)
        sys.stdout.flush()
    except Exception:
        pass


# Some terminals silently drop an OSC 52 clipboard payload past a size cap
# (xterm's default is 8 KB of base64; many emulators are more generous but still
# bounded). Rather than flash a false "copied", warn past a conservative ceiling.
_OSC52_SOFT_LIMIT = 100_000        # base64 chars; ~74 KB of source text


def copy_to_clipboard(text):
    """Copy text to the terminal clipboard via OSC 52 — a pure stdout escape
    sequence, so it spawns no subprocess, writes no file, and uses no network
    (preserving claude-review's read-only posture) and works over SSH. The
    terminal must support OSC 52 (most modern ones do; some require opt-in).

    Returns "ok" on emit, "empty" for nothing to copy, or "too_large" when the
    payload exceeds a size many terminals silently truncate — so the caller can
    flash an honest message instead of a false confirmation."""
    if not text:
        return "empty"
    import base64
    b64 = base64.b64encode(text.encode("utf-8", "replace")).decode("ascii")
    if len(b64) > _OSC52_SOFT_LIMIT:
        return "too_large"
    _emit(f"\x1b]52;c;{b64}\x07")
    return "ok"


# ----------------------------------------------------------------------------- raw input
class RawInput:
    def __enter__(self):
        global select, termios, tty
        if termios is None:
            import select as _select, termios as _termios, tty as _tty
            select, termios, tty = _select, _termios, _tty
        self.fd = sys.stdin.fileno()
        self.old = termios.tcgetattr(self.fd)
        self.buf = ""
        tty.setcbreak(self.fd)
        return self

    def __exit__(self, *a):
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)

    def _read(self, timeout):
        """Append whatever bytes are available within timeout. Returns True if any."""
        r, _, _ = select.select([sys.stdin], [], [], timeout)
        if not r:
            return False
        self.buf += os.read(self.fd, 1024).decode("utf-8", "replace")
        return True

    def get(self, timeout):
        if not self.buf and not self._read(timeout):
            return None
        while True:
            self._read(0)                      # pull rest of any burst (e.g. wheel)
            # An ESC may be the start of an arrow/CSI seq whose bytes arrive split
            # across reads (common on some terminals). If we only have a bare/partial
            # ESC, wait briefly for it to complete before calling it a real Esc key.
            if self.buf in ("\x1b", "\x1b[") and self._read(0.05):
                continue
            break
        # SS3 cursor keys (ESC O A/B/C/D) — emitted in application-cursor mode,
        # which is how some terminals deliver alternateScroll wheel events. Map
        # them to the same names as the CSI arrows so the wheel scrolls.
        if self.buf.startswith("\x1bO") and len(self.buf) >= 3:
            ss3 = {"A": "up", "B": "down", "C": "right", "D": "left",
                   "H": "home", "F": "end"}.get(self.buf[2])
            if ss3:
                self.buf = self.buf[3:]
                return ss3
        if self.buf.startswith("\x1b["):
            for seq, name in (("[A", "up"), ("[B", "down"), ("[C", "right"),
                              ("[D", "left"), ("[H", "home"), ("[F", "end")):
                if self.buf[1:].startswith(seq):
                    self.buf = self.buf[1 + len(seq):]
                    return name
            # Unknown CSI (e.g. a mouse report like \x1b[<64;10;5M): consume the
            # ENTIRE sequence, not just the first two bytes — otherwise the tail
            # digits leak back as phantom keystrokes (a stray mouse wheel would
            # teleport the picker selection). CSI = ESC [ params/intermediates
            # (0x20-0x3F) then one final byte (0x40-0x7E).
            if self.buf.startswith("\x1b[M") and len(self.buf) >= 6:
                self.buf = self.buf[6:]        # legacy X10 mouse: ESC [ M + 3 bytes
                return None
            j = 2
            while j < len(self.buf) and 0x20 <= ord(self.buf[j]) <= 0x3F:
                j += 1
            if j < len(self.buf) and 0x40 <= ord(self.buf[j]) <= 0x7E:
                self.buf = self.buf[j + 1:]    # drop through the final byte
                return None
            # Sequence not fully arrived yet — leave it buffered, don't emit a tail.
            if self._read(0.05):
                return self.get(timeout)
            self.buf = ""                      # give up on a stuck partial
            return None
        ch, self.buf = self.buf[0], self.buf[1:]
        return "esc" if ch == "\x1b" else ch


# ----------------------------------------------------------------------------- rendering
# rich powers the interactive TUI. It's a declared dependency, but guard the
# import (like termios above) so --help/--version/-l — which use plain print()
# and no rich — still work from a source checkout where rich isn't installed,
# instead of dying with a raw ModuleNotFoundError at import. main() prints a
# clean hint before any rich-dependent path if it's missing.
try:
    from rich.console import Console, Group
    from rich.markdown import Markdown
    from rich.text import Text
    from rich.padding import Padding
    from rich.segment import Segment
    from rich.live import Live
    from rich.table import Table
    from rich.theme import Theme
    _HAVE_RICH = True
except ImportError:
    _HAVE_RICH = False

# Monochrome markdown: in the content area, emphasis comes from WEIGHT
# (bold/italic/underline), never hue — so the prose reads clean and the only
# bright thing on screen is the text itself. Tames rich's loud default theme
# (yellow bullets, cyan-on-black code) into a sophisticated greyscale.
console = Console(theme=Theme({
    "markdown.h1": "bold underline",
    "markdown.h2": "bold",
    "markdown.h3": "bold",
    "markdown.h4": "bold italic",
    "markdown.item.bullet": "grey62",
    "markdown.item.number": "grey62",
    "markdown.code": "grey85 on grey15",
    "markdown.code_block": "grey85 on grey15",
    "markdown.block_quote": "grey62 italic",
    "markdown.link": "underline",
    "markdown.link_url": "grey50",
    "markdown.hr": "grey27",
    "markdown.emph": "italic",
    "markdown.strong": "bold",
})) if _HAVE_RICH else None

# Palette — chrome recedes, content is king. Hierarchy comes from BRIGHTNESS,
# not hue: every frame element is greyscale so nothing competes with the
# response text, which renders at the terminal's full default brightness.
C_META = "grey37"          # quietest line: status line + picker detail
C_QUESTION = "grey62"      # the prompt being answered — frames the content
C_RULE = "grey27"          # hairline section dividers above/below content
C_FOOT = "grey37"          # footer keys + scroll position
C_TAB_ON = "grey85 underline"   # active surface tab: brighter + underline, no color
C_FROZEN = "cyan"          # the ONE color in the UI: marks the frozen toggle state
C_BADGE = "grey70 on grey27"   # wordmark chip — bg matches the rule so it reads as inset


class PreLines:
    """Render an exact, pre-windowed list of segment-lines (already padded)."""
    def __init__(self, lines):
        self.lines = lines

    def __rich_console__(self, console, options):
        for ln in self.lines:
            yield from ln
            yield Segment("\n")


def tasks_renderable(tasks):
    # status by brightness, not hue: done recedes, active is brightest, pending mid.
    style_for = {"completed": ("✓", C_META),
                 "in_progress": ("▸", "grey93 bold"),
                 "pending": ("○", "grey62")}
    body = Text()
    for td in tasks or []:
        sym, st = style_for.get(td.get("status"), ("○", "grey62"))
        body.append(f" {sym}  ", style=st)
        # task subjects are transcript-derived — strip control/escape bytes (a
        # single-line surface, so collapse newlines too), like the picker does.
        body.append(oneline(td.get("content") or "") + "\n", style=st)
    return body


def build_surfaces(turn):
    """Ordered list of (label, renderable) for whatever this turn produced."""
    out = []
    if turn["plan"]:
        out.append(("plan", Markdown(sanitize_body(turn["plan"]))))
    if turn["text"]:
        out.append(("response", Markdown(sanitize_body(turn["text"]))))
    if turn["tasks"]:
        out.append(("tasks", tasks_renderable(turn["tasks"])))
    if not out:
        # Empty surface has two causes. If the file is still being written
        # (fresh mtime), it's a normal pre-text turn — Claude is mid-stream. But
        # if assistant records exist yet NONE parsed AND the file is idle, our
        # parser is likely stale against a changed transcript format — say so
        # instead of pretending Claude is working.
        live = (time.time() - turn["mtime"]) < LIVE_WINDOW
        if turn.get("format_drift") and not live:
            out.append(("waiting", Text(
                "  Transcript format not recognized.\n\n"
                "  claude-review found assistant records but couldn't parse any of\n"
                "  them — Claude Code's transcript format may have changed. Try\n"
                "  updating claude-review (the parser likely needs a new release).",
                style="yellow")))
        else:
            out.append(("waiting", Text("  (no response yet — Claude is working)", style="dim italic")))
    return out


def inset_rule(W, gutter, left_text=None, left_style=C_META, right_text=None):
    """A hairline rule with optional text inset into it — left (offset from the
    margin) and/or right. Used for the top rule (clipped prompt) and the bottom
    rule (overflow cue), so labels sit exactly where the content edge is."""
    seg = "─"
    line = Text(no_wrap=True, overflow="crop")
    line.append(" " * gutter + seg * 2, style=C_RULE)
    used = gutter + 2
    if left_text:
        lt = f" {left_text} "
        # clip the inset text so the rule never overflows the right inset/gutter
        budget = W - used - gutter - 2 - (len(right_text) + 3 if right_text else 0)
        if len(lt) > budget:
            lt = lt[:max(1, budget - 1)] + "… "
        line.append(lt, style=left_style)
        used += len(lt)
    # fill to the right inset (or the end), then the right label, then close
    if right_text:
        rt = f" {right_text} "
        fill = max(0, W - used - len(rt) - gutter)
        line.append(seg * fill, style=C_RULE)
        line.append(rt, style=C_META)
        line.append(seg * 2, style=C_RULE)
    else:
        line.append(seg * max(0, W - used - gutter), style=C_RULE)
    return line


def render_screen(turn, surfaces, active, scroll, frozen=False, pending=False, flash=None):
    W, H = shutil.get_terminal_size()
    live = (time.time() - turn["mtime"]) < LIVE_WINDOW
    gutter = 4                                   # content left margin (the "column")

    # Status is a quiet grey glyph + word — EXCEPT frozen, the one mode you
    # actively control, which gets color so the held state is obvious at a glance.
    # The word is padded to a fixed width below so a state change never shifts
    # the session id beside it. (The frozen "new content" hint lives on the right.)
    if frozen:
        dot, state, status_style = "■", "frozen", C_FROZEN
    elif live:
        dot, state, status_style = "●", "working", C_META
    else:
        dot, state, status_style = "○", "idle", C_META

    # Content-first layout: NO header. Chrome is four rows total — a top rule,
    # a bottom rule, and two footer lines (state, then actions). Everything the
    # old header carried (model, tools, age, the prompt) is cut as not ruthlessly
    # useful; only live/idle/frozen + the session id survive, parked at the
    # bottom so the response owns the top of the screen.

    # --- body: content fills the screen down to the chrome ---------------
    body_h = max(1, H - 3)                         # top rule, bottom rule, key row
    label, renderable = surfaces[active]
    opts = console.options.update_width(W)
    # vertical air + a left gutter so content reads as its own column
    rendered = console.render_lines(Padding(renderable, (1, gutter)), opts, pad=True)
    max_scroll = max(0, len(rendered) - body_h)
    scroll = max(0, min(scroll, max_scroll))
    window = rendered[scroll:scroll + body_h]
    while len(window) < body_h:                    # pad short content to fill
        window.append([Segment(" " * W)])

    # --- top rule: the CLAUDE REVIEW wordmark, with a ▲ overflow cue ---------
    # The wordmark is a calm constant (the prompt is often terse/typo-y, so it's
    # noise up here). A ▲ on the right edge means content is hidden ABOVE.
    rule_top = inset_rule(W, gutter, left_text="claude review", left_style=C_BADGE,
                          right_text=("▲" if scroll > 0 else None))

    # --- bottom rule: ▼ + how far down, shown only when more is below --------
    over_right = None
    if max_scroll > 0 and scroll < max_scroll:
        over_right = f"▼ {round(100 * scroll / max_scroll)}%"
    rule_bot = inset_rule(W, gutter, right_text=over_right)

    # --- key row: status · session on the LEFT, cues + actions on the RIGHT --
    left = Text(no_wrap=True, style=C_META)
    left.append(" " * gutter)
    # Pad the state word to a fixed width so the id beside it never shifts when
    # the state changes (working=7 is the longest of working/idle/frozen).
    left.append(f"{dot} ", style=status_style)
    left.append(f"{state:<7}", style=status_style)
    left.append(f"  ·  {turn['id'][:8]}")
    if frozen and pending:                         # held view, newer content exists
        left.append("   ")
        left.append("new ↓", style=C_FROZEN)

    right = Text(no_wrap=True, style=C_FOOT)
    if len(surfaces) > 1:                          # ⇥ signals Tab cycles these
        right.append("⇥ ", style=C_META)
        for i, (lbl, _) in enumerate(surfaces):
            right.append(lbl, style=(C_TAB_ON if i == active else C_META))
            right.append(" · " if i < len(surfaces) - 1 else "    ", style=C_META)
    # action cues — uniformly muted (the colored "■ frozen" above is the state).
    # A transient flash (e.g. "copied response") briefly replaces the cues after
    # a yank, so the confirmation appears where the eye already is.
    if flash:
        right.append(f"✓ {flash}", style=C_FROZEN)
    else:
        right.append("y copy · ")
        right.append("f unfreeze" if frozen else "f freeze")
        right.append(" · ↑↓ scroll" + ("" if frozen else " · s switch") + " · q quit")

    keyrow = Text(no_wrap=True, overflow="ellipsis", style=C_FOOT)
    pad = max(1, W - len(left.plain) - len(right.plain) - gutter)
    keyrow.append_text(left)
    keyrow.append(" " * pad)
    keyrow.append_text(right)
    keyrow.append(" " * gutter)

    return Group(rule_top, PreLines(window), rule_bot, keyrow), max_scroll


# ----------------------------------------------------------------------------- picker
def _safe_mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:                       # deleted/rotated between glob and stat
        return -1


def list_sessions(proj_dir, limit=14):
    files = glob.glob(os.path.join(proj_dir, "*.jsonl"))
    files.sort(key=_safe_mtime, reverse=True)
    return [parse_turn(p) for p in files[:limit]]


def picker(proj_dir, rawin):
    sessions = list_sessions(proj_dir)
    if not sessions:
        console.print(f"[red]no sessions in {proj_dir}[/]")
        return None
    sel = 0
    with Live(console=console, screen=True, auto_refresh=False) as live:
        while True:
            now = time.time()
            tbl = Table.grid(padding=(0, 1), expand=True)
            tbl.add_column(width=3)            # marker
            tbl.add_column(width=2, justify="right")  # index
            tbl.add_column(width=5)            # age
            tbl.add_column(width=10)           # model
            tbl.add_column(ratio=1)            # question
            for i, s in enumerate(sessions):
                liveflag = (now - s["mtime"]) < LIVE_WINDOW
                sel_row = (i == sel)
                # selection shown by brightness (bright question + arrow), not hue.
                marker = Text("●" if liveflag else "·", style=C_QUESTION if liveflag else C_RULE)
                idx = Text(str(i), style=C_META)
                age = Text(fmt_age(now - s["mtime"]), style=C_META)
                mdl = Text(short_model(s["model"]), style=C_META)
                q = oneline(s["question"]) or "—"
                arrow = "› " if sel_row else "  "
                qstyle = "grey93 bold" if sel_row else C_META
                tbl.add_row(marker, idx, age, mdl,
                            Text(arrow + q, style=qstyle, no_wrap=True, overflow="ellipsis"),
                            style="on grey15" if sel_row else "")
            head = Text("\n  Pick a session to review", style="grey85")
            sub = Text("  ● live · ↑↓ or j/k move · enter select · 0-9 jump · q quit\n", style=C_FOOT)
            live.update(Group(head, sub, tbl), refresh=True)

            k = rawin.get(1.0)
            if k is None:
                sessions = list_sessions(proj_dir)        # refresh liveness/prompts
                if not sessions:                          # all transcripts vanished
                    return None
                sel = min(sel, len(sessions) - 1)
                continue
            if k in ("q", "esc"):
                return None
            if k in ("up", "k"):
                sel = (sel - 1) % len(sessions)
            elif k in ("down", "j"):
                sel = (sel + 1) % len(sessions)
            elif k in ("\r", "\n", "right", "l"):
                return sessions[sel]["path"]
            elif k and k.isascii() and k.isdigit() and int(k) < len(sessions):
                return sessions[int(k)]["path"]


# ----------------------------------------------------------------------------- review loop
def turn_sig(turn):
    """Identity of the current turn — changes when a new prompt or response lands."""
    return (turn["question"], turn["text"], turn["plan"],
            json.dumps(turn["tasks"]) if turn["tasks"] else None)


def _surface_raw_text(turn, label):
    """The RAW source for the active surface, for yanking to the clipboard —
    unwrapped and unstyled, the actual text not the rendered view."""
    if label == "plan":
        return turn.get("plan") or ""
    if label == "tasks":
        return "\n".join(f"[{t.get('status')}] {t.get('content')}"
                         for t in (turn.get("tasks") or []))
    return turn.get("text") or ""           # response (and any other surface)


def review(path, rawin):
    turn = parse_turn(path)
    surfaces = build_surfaces(turn)
    active = 0
    scroll = 0
    frozen = False
    pending = False                  # newer content exists but is held back (frozen)
    flash = None                     # transient footer note (e.g. "copied"), cleared next key
    last_sig = turn_sig(turn)
    last_mtime = turn["mtime"]
    _emit(ALT_SCROLL_ON)             # wheel scrolls without capturing selection
    try:
        with Live(console=console, screen=True, auto_refresh=False) as live:
            while True:
                screen, max_scroll = render_screen(turn, surfaces, active, scroll,
                                                   frozen=frozen, pending=pending,
                                                   flash=flash)
                live.update(screen, refresh=True)

                k = rawin.get(POLL)
                if k is not None:
                    flash = None               # any keypress clears the transient note
                if k == "q":                   # only q quits; esc is harmless here
                    return "quit"
                if k == "s":
                    return "switch"
                if k == "f":
                    frozen = not frozen
                    if not frozen:
                        last_mtime = 0         # unfreeze -> pull latest immediately
                elif k == "y":                 # yank the active surface's RAW text
                    label = surfaces[active][0]
                    res = copy_to_clipboard(_surface_raw_text(turn, label))
                    flash = {"ok": f"copied {label}",
                             "empty": "nothing to copy",
                             "too_large": f"{label} too large to copy"}[res]
                elif k == "\t":
                    active = (active + 1) % len(surfaces)
                    scroll = 0
                elif k in ("j", "down"):
                    scroll = min(scroll + 1, max_scroll)
                elif k in ("k", "up"):
                    scroll = max(scroll - 1, 0)
                elif k in (" ",):
                    scroll = min(scroll + 10, max_scroll)
                elif k in ("b",):
                    scroll = max(scroll - 10, 0)
                elif k in ("g", "home"):
                    scroll = 0
                elif k in ("G", "end"):
                    scroll = max_scroll
                elif k == "r":
                    frozen = False
                    last_mtime = 0      # force reparse below

                # check the file's mtime; while frozen we only note that newer
                # content is waiting, without disturbing what you're reading.
                try:
                    m = os.path.getmtime(path)
                except OSError:
                    m = last_mtime
                if frozen:
                    pending = m != last_mtime
                    continue
                pending = False
                if m != last_mtime:
                    last_mtime = m
                    turn = parse_turn(path)
                    surfaces = build_surfaces(turn)
                    active = min(active, len(surfaces) - 1)
                    sig = turn_sig(turn)
                    if sig != last_sig:      # fresh turn -> jump to top to read it
                        scroll = 0
                        active = 0
                        last_sig = sig
    finally:
        _emit(ALT_SCROLL_OFF)               # always restore the terminal's wheel


# ----------------------------------------------------------------------------- main
# Mirror Claude Code's slug cap: if the encoded path exceeds this, CC truncates
# and appends a hash of the ORIGINAL path. We can't reproduce CC's non-portable
# hash, so beyond this length the forward-encode can't match — the cwd-scan
# fallback in resolve_proj() takes over (it reads the recorded cwd, no encoding).
# Value taken from the CC bundle (gM(): `if($.length<=200)`).
_SLUG_MAX = 200


def _encode_path(abs_path):
    """Encode an absolute path to its ~/.claude/projects/<slug> directory name,
    mirroring Claude Code's encoder (verified against the CC binary, gM()):
    EVERY non-alphanumeric character becomes '-' (so '/', '\\', ':', '.', space,
    AND '_', '+', '~', parens, etc. all collapse) — case is preserved.

    Pure (no filesystem access) and expects an already-absolute path, so it
    encodes both POSIX and Windows inputs deterministically on any OS, which
    makes it unit-testable cross-platform.

    NOTE: CC caps the slug at 200 chars (then truncates + appends a hash of the
    original path). That hash isn't portably reproducible, so for very long paths
    this returns the un-truncated encode, which WON'T match on disk — resolve_proj
    then falls back to the cwd-scan, which is exact regardless of length."""
    return re.sub(r"[^A-Za-z0-9]", "-", abs_path)


def encode_cwd(path):
    """Slug for a path on THIS OS (e.g. /home/u/my.app -> -home-u-my-app;
    C:\\Users\\x -> C--Users-x on Windows — '\\' and ':' are non-alphanumeric)."""
    return _encode_path(os.path.abspath(path))


def _transcript_cwd(jsonl_path):
    """Return the first recorded cwd in a transcript, or None. The first line is a
    file-history-snapshot with no cwd, so scan a few more lines."""
    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh):
                if n > 30:
                    break
                try:
                    cwd = json.loads(line).get("cwd")
                except ValueError:
                    continue
                if cwd:
                    return cwd
    except OSError:
        pass
    return None


def resolve_proj(slug):
    # Explicit -p wins. Accept an absolute path (cross-platform), else a slug under PROJ_ROOT.
    if slug:
        return slug if os.path.isabs(slug) and os.path.isdir(slug) \
            else os.path.join(PROJ_ROOT, slug)

    # 1) Forward-encode cwd — fast path, matches CC's real rule on all OSes.
    encoded = os.path.join(PROJ_ROOT, encode_cwd(os.getcwd()))
    if os.path.isdir(encoded):
        return encoded

    # 2) Authoritative fallback: find the project dir whose transcripts record
    #    cwd == our cwd. OS- and version-proof (no slug guessing). Some dirs hold
    #    only nested subdirs and some hold zero transcripts — glob recursively
    #    and tolerate empties.
    here = os.path.abspath(os.getcwd())
    if os.path.isdir(PROJ_ROOT):
        for entry in os.scandir(PROJ_ROOT):
            if not entry.is_dir():
                continue
            for jsonl in glob.iglob(os.path.join(entry.path, "**", "*.jsonl"), recursive=True):
                if _transcript_cwd(jsonl) == here:
                    return entry.path
                break          # one transcript per dir is enough to read its cwd

    # 3) Nothing matched — return the encoded guess so the error message is sensible.
    return encoded


def _version():
    try:
        from importlib.metadata import version, PackageNotFoundError
        try:
            return version("claude-review")
        except PackageNotFoundError:
            # running from a source checkout (not pip-installed) — report the
            # in-tree version so bug reports still carry a useful number.
            return f"{__version__}+source"
    except Exception:
        return "unknown"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Windows consoles default to a legacy code page (cp1252/charmap) that can't
    # encode the UI glyphs (↑↓ ● ─ …) printed by --help / -l via plain print(),
    # so without this even `claude-review --help` dies with UnicodeEncodeError.
    # rich handles its own output, but these paths don't go through rich. No-op
    # on POSIX (already UTF-8); guarded for older streams without reconfigure.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    slug = sid = None
    do_list = False
    i = 0

    # value for a flag: prefer an inline "--flag=value", else the next token.
    # NOTE: the next token may legitimately start with '-' — a POSIX Claude Code
    # slug is an absolute path with '/'->'-', so it usually begins with '-'
    # (e.g. -home-user-repo); on Windows it begins with the drive letter
    # (C--Users-you-repo). Either way we only fail when there's no following token.
    def value_for(flag, inline):
        nonlocal i
        if inline is not None:
            return inline
        if i + 1 >= len(argv):
            print(f"{flag} needs a value. Try 'claude-review -l' to see session ids, "
                  f"or run 'claude-review' to pick one.", file=sys.stderr)
            return None
        i += 1
        return argv[i]

    while i < len(argv):
        a = argv[i]
        inline = None
        if a.startswith("--") and "=" in a:        # --project=<slug> form
            a, inline = a.split("=", 1)
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a in ("-V", "--version"):
            print(f"claude-review {_version()}")
            return 0
        if a in ("-p", "--project"):
            v = value_for(a, inline)
            if v is None:
                return 2
            slug = v; i += 1; continue
        if a in ("-s", "--session"):
            v = value_for(a, inline)
            if v is None:
                return 2
            sid = v; i += 1; continue
        if a in ("-l", "--list"):
            do_list = True; i += 1; continue
        print(f"unknown arg: {argv[i]}", file=sys.stderr); return 1

    proj = resolve_proj(slug)

    def _has_sessions(p):
        return os.path.isdir(p) and bool(glob.glob(os.path.join(p, "*.jsonl")))

    def _no_project_msg():
        print(f"no project dir: {proj}", file=sys.stderr)
        if os.path.isdir(PROJ_ROOT):
            names = sorted(e.name for e in os.scandir(PROJ_ROOT) if e.is_dir())
            if names:
                print(f"Available projects under {PROJ_ROOT} — pass one with -p <slug>:",
                      file=sys.stderr)
                for name in names[:8]:
                    print(f"  {name}", file=sys.stderr)
                if len(names) > 8:
                    print(f"  … and {len(names) - 8} more", file=sys.stderr)
            else:
                print(f"(no Claude Code projects found under {PROJ_ROOT} yet.)", file=sys.stderr)
        else:
            print(f"(transcript root {PROJ_ROOT} doesn't exist — is Claude Code installed? "
                  "Set CLAUDE_CONFIG_DIR if your ~/.claude lives elsewhere.)", file=sys.stderr)

    # Everything below -l (the spinner wait and the TUI) renders via rich.
    # -h/-V returned already; -l is handled further down and needs no rich. So
    # this is the first point an interactive launch genuinely needs it — fail
    # with a clean hint rather than a traceback if a source checkout lacks it.
    if not do_list and not _HAVE_RICH:
        print("claude-review's interactive view needs the 'rich' package — "
              "install it with 'pip install rich' (or reinstall via pipx). "
              "-h, -V, and -l work without it.", file=sys.stderr)
        return 1

    # Brand-new-session race: claude-review launched the instant Claude Code
    # starts, before the first transcript is flushed — so the project dir may
    # not exist (or be empty) for a beat. When the project was derived from cwd
    # (no explicit -p) and we're at an interactive POSIX terminal, WAIT for a
    # session to appear instead of erroring out. An explicit -p that's missing
    # is treated as a typo and errors immediately with suggestions.
    if not _has_sessions(proj):
        can_wait = slug is None and not do_list and sys.stdin.isatty() and os.name == "posix"
        if not can_wait:
            if os.path.isdir(proj):
                print(f"no sessions in {proj}", file=sys.stderr)
            else:
                _no_project_msg()
            return 1
        here = os.path.abspath(os.getcwd())
        try:
            with console.status(f"Waiting for a Claude Code session in {here} …  "
                                "(start a turn in Claude Code · Ctrl-C to quit)",
                                spinner="dots"):
                while not _has_sessions(proj):
                    time.sleep(0.5)
                    proj = resolve_proj(slug)        # re-derive: dir may appear
        except KeyboardInterrupt:
            return 130

    if do_list:
        now = time.time()
        sessions = list_sessions(proj)
        if not sessions:
            print(f"no sessions in {proj}", file=sys.stderr)
            return 1
        for s in sessions:
            flag = "●" if (now - s["mtime"]) < LIVE_WINDOW else " "
            q = (oneline(s["question"]) or "(no prompt)")[:70]
            print(f"{flag} {s['id'][:8]}  {fmt_age(now - s['mtime']):>4}  "
                  f"{short_model(s['model']):<12}  {q}")
        return 0

    direct = None
    if sid:
        hits = glob.glob(os.path.join(proj, f"{sid}*.jsonl"))
        if not hits:
            print(f"no session matching '{sid}' in {proj}", file=sys.stderr)
            print("Try 'claude-review -l' to see available session ids.", file=sys.stderr)
            return 1
        # An ambiguous prefix can match several sessions — attach to the most
        # recently active one rather than an arbitrary glob order.
        hits.sort(key=_safe_mtime, reverse=True)
        direct = hits[0]

    if not sys.stdin.isatty():
        print("claude-review needs an interactive terminal (stdin is not a tty).",
              file=sys.stderr)
        return 1

    # The interactive view needs termios/tty/select (Unix-only). WSL reports
    # 'posix' and works; native Windows (cmd/PowerShell) does not — fail with a
    # clear pointer instead of a raw ModuleNotFoundError from RawInput.
    if os.name != "posix":
        print("claude-review's interactive view needs a POSIX terminal. On Windows, "
              "run it inside WSL (Ubuntu), not native cmd/PowerShell. "
              "-h, -V, and -l work everywhere.", file=sys.stderr)
        return 1

    with RawInput() as rawin:
        path = direct
        while True:
            if path is None:
                path = picker(proj, rawin)
                if path is None:
                    return 0
            result = review(path, rawin)
            if result == "quit":
                return 0
            if result == "switch":
                path = None        # back to picker
                direct = None


def cli():
    """Console-script entry point."""
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        # Foreseeable errors are already handled with clean messages above; this
        # catches the genuinely unexpected so end users get a line, not a wall of
        # traceback. Set CLAUDE_REVIEW_DEBUG=1 to see the full stack.
        if os.environ.get("CLAUDE_REVIEW_DEBUG"):
            raise
        print(f"claude-review: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
