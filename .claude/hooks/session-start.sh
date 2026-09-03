#!/usr/bin/env bash
# SessionStart: injects live project state so Claude starts oriented.
#
# SessionStart adds plain stdout to Claude's context, so we print text, not JSON.
# That deliberately avoids the escaping bug in a hand-built JSON version: a commit
# message containing a quote, backslash, or newline produces malformed JSON.
#
# No 'set -e': a hook that exits non-zero on a trivial failure is worse than one
# that prints slightly less context.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# The phase governs what Claude may build. This is the point of the hook: it is the
# one piece of state Claude cannot infer from the code.
PHASE=$(sed -n 's/^\*\*Current phase: \([^*]*\)\*\*.*/\1/p' CLAUDE.md 2>/dev/null | head -1)
[ -z "${PHASE:-}" ] && PHASE="unknown (check CLAUDE.md)"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
  LAST=$(git log -1 --pretty=format:'%s' 2>/dev/null || echo "no commits yet")
  DIRTY=$(git status --porcelain 2>/dev/null | grep -c . || true)
  GIT_LINE="Branch: ${BRANCH} | Last commit: ${LAST} | Uncommitted files: ${DIRTY:-0}"
else
  GIT_LINE="Not a git repo — run 'git init' (the code-reviewer agent needs it)."
fi

cat <<TEXT
Project state
- Current phase: ${PHASE}
- ${GIT_LINE}

Reminders for this repo:
- Build the CURRENT phase only. Do not pre-build a later phase's fix.
- Nothing gets a public URL before Phase 9. Tunnels and 0.0.0.0 binds are hook-blocked.
- After a wall is hit and fixed, prompt for a docs/journal/ entry.
- Never push to main without asking.
TEXT

exit 0
