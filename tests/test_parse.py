"""Tests for the pure parsing/formatting core of claude-review.

The TUI/rendering layer (rich, termios, Live) is intentionally not tested here —
these cover the deterministic logic that reconstructs a turn from a transcript,
which is where correctness actually matters.
"""
import re
import json
import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent

# Load the single-module package by path (no package install needed for tests).
_SPEC = importlib.util.spec_from_file_location("claude_review", _ROOT / "claude_review.py")
cr = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cr)


# --------------------------------------------------------------------------- release hygiene
# These guard the STRANGER-INSTALL path: the documented install pins a release
# tag, so the version in pyproject, the tag the installer pins (setup.sh PIN),
# and the latest CHANGELOG heading must all agree. A drift here means a fresh
# `pipx install ...@<PIN>` ships code that doesn't match this tree — exactly the
# bug a fresh-container test caught once. Cheap to assert, so assert it.
def _pyproject_version():
    txt = (_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'(?m)^version\s*=\s*"([^"]+)"', txt).group(1)


def test_module_version_matches_pyproject():
    assert cr.__version__ == _pyproject_version(), (
        "claude_review.__version__ is out of sync with pyproject — source runs "
        "would report the wrong version. Bump both together."
    )


def test_setup_pin_matches_pyproject_version():
    setup = (_ROOT / "skills/review-pane/scripts/setup.sh").read_text(encoding="utf-8")
    pin = re.search(r'(?m)^PIN="v([^"]+)"', setup).group(1)
    assert pin == _pyproject_version(), (
        "setup.sh PIN is stale vs pyproject version — a fresh install would ship "
        "the wrong code. Bump the tag/PIN together."
    )


def test_changelog_has_an_entry_for_current_version():
    changelog = (_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    ver = _pyproject_version()
    assert re.search(r'(?m)^##\s*\[%s\]' % re.escape(ver), changelog), (
        f"no CHANGELOG entry for {ver} — document the release before tagging."
    )


def test_skill_manual_install_pin_matches_version():
    skill = (_ROOT / "skills/review-pane/SKILL.md").read_text(encoding="utf-8")
    pins = re.findall(r'claude-review@v([0-9][^`)\s]*)', skill)
    assert pins, "expected a pinned @vX.Y.Z manual-install hint in SKILL.md"
    for p in pins:
        assert p == _pyproject_version(), f"SKILL.md install pin @v{p} is stale"


def test_readme_install_pin_matches_version():
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    pins = re.findall(r'claude-review@v([0-9][^`)\s]*)', readme)
    assert pins, "expected a pinned @vX.Y.Z install command in README"
    for p in pins:
        assert p == _pyproject_version(), f"README install pin @v{p} is stale — bump it with the release"


def write_jsonl(path, events):
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")


def user(text):
    return {"type": "user", "message": {"content": text}}


def assistant(blocks, model="claude-opus-4-8"):
    return {"type": "assistant", "message": {"model": model, "content": blocks}}


def text_block(t):
    return {"type": "text", "text": t}


def tool_block(name, **inp):
    return {"type": "tool_use", "name": name, "input": inp}


# --------------------------------------------------------------------------- parse_turn
def test_basic_turn(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("first question"),
        assistant([text_block("first answer")]),
        user("the real question"),
        assistant([text_block("the latest answer")], model="claude-sonnet-4-6"),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["question"] == "the real question"
    assert turn["text"] == "the latest answer"
    assert turn["model"] == "claude-sonnet-4-6"


def test_only_last_text_block_is_the_response(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q"),
        assistant([text_block("interim narration")]),
        assistant([text_block("final answer")]),
    ])
    assert cr.parse_turn(str(f))["text"] == "final answer"


def test_new_prompt_resets_text_and_plan_but_keeps_model(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"),
        assistant([tool_block("ExitPlanMode", plan="a plan"), text_block("a1")]),
        user("q2"),
        assistant([text_block("a2")]),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["question"] == "q2"
    assert turn["text"] == "a2"
    assert turn["plan"] is None          # plan from the previous turn was reset


def test_exit_plan_mode_captured(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("plan something"),
        assistant([tool_block("ExitPlanMode", plan="## Steps\n1. do it")]),
    ])
    assert cr.parse_turn(str(f))["plan"] == "## Steps\n1. do it"


def test_tasks_replayed_create_update_delete(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("do work"),
        assistant([
            tool_block("TaskCreate", subject="task one"),
            tool_block("TaskCreate", subject="task two"),
            tool_block("TaskCreate", subject="task three"),
        ]),
        assistant([
            tool_block("TaskUpdate", taskId="1", status="in_progress"),
            tool_block("TaskUpdate", taskId="2", status="completed"),
            tool_block("TaskUpdate", taskId="3", status="deleted"),
        ]),
    ])
    tasks = cr.parse_turn(str(f))["tasks"]
    assert tasks == [
        {"status": "in_progress", "content": "task one"},
        {"status": "completed", "content": "task two"},
    ]  # task three deleted; ids preserve creation order


def test_task_update_can_change_subject(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q"),
        assistant([tool_block("TaskCreate", subject="old")]),
        assistant([tool_block("TaskUpdate", taskId="1", subject="new", status="completed")]),
    ])
    assert cr.parse_turn(str(f))["tasks"] == [{"status": "completed", "content": "new"}]


def test_tasks_persist_across_a_new_prompt(tmp_path):
    # tasks are session-wide state; a new user prompt must NOT clear them.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"),
        assistant([tool_block("TaskCreate", subject="lingering task")]),
        user("q2"),
        assistant([text_block("answer 2")]),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["question"] == "q2"
    assert turn["tasks"] == [{"status": "pending", "content": "lingering task"}]


def test_malformed_lines_are_skipped(tmp_path):
    f = tmp_path / "s.jsonl"
    f.write_text(
        json.dumps(user("q")) + "\n"
        + "this is not json {{{\n"
        + json.dumps(assistant([text_block("survived")])) + "\n",
        encoding="utf-8",
    )
    assert cr.parse_turn(str(f))["text"] == "survived"


def test_no_assistant_text_yields_none(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [user("q"), assistant([tool_block("Bash", command="ls")])])
    assert cr.parse_turn(str(f))["text"] is None


# --------------------------------------------------------------------------- format drift
def test_known_schema_is_not_flagged_as_drift(tmp_path):
    # a tool-only assistant turn parses fine (tool_use is recognized) -> no drift
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [user("q"), assistant([tool_block("Bash", command="ls")])])
    assert cr.parse_turn(str(f))["format_drift"] is False


def test_unrecognized_content_blocks_flag_drift(tmp_path):
    # assistant record present, but no content block matches the known schema
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q"),
        {"type": "assistant", "message": {"model": "claude-x",
            "content": [{"type": "some_future_block", "data": "???"}]}},
    ])
    assert cr.parse_turn(str(f))["format_drift"] is True


def test_no_assistant_records_is_not_drift(tmp_path):
    # only a user prompt so far -> not drift, just nothing yet
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [user("q")])
    assert cr.parse_turn(str(f))["format_drift"] is False


def test_drift_banner_only_when_idle(tmp_path):
    # format_drift + stale file -> drift banner; format_drift + live file -> the
    # normal "working" message (don't cry wolf mid-stream).
    drift_turn = {"plan": None, "text": None, "tasks": None,
                  "format_drift": True, "mtime": 0}                 # ancient -> idle
    label, renderable = cr.build_surfaces(drift_turn)[0]
    assert "format not recognized" in renderable.plain.lower()

    live_turn = dict(drift_turn, mtime=cr.time.time())             # fresh -> live
    _, renderable = cr.build_surfaces(live_turn)[0]
    assert "claude is working" in renderable.plain.lower()


# --------------------------------------------------------------------------- copy / yank
def test_surface_raw_text_picks_the_right_source():
    turn = {"text": "the response", "plan": "the plan",
            "tasks": [{"status": "completed", "content": "did a thing"},
                      {"status": "pending", "content": "next thing"}]}
    assert cr._surface_raw_text(turn, "response") == "the response"
    assert cr._surface_raw_text(turn, "plan") == "the plan"
    assert "did a thing" in cr._surface_raw_text(turn, "tasks")
    assert "[pending] next thing" in cr._surface_raw_text(turn, "tasks")


def test_surface_raw_text_handles_missing_surfaces():
    assert cr._surface_raw_text({"text": None, "plan": None, "tasks": None}, "response") == ""
    assert cr._surface_raw_text({"text": None, "plan": None, "tasks": None}, "plan") == ""
    assert cr._surface_raw_text({"text": None, "plan": None, "tasks": None}, "tasks") == ""


def test_copy_to_clipboard_emits_osc52(capsys):
    import base64
    assert cr.copy_to_clipboard("hello world") == "ok"
    out = capsys.readouterr().out
    assert out.startswith("\x1b]52;c;") and out.endswith("\x07")
    payload = out[len("\x1b]52;c;"):-1]
    assert base64.b64decode(payload).decode() == "hello world"


def test_copy_to_clipboard_empty_is_noop(capsys):
    assert cr.copy_to_clipboard("") == "empty"
    assert capsys.readouterr().out == ""    # nothing emitted, so caller can flash a hint


def test_copy_to_clipboard_oversize_is_not_a_false_ok(capsys):
    # past the OSC 52 soft limit many terminals silently drop the payload — we
    # must NOT emit and NOT claim success, so the caller can flash an honest note.
    big = "x" * (cr._OSC52_SOFT_LIMIT + 1)
    assert cr.copy_to_clipboard(big) == "too_large"
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------- is_real_prompt
@pytest.mark.parametrize("content,expected", [
    ("a genuine question", True),
    ("   ", False),
    ("", False),
    ("<command-name>/foo</command-name>", False),
    ("  <local-command-stdout>x</local-command-stdout>", False),
    ([{"type": "tool_result", "content": "x"}], False),
    (None, False),
])
def test_is_real_prompt(content, expected):
    assert cr.is_real_prompt(content) is expected


# --------------------------------------------------------------------------- tail_lines
def test_tail_lines_drops_leading_partial_when_truncated(tmp_path):
    f = tmp_path / "big.jsonl"
    # three lines, each well over a tiny nbytes window
    lines = [json.dumps({"type": "user", "message": {"content": "x" * 200}}) for _ in range(3)]
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    got = cr.tail_lines(str(f), nbytes=250)   # forces truncation mid-file
    # the first (partial) line is dropped; remaining lines are intact JSON
    assert all(json.loads(l) for l in got)
    assert len(got) < 3


def test_tail_lines_keeps_all_when_under_limit(tmp_path):
    f = tmp_path / "small.jsonl"
    write_jsonl(f, [user("a"), user("b")])
    assert len(cr.tail_lines(str(f), nbytes=1_000_000)) == 2


def test_tail_lines_missing_file_returns_empty():
    assert cr.tail_lines("/nonexistent/path/x.jsonl") == []


# --------------------------------------------------------------------------- formatters
@pytest.mark.parametrize("secs,out", [
    (0, "0s"), (59, "59s"), (60, "1m"), (3599, "59m"),
    (3600, "1h"), (86399, "23h"), (86400, "1d"), (172800, "2d"),
])
def test_fmt_age(secs, out):
    assert cr.fmt_age(secs) == out


def test_short_model():
    assert cr.short_model("claude-opus-4-8") == "opus-4-8"
    assert cr.short_model(None) == "?"
    assert cr.short_model("claude-sonnet-4-6-20251001").startswith("sonnet-4-6")


def test_oneline_strips_control_chars():
    # ESC, tab, newline, bell -> spaces; printable chars (incl. the literal
    # "[31m" that follows a stripped ESC) are preserved.
    assert cr.oneline("a\x1b[31mb\tc\nd") == "a [31mb c d"
    cleaned = cr.oneline("x\x1by\x07z")
    assert "\x1b" not in cleaned and "\x07" not in cleaned
    assert cleaned == "x y z"


def test_oneline_handles_none():
    assert cr.oneline(None) == ""


# --------------------------------------------------------------------------- slug encoding
# _encode_path is pure (no filesystem) and takes an already-absolute path, so the
# same assertions hold on Linux, macOS, AND Windows runners — this is the row of
# the compat matrix that the OS matrix in CI is meant to keep honest.
# The rule mirrors Claude Code's gM(): EVERY non-alphanumeric -> '-', case kept.
@pytest.mark.parametrize("abs_path,slug", [
    ("/home/u/myrepo", "-home-u-myrepo"),
    ("/home/u/my.app", "-home-u-my-app"),                            # '.' -> '-'
    ("/home/u/repo/.claude/skills", "-home-u-repo--claude-skills"),  # '.claude' -> '--claude'
    ("/home/u/a project", "-home-u-a-project"),                      # space -> '-'
    # EVERY non-alphanumeric collapses — incl. '_', '+', '~', '@', parens (matches
    # Claude Code; the earlier "underscore preserved" assumption was WRONG).
    ("/home/u/my_repo2", "-home-u-my-repo2"),
    ("/home/u/node_modules/x", "-home-u-node-modules-x"),
    ("/home/u/a+b/c~d", "-home-u-a-b-c-d"),
    ("/home/u/My.App_v2", "-home-u-My-App-v2"),                      # case preserved
    # Windows: backslash separators + drive ':' both map to '-'
    (r"C:\Users\you\repo", "C--Users-you-repo"),
    (r"C:\Users\a b\my.app", "C--Users-a-b-my-app"),
])
def test_encode_path_cross_os(abs_path, slug):
    assert cr._encode_path(abs_path) == slug


def test_encode_cwd_matches_real_machine_rule(monkeypatch):
    # encode_cwd runs abspath on THIS OS; on POSIX an absolute path is unchanged.
    monkeypatch.setattr(cr.os.path, "abspath", lambda p: p)
    assert cr.encode_cwd("/home/u/my.app") == "-home-u-my-app"
    assert cr.encode_cwd("/home/u/my_repo") == "-home-u-my-repo"   # '_' collapses too


def test_resolve_proj_explicit_slug_joins_under_proj_root():
    assert cr.resolve_proj("-home-u-other") == cr.os.path.join(cr.PROJ_ROOT, "-home-u-other")


def test_resolve_proj_derives_slug_from_cwd(monkeypatch, tmp_path):
    # Use a real existing dir so the fast-path os.path.isdir check passes and we
    # don't fall through to the transcript scan. Build the matching slug dir.
    monkeypatch.setattr(cr, "PROJ_ROOT", str(tmp_path))
    here = tmp_path / "work"
    here.mkdir()
    # Resolve ONCE up front: on Windows Path.resolve()/abspath call os.getcwd()
    # internally, so a getcwd patch that itself calls resolve() recurses forever.
    here_abs = str(here.resolve())
    slug = cr._encode_path(here_abs)
    (tmp_path / slug).mkdir()
    monkeypatch.setattr(cr.os, "getcwd", lambda: here_abs)
    assert cr.resolve_proj(None) == cr.os.path.join(str(tmp_path), slug)


# --------------------------------------------------------------------------- list-shaped prompts
def user_blocks(blocks):
    """A user record whose content is a block-list (resume / attachment / skill)."""
    return {"type": "user", "message": {"content": blocks}}


def test_list_shaped_prompt_is_recognized(tmp_path):
    # --continue / auto-compact resume writes the prompt as a text block-list, not
    # a bare string. It must be treated as a real prompt (and reset text/plan), or
    # the pane shows the PREVIOUS turn's question against a stale answer.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("first question"),
        assistant([text_block("first answer")]),
        user_blocks([{"type": "text", "text": "Continue from where you left off."}]),
        assistant([text_block("resumed answer")]),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["question"] == "Continue from where you left off."
    assert turn["text"] == "resumed answer"


def test_list_prompt_ignores_tool_result_and_wrapper_blocks(tmp_path):
    # a tool_result block-list, or one whose text is a '<...>' wrapper, is NOT a
    # user prompt — must not clobber the real question.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("the real question"),
        assistant([text_block("the answer")]),
        user_blocks([{"type": "tool_result", "content": "ok"}]),
    ])
    assert cr.parse_turn(str(f))["question"] == "the real question"


@pytest.mark.parametrize("content,expected", [
    ([{"type": "text", "text": "hello"}], True),
    ([{"type": "text", "text": "  <command>/x</command>"}], False),
    ([{"type": "tool_result", "content": "x"}], False),
    ([{"type": "image", "source": {}}], False),
    ([], False),
])
def test_is_real_prompt_list_forms(content, expected):
    assert cr.is_real_prompt(content) is expected


# --------------------------------------------------------------------------- resilience to junk records
def test_non_dict_json_line_does_not_crash_parse(tmp_path):
    # a valid-JSON but non-object line (or explicit "message": null) must not take
    # down the whole parse — it should be skipped like malformed lines.
    f = tmp_path / "s.jsonl"
    f.write_text(
        "42\n"
        + '"a bare string line"\n'
        + json.dumps({"type": "user", "message": None}) + "\n"
        + json.dumps(user("q")) + "\n"
        + json.dumps(assistant([text_block("survived")])) + "\n",
        encoding="utf-8",
    )
    turn = cr.parse_turn(str(f))
    assert turn["question"] == "q"
    assert turn["text"] == "survived"


# --------------------------------------------------------------------------- body sanitizing
def test_sanitize_body_strips_escape_but_keeps_structure():
    # ESC (and the OSC 52 clipboard-hijack sequence) must be stripped from the
    # rendered body, but newlines and tabs that carry Markdown structure survive.
    raw = "line one\n\tindented\n\x1b]52;c;ZXZpbA==\x07plus \x1b[31mred\x1b[0m"
    out = cr.sanitize_body(raw)
    assert "\x1b" not in out and "\x07" not in out
    assert "\n" in out and "\t" in out          # structure preserved
    assert "line one" in out and "indented" in out and "plus" in out


def test_sanitize_body_handles_empty():
    assert cr.sanitize_body("") == ""
    assert cr.sanitize_body(None) is None


def test_build_surfaces_sanitizes_response_and_plan():
    # the surfaces handed to rich must already be escape-free.
    turn = {"plan": "p\x1blan", "text": "te\x1bxt", "tasks": None,
            "format_drift": False, "mtime": cr.time.time()}
    surfaces = dict((lbl, r) for lbl, r in cr.build_surfaces(turn))
    # rich Markdown stores the source on .markup
    assert "\x1b" not in surfaces["plan"].markup
    assert "\x1b" not in surfaces["response"].markup


# --------------------------------------------------------------------------- task reconstruction
def test_tasks_reconstructed_from_whole_file_not_tail(tmp_path):
    # ids are assigned from the START of the session, so even if the creating
    # records fall outside a small tail window, TaskUpdate must still hit the right
    # row. parse_turn reads tasks over the whole file, so a huge filler turn in
    # between must not renumber tasks.
    f = tmp_path / "s.jsonl"
    filler = assistant([text_block("x" * 2000)])
    events = [
        user("do work"),
        assistant([
            tool_block("TaskCreate", subject="task one"),
            tool_block("TaskCreate", subject="task two"),
        ]),
    ]
    events += [filler] * 400                      # push creates far past a tail window
    events += [
        user("later"),
        assistant([tool_block("TaskUpdate", taskId="2", status="completed")]),
    ]
    write_jsonl(f, events)
    tasks = cr.parse_turn(str(f))["tasks"]
    assert tasks == [
        {"status": "pending", "content": "task one"},
        {"status": "completed", "content": "task two"},   # #2 hit correctly
    ]


def test_task_batch_shape_is_expanded(tmp_path):
    # the batch TaskCreate carries a JSON-STRING array under "tasks".
    f = tmp_path / "s.jsonl"
    batch = json.dumps([
        {"content": "first", "status": "in_progress"},
        {"content": "second", "status": "pending"},
    ])
    write_jsonl(f, [
        user("q"),
        assistant([{"type": "tool_use", "name": "TaskCreate", "input": {"tasks": batch}}]),
    ])
    assert cr.parse_turn(str(f))["tasks"] == [
        {"status": "in_progress", "content": "first"},
        {"status": "pending", "content": "second"},
    ]


def test_subagent_spawn_taskcreate_is_not_a_todo(tmp_path):
    # a TaskCreate carrying subagent_type/prompt is a subagent spawn, not a
    # todo-list entry — it must not inject a blank row or shift the id counter.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q"),
        assistant([
            tool_block("TaskCreate", subject="real todo"),
            {"type": "tool_use", "name": "TaskCreate",
             "input": {"subagent_type": "general-purpose", "prompt": "go"}},
        ]),
        assistant([tool_block("TaskUpdate", taskId="1", status="completed")]),
    ])
    # only the real todo exists, and it's still id 1 (spawn didn't consume an id)
    assert cr.parse_turn(str(f))["tasks"] == [{"status": "completed", "content": "real todo"}]


# --------------------------------------------------------------------------- unicode line separators
def test_tail_lines_does_not_split_on_unicode_separators(tmp_path):
    # Node's JSON.stringify does NOT escape U+2028 (LS), U+2029 (PS), or U+0085
    # (NEL), so a record whose text contains one must survive as ONE line. Python's
    # str.splitlines() breaks on all three (and VT/FF/FS/GS/RS), which would shatter
    # the JSON record into invalid fragments and lose the response entirely.
    # split("\n") (what tail_lines now uses) only breaks on real newlines.
    f = tmp_path / "s.jsonl"
    body = "para one\u2028para two\u2029next\u0085tail\x0bvtab"
    f.write_text(
        json.dumps(user("q")) + "\n"
        + json.dumps(assistant([text_block(body)])) + "\n",
        encoding="utf-8",
    )
    assert cr.parse_turn(str(f))["text"] == body

# --------------------------------------------------------------------------- turn_sig
def test_turn_sig_changes_when_response_changes(tmp_path):
    base = {"question": "q", "text": "a", "plan": None, "tasks": None}
    other = dict(base, text="b")
    assert cr.turn_sig(base) != cr.turn_sig(other)
    assert cr.turn_sig(base) == cr.turn_sig(dict(base))
