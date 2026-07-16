#!/usr/bin/env bash
# setup.sh — ensure `claude-review` is installed and runnable.
#
# Idempotent and fast (instant if already present). Invoked by the review-pane
# skill's "Detect and prepare" step. Safe to run repeatedly.
#
# Contract: stdout's FINAL line is a machine-readable status (grep it); all
# progress chatter goes to stderr.
#   SETUP_OK <version>             installed & runnable on PATH
#   SETUP_PATH_INACTIVE <version>  installed, but ~/.local/bin not on this PATH
#   SETUP_FAIL <reason>            could not install
#
# Install strategy (first that works wins), chosen to NOT mutate the system
# Python by default:
#   1. already on PATH                         -> done
#   2. pipx (isolated venvs)                   -> from local clone, else pinned GitHub
#   3. a private venv at ~/.local/share/...    -> symlink entrypoint into ~/.local/bin
# The PEP-668 `--break-system-packages` path is OFF by default and only used when
# CLAUDE_REVIEW_ALLOW_BREAK_SYSTEM=1 is set (it writes to the system interpreter's
# user-site, which PEP 668 deliberately guards).

set -uo pipefail

LOCAL_BIN="$HOME/.local/bin"
VENV_DIR="$HOME/.local/share/claude-review-venv"
PIN="v0.4.1"                                   # pin the GitHub install to a release
REPO_GIT="git+https://github.com/r3al1tym/claude-review@${PIN}"
NET_TIMEOUT=120                                # wall-clock bound on any network install
ALLOW_BREAK="${CLAUDE_REVIEW_ALLOW_BREAK_SYSTEM:-}"

have() { command -v "$1" >/dev/null 2>&1; }
log()  { echo "$@" >&2; }
fail() { echo "SETUP_FAIL $1"; exit 1; }

# run a command with a wall-clock timeout if `timeout` exists, else plain
run_bounded() { if have timeout; then timeout "$NET_TIMEOUT" "$@"; else "$@"; fi; }

# version string, always non-empty (keeps the STATUS line two-token / grep-able)
crv_version() {
  local bin="$1" v
  v="$("$bin" -V 2>/dev/null | awk '{print $2}')"
  echo "${v:-unknown}"
}

verify() {
  if have claude-review; then
    echo "SETUP_OK $(crv_version claude-review)"; return 0
  fi
  if [ -x "$LOCAL_BIN/claude-review" ]; then
    echo "SETUP_PATH_INACTIVE $(crv_version "$LOCAL_BIN/claude-review")"
    log "  -> add to PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"  (also append to ~/.bashrc or ~/.zshrc)"
    return 0
  fi
  return 1
}

# Resolve the repo root if run from inside a clone (preferred: local & offline).
script_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd; }
repo_root() {
  local d; d="$(script_dir)"
  for up in "$d/.." "$d/../.." "$d/../../.." "$d/../../../.."; do
    # heuristic, not a parser: tolerate spacing, require the literal package name.
    if [ -f "$up/pyproject.toml" ] \
       && grep -Eq '^[[:space:]]*name[[:space:]]*=[[:space:]]*"claude-review"' "$up/pyproject.toml" 2>/dev/null; then
      (cd "$up" && pwd); return 0
    fi
  done
  return 1
}

# 1. Already good?
if verify; then exit 0; fi

log "claude-review not found — installing…"

# Choose an install source: local clone (offline, best) else pinned GitHub.
if root="$(repo_root)"; then SRC="$root"; log "  source: local clone $root (offline)"
else SRC="$REPO_GIT"; log "  source: $REPO_GIT"; fi

# 2. Prefer pipx (isolated venvs, no system-Python mutation).
if ! have pipx && have apt-get; then
  log "  trying distro pipx (apt-get)…"
  run_bounded sudo -n apt-get install -y pipx >/dev/null 2>&1 || true
fi
if have pipx || python3 -m pipx --version >/dev/null 2>&1; then
  PIPX="pipx"; have pipx || PIPX="python3 -m pipx"
  log "  installing via pipx…"
  run_bounded $PIPX install "$SRC" >/dev/null 2>&1 || run_bounded $PIPX install --force "$SRC" >/dev/null 2>&1
  python3 -m pipx ensurepath >/dev/null 2>&1 || true
  if verify; then exit 0; fi
fi

# 3. Private venv — isolated, never touches the system interpreter.
log "  pipx unavailable — building an isolated venv at $VENV_DIR…"
if python3 -m venv "$VENV_DIR" >/dev/null 2>&1; then
  run_bounded "$VENV_DIR/bin/pip" install --upgrade pip >/dev/null 2>&1 || true
  if run_bounded "$VENV_DIR/bin/pip" install "$SRC" >/dev/null 2>&1; then
    mkdir -p "$LOCAL_BIN"
    ln -sf "$VENV_DIR/bin/claude-review" "$LOCAL_BIN/claude-review"
    if verify; then exit 0; fi
  fi
fi

# 4. Last resort: pip --user, and only break system packages with explicit opt-in.
log "  venv route failed — trying pip --user…"
run_bounded python3 -m pip install --user "$SRC" >/dev/null 2>&1
if verify; then exit 0; fi
if [ -n "$ALLOW_BREAK" ]; then
  log "  CLAUDE_REVIEW_ALLOW_BREAK_SYSTEM set — retrying with --break-system-packages (mutates system user-site)…"
  run_bounded python3 -m pip install --user --break-system-packages "$SRC" >/dev/null 2>&1
  if verify; then exit 0; fi
fi

fail "could not install claude-review from $SRC (tried pipx, venv, pip --user). Set CLAUDE_REVIEW_ALLOW_BREAK_SYSTEM=1 to allow a system-Python fallback, or install manually: pipx install $REPO_GIT"
