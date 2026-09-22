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


def test_cleanroom_default_ref_matches_version():
    sh = (_ROOT / "tests/cleanroom.sh").read_text(encoding="utf-8")
    m = re.search(r'CRV_REF="\$\{CRV_REF:-v([^}]+)\}"', sh)
    assert m, "expected a CRV_REF default in tests/cleanroom.sh"
    assert m.group(1) == _pyproject_version(), f"cleanroom.sh default ref v{m.group(1)} is stale — bump it with the release"


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


# --------------------------------------------------------------------------- AskUserQuestion
# AskUserQuestion carries the ENTIRE message (question + options) inside the tool
# input, with no sibling text block. Without a dedicated branch the pane showed
# the previous turn's stale text — or went blank — while Claude was blocked on a
# choice. These lock in that the question becomes a first-class surface.
def _ask_block(*questions):
    return tool_block("AskUserQuestion", questions=list(questions))


def test_ask_user_question_becomes_a_surface(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("give me the options again"),
        assistant([_ask_block({
            "header": "URL fix",
            "question": "How should the TLDR handle URLs?",
            "options": [
                {"label": "Mask + splice", "description": "guarantees a live link"},
                {"label": "Prompt only", "description": "cheaper, less robust"},
            ],
        })]),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["ask"] is not None
    assert "How should the TLDR handle URLs?" in turn["ask"]
    assert "Mask + splice" in turn["ask"] and "guarantees a live link" in turn["ask"]
    # it leads as the primary surface (labelled "question")
    labels = [lbl for lbl, _ in cr.build_surfaces(turn)]
    assert labels[0] == "question"


def test_ask_leads_over_stale_prior_text(tmp_path):
    # a prior-turn answer must NOT mask the question Claude is now blocked on.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("do the thing"),
        assistant([text_block("Here's the analysis, but it decides the fix:")]),
        assistant([_ask_block({"header": "Pick", "question": "Which way?",
                               "options": [{"label": "A", "description": "first"}]})]),
    ])
    turn = cr.parse_turn(str(f))
    labels = [lbl for lbl, _ in cr.build_surfaces(turn)]
    assert labels[0] == "question"          # question first, stale text demoted
    assert "response" in labels             # the prior text is still available as a tab
    assert turn["text"] == "Here's the analysis, but it decides the fix:"


def test_ask_resets_on_a_new_prompt(tmp_path):
    # once answered, a new user prompt clears the question like text/plan.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"),
        assistant([_ask_block({"header": "H", "question": "old question?",
                               "options": [{"label": "x", "description": "y"}]})]),
        user("A"),
        assistant([text_block("moving on")]),
    ])
    turn = cr.parse_turn(str(f))
    assert turn["ask"] is None
    assert turn["text"] == "moving on"


def test_ask_multi_question(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q"),
        assistant([_ask_block(
            {"header": "One", "question": "first?", "options": [{"label": "a", "description": "d"}]},
            {"header": "Two", "question": "second?", "options": [{"label": "b", "description": "e"}], "multiSelect": True},
        )]),
    ])
    ask = cr.parse_turn(str(f))["ask"]
    assert "first?" in ask and "second?" in ask
    assert "select all that apply" in ask     # multiSelect hint rendered


def test_ask_empty_input_is_ignored(tmp_path):
    # a malformed/empty AskUserQuestion must not create a blank surface.
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [user("q"), assistant([tool_block("AskUserQuestion", questions=[])])])
    turn = cr.parse_turn(str(f))
    assert turn["ask"] is None


def test_surface_raw_text_yanks_the_question(tmp_path):
    turn = {"ask": "### H\n\nWhich way?", "text": "", "plan": "", "tasks": []}
    assert cr._surface_raw_text(turn, "question") == "### H\n\nWhich way?"


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
def test_records_do_not_split_on_unicode_separators(tmp_path):
    # Node's JSON.stringify does NOT escape U+2028 (LS), U+2029 (PS), or U+0085
    # (NEL), so a record whose text contains one must survive as ONE line. Python's
    # str.splitlines() breaks on all three (and VT/FF/FS/GS/RS), which would shatter
    # the JSON record into invalid fragments and lose the response entirely.
    # split("\n") (what _split_records uses) only breaks on real newlines.
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


# --------------------------------------------------------------------------- turn history (←/→)
def test_parse_turn_exposes_full_history(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"), assistant([text_block("a1")]),
        user("q2"), assistant([tool_block("ExitPlanMode", plan="p2")]),
        user("q3"), assistant([text_block("interim")]), assistant([text_block("a3")]),
    ])
    st = cr.parse_turn(str(f))
    assert [t["question"] for t in st["turns"]] == ["q1", "q2", "q3"]
    assert [t["text"] for t in st["turns"]] == ["a1", None, "a3"]
    assert st["turns"][1]["plan"] == "p2"
    assert st["text"] == "a3" and st["question"] == "q3"   # latest is unchanged


def test_turn_at_views_an_earlier_turn_with_prompt_and_no_tasks(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"), assistant([text_block("a1")]),
        assistant([tool_block("TaskCreate", subject="do it")]),
        user("q2"), assistant([text_block("a2")]),
    ])
    st = cr.parse_turn(str(f))
    old = cr.turn_at(st, 0)
    assert old["historical"] is True
    assert old["question"] == "q1" and old["text"] == "a1"
    assert old["tasks"] == []                    # session-wide tasks only on the latest
    assert cr._surface_raw_text(old, "response") == "a1"
    latest = cr.turn_at(st, 1)
    assert latest["historical"] is False and latest["text"] == "a2"
    assert latest["tasks"]                       # the task list rides the latest turn
    assert cr.turn_at(st, 99)["text"] == "a2"    # index is clamped
    assert cr.turn_at(st, -5)["text"] == "a1"


def test_historical_turn_without_text_is_not_reported_as_working(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("q1"), assistant([tool_block("Bash", command="ls")]),
        user("q2"), assistant([text_block("a2")]),
    ])
    st = cr.parse_turn(str(f))
    surfaces = cr.build_surfaces(cr.turn_at(st, 0))
    assert surfaces[0][0] == "waiting"
    assert "no response text" in surfaces[0][1].plain
    assert "working" not in surfaces[0][1].plain


def test_assistant_text_before_any_prompt_forms_its_own_turn(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [assistant([text_block("orphan")]), user("q1"), assistant([text_block("a1")])])
    st = cr.parse_turn(str(f))
    assert [(t["question"], t["text"]) for t in st["turns"]] == [(None, "orphan"), ("q1", "a1")]


def test_is_meta_user_records_do_not_split_a_turn(tmp_path):
    f = tmp_path / "s.jsonl"
    write_jsonl(f, [
        user("look at the image"),
        assistant([text_block("on it")]),
        {"type": "user", "isMeta": True, "message": {"content": "[Image: original 1200x800]"}},
        {"type": "user", "isMeta": True,
         "message": {"content": [{"type": "text", "text": "Base directory for this skill: /x"}]}},
        assistant([text_block("the analysis")]),
    ])
    st = cr.parse_turn(str(f))
    assert len(st["turns"]) == 1
    assert st["question"] == "look at the image" and st["text"] == "the analysis"


# --------------------------------------------------------------------------- footer + ? overlay
def _screen_text(turn, **kw):
    import shutil, os as _os
    from rich.console import Console
    real = shutil.get_terminal_size
    shutil.get_terminal_size = lambda *a, **k: _os.terminal_size((100, 30))
    try:
        surfaces = cr.build_surfaces(turn)
        screen, _ = cr.render_screen(turn, surfaces, 0, 0, **kw)
    finally:
        shutil.get_terminal_size = real
    c = Console(width=100, record=True, force_terminal=False)
    c.print(screen)
    return c.export_text()


def test_footer_is_state_plus_three_cues(tmp_path):
    f = tmp_path / "abcdef12-3456.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")]), user("q2"), assistant([text_block("a2")])])
    st = cr.parse_turn(str(f))
    foot = _screen_text(cr.turn_at(st, 1), nav={"index": 1, "count": 2, "new": False}).splitlines()[-1]
    assert "f freeze" in foot and "←→ turns" in foot and "? more" in foot
    for gone in ("y copy", "s switch", "q quit", "↑↓ scroll", st["id"][:8], "1/2"):
        assert gone not in foot
    single = _screen_text(cr.turn_at(st, 1), nav={"index": 0, "count": 1, "new": False}).splitlines()[-1]
    assert "←→ turns" not in single


def test_help_overlay_lists_every_key_and_the_session(tmp_path):
    f = tmp_path / "abcdef12-3456.jsonl"
    write_jsonl(f, [{"type": "user", "cwd": "/home/me/proj", "message": {"content": "q"}},
                    assistant([text_block("a")], model="claude-opus-4-8")])
    st = cr.parse_turn(str(f))
    out = _screen_text(cr.turn_at(st, 0), help=True)
    for k, d in cr.HELP_KEYS:
        assert d.split(";")[0] in out
    assert st["id"] in out and "opus-4-8" in out and "/home/me/proj" in out
    assert "? close" in out.splitlines()[-1]
    assert "the analysis" not in out                    # body is replaced, not appended


# --------------------------------------------------------------------------- review() loop (fake input)
class _Keys:
    """Scripted RawInput: each get() pops the next key; None = a quiet poll tick.
    A callable entry runs a side effect (e.g. append to the transcript) and
    counts as a quiet tick."""
    def __init__(self, keys):
        self._keys = list(keys)
    def get(self, timeout):
        if not self._keys:
            return "q"
        k = self._keys.pop(0)
        if callable(k):
            k()
            return None
        return k


class _NoLive:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def update(self, *a, **k): pass


def _drive(monkeypatch, path, keys):
    """Run review() headless with scripted keys; return every (turn, nav, frozen,
    help) render_screen saw, in order."""
    seen = []
    real = cr.render_screen
    def spy(turn, surfaces, active, scroll, **kw):
        seen.append({"turn": turn, "nav": kw.get("nav"), "frozen": kw.get("frozen"), "help": kw.get("help")})
        return real(turn, surfaces, active, scroll, **kw)
    monkeypatch.setattr(cr, "render_screen", spy)
    monkeypatch.setattr(cr, "Live", _NoLive)
    monkeypatch.setattr(cr, "_emit", lambda seq: None)
    monkeypatch.setattr(cr.shutil, "get_terminal_size", lambda *a, **k: __import__("os").terminal_size((90, 24)))
    monkeypatch.setattr(cr, "POLL", 0)
    assert cr.review(str(path), _Keys(keys)) == "quit"
    return seen


def _append(path, events):
    import time, os
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(e) for e in events) + "\n")
    # force a visible mtime change even on coarse filesystems
    st = os.stat(path); os.utime(path, (st.st_atime, st.st_mtime + 2))


def test_review_follows_live_and_r_returns_to_latest_after_freeze(tmp_path, monkeypatch):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")]), user("q2"), assistant([text_block("a2")])])
    frames = _drive(monkeypatch, f, [
        "f",                                                   # freeze on a2
        lambda: _append(f, [user("q3")]),                      # a prompt lands: NOT a new reply
        None,
        lambda: _append(f, [assistant([text_block("a3")])]),   # the reply lands
        None,
        "r",                                                   # unfreeze + back to latest
        None,
    ])
    texts = [(fr["turn"]["text"], fr["frozen"], fr["nav"]["behind"]) for fr in frames]
    # frozen view holds a2; the prompt alone does not flag; the reply does; r lands on a3
    assert texts[1] == ("a2", True, False)          # after f
    assert texts[3] == ("a2", True, False)          # q3 landed, still no reply -> no flag
    assert texts[5] == ("a2", True, True)           # a3 landed -> "new reply"
    assert texts[-1] == ("a3", False, False)        # r: on the latest, following again


def test_review_history_holds_and_flags_only_a_real_reply(tmp_path, monkeypatch):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")]), user("q2"), assistant([text_block("a2")])])
    frames = _drive(monkeypatch, f, [
        "left",                                                # back to a1
        lambda: _append(f, [user("q3"), assistant([tool_block("Bash", command="ls")])]),
        None,                                                  # prompt + tool call: no reply yet
        lambda: _append(f, [assistant([text_block("a3")])]),
        None,
        "right", "right",                                      # step forward to the latest
    ])
    view = [(fr["turn"]["text"], fr["nav"]["behind"], fr["nav"]["count"]) for fr in frames]
    assert view[1] == ("a1", False, 2)
    assert view[3] == ("a1", False, 3)              # q3 + tool call landed: not flagged
    assert view[5] == ("a1", True, 3)               # a3 landed: flagged
    assert view[-1] == ("a3", False, 3)             # caught up, flag cleared


def test_review_help_overlay_scrolls_and_closes(tmp_path, monkeypatch):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")])])
    frames = _drive(monkeypatch, f, ["?", "j", "x"])
    assert [fr["help"] for fr in frames] == [False, True, True, False]


# --------------------------------------------------------------------------- incremental records
def test_records_are_read_incrementally_on_append(tmp_path):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")])])
    assert cr.parse_turn(str(f))["text"] == "a1"
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(user("q2")) + "\n" + json.dumps(assistant([text_block("a2")])) + "\n")
    st = cr.parse_turn(str(f))
    assert [t["text"] for t in st["turns"]] == ["a1", "a2"]
    assert cr._RECORDS[str(f)]["size"] == f.stat().st_size


def test_records_cache_resets_when_file_shrinks_or_is_rewritten(tmp_path):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1"), assistant([text_block("a1")]), user("q2"), assistant([text_block("a2")])])
    assert len(cr.parse_turn(str(f))["turns"]) == 2
    write_jsonl(f, [user("only"), assistant([text_block("one")])])          # shorter: rewrite
    assert [t["text"] for t in cr.parse_turn(str(f))["turns"]] == ["one"]
    write_jsonl(f, [user("zz"), assistant([text_block("different head, same length-ish")])])
    assert cr.parse_turn(str(f))["question"] == "zz"                         # head changed: rewrite


def test_partial_trailing_line_is_not_consumed_until_complete(tmp_path):
    f = tmp_path / "abcdef12-0000.jsonl"
    write_jsonl(f, [user("q1")])
    cr.parse_turn(str(f))
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(assistant([text_block("partial")]))[:20])   # mid-write
    assert cr.parse_turn(str(f))["text"] is None
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(assistant([text_block("partial")]))[20:] + "\n")
    assert cr.parse_turn(str(f))["text"] == "partial"
