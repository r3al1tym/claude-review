#!/usr/bin/env bash
# cleanroom.sh — prove a brand-new user can install and use claude-review from
# NOTHING, the way the README documents it. This is the test that on-machine
# runs and CI unit tests can't give you: it installs the published package on a
# fresh OS and resolves a freshly-seeded transcript.
#
# Run it inside a clean container (no Python deps, non-root user), e.g.:
#   docker run --rm -v "$PWD/tests/cleanroom.sh:/run.sh:ro" python:3.12-slim \
#     bash -c 'apt-get update -qq && apt-get install -y -qq git \
#       && useradd -m t && cp /run.sh /home/t/ && chown t /home/t/run.sh \
#       && su t -c "bash /home/t/run.sh"'
#
# Env:
#   CRV_REF   git ref to install (default: the repo's current tag/branch).
#             In CI on a tag, pass the tag so we test the PUBLISHED artifact.
#   CRV_REPO  git URL (default: the public repo).
#
# Exit 0 = all checks passed. Linux/WSL only (the install path strangers use);
# native macOS/Windows are covered by the CI OS matrix, the TUI render by a human.
set -uo pipefail

CRV_REPO="${CRV_REPO:-https://github.com/r3al1tym/claude-review}"
CRV_REF="${CRV_REF:-v0.4.0}"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
FAILED=0

say "environment (fresh; nothing pre-installed)"
whoami; python3 --version; echo "HOME=$HOME"; echo "installing: ${CRV_REPO}@${CRV_REF}"

say "1. install the stranger way: pinned release via pipx"
python3 -m pip install --user --quiet pipx 2>&1 | tail -1
# CRV_REF=local + a mounted /src means "test this working tree" (PR/push case);
# otherwise install the published tag exactly as the README documents.
if [ "$CRV_REF" = "local" ] && [ -d /src ]; then
  echo "  source: working tree at /src"
  python3 -m pipx install /src 2>&1 | tail -3
else
  echo "  source: git+${CRV_REPO}@${CRV_REF}"
  python3 -m pipx install "git+${CRV_REPO}@${CRV_REF}" 2>&1 | tail -3
fi
export PATH="$HOME/.local/bin:$PATH"

say "2. non-interactive commands work (incl. the UTF-8 --help path)"
claude-review -V && ok "-V" || bad "-V"
claude-review -h >/dev/null 2>&1 && ok "-h (glyph encoding)" || bad "-h"

say "3. seed a realistic transcript under a DOTTED project path"
PROJDIR="$HOME/work/my.app"             # the '.' is the case that used to break
mkdir -p "$PROJDIR"
# mirror the real encoder exactly: EVERY non-alphanumeric -> '-' (not just a few
# chars) so this seed stays correct for any path, not only ones with a dot/space.
SLUG=$(python3 -c "import re,os;print(re.sub(r'[^A-Za-z0-9]','-',os.path.abspath('$PROJDIR')))")
SDIR="$HOME/.claude/projects/$SLUG"; mkdir -p "$SDIR"
UUID="00000000-clean-room-0000-000000000001"
{
  printf '%s\n' '{"type":"file-history-snapshot","snapshot":{}}'
  printf '{"type":"user","cwd":"%s","message":{"content":"hello from the clean room"}}\n' "$PROJDIR"
  printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"# Hi\nThis renders in the pane."}]}}'
} > "$SDIR/$UUID.jsonl"
echo "  project: $PROJDIR   slug: $SLUG"

say "4. -l lists the seeded session (explicit -p slug)"
claude-review -l -p "$SLUG" 2>&1 | tee /tmp/crv-list.txt | sed 's/^/    /'
grep -q "clean room" /tmp/crv-list.txt && ok "session shows in -l" || bad "-l did not surface the session"

say "5. resolve from inside the dotted project dir (no -p) — the slug fix"
cd "$PROJDIR"
claude-review -l 2>&1 | tee /tmp/crv-cwd.txt | sed 's/^/    /'
grep -q "clean room" /tmp/crv-cwd.txt && ok "cwd-derived slug resolved the dotted path" || bad "cwd resolution failed"

say "6. cwd-scan fallback: a project dir whose name does NOT match the encoder"
WEIRD="$HOME/.claude/projects/totally-unrelated-name"; mkdir -p "$WEIRD"
printf '{"type":"user","cwd":"%s","message":{"content":"scan fallback target"}}\n{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"found via scan"}]}}\n' "$PROJDIR/sub" > "$WEIRD/$UUID.jsonl"
mkdir -p "$PROJDIR/sub"; cd "$PROJDIR/sub"
claude-review -l 2>&1 | tee /tmp/crv-scan.txt | sed 's/^/    /'
grep -q "scan fallback" /tmp/crv-scan.txt && ok "cwd-scan fallback located the project" || bad "cwd-scan fallback failed"

say "RESULT"
[ "$FAILED" = 0 ] && echo "  ALL CLEAN-ROOM CHECKS PASSED" || echo "  SOME CHECKS FAILED"
exit $FAILED
