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
@pytest.mark.parametrize("abs_path,slug", [
    # POSIX: '/' and '.' both collapse to '-' (the original bug missed '.')
    ("/home/u/myrepo", "-home-u-myrepo"),
    ("/home/u/my.app", "-home-u-my-app"),
    ("/home/u/repo/.claude/skills", "-home-u-repo--claude-skills"),  # '.claude' -> '--claude'
    ("/home/u/a project", "-home-u-a-project"),                      # space -> '-'
    # underscores and digits are PRESERVED (the regression we avoided)
    ("/home/u/my_repo2", "-home-u-my_repo2"),
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


# --------------------------------------------------------------------------- turn_sig
def test_turn_sig_changes_when_response_changes(tmp_path):
    base = {"question": "q", "text": "a", "plan": None, "tasks": None}
    other = dict(base, text="b")
    assert cr.turn_sig(base) != cr.turn_sig(other)
    assert cr.turn_sig(base) == cr.turn_sig(dict(base))
