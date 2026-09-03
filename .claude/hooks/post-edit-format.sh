#!/usr/bin/env bash
# PostToolUse (matcher: Write|Edit). Formats the edited file and reports lint errors.
#
# Two things the naive version gets wrong, fixed here:
#   1. It formats ONLY the file just edited, not the whole workspace. Linting an entire
#      monorepo after every single edit costs seconds-to-minutes per edit.
#   2. It REPORTS failures instead of swallowing them with '|| true'. A hook whose
#      output nobody sees enforces nothing; it just spends time. Lint errors come back
#      through additionalContext so Claude actually sees and fixes them.
set -uo pipefail

INPUT=$(cat)
ROOT="${CLAUDE_PROJECT_DIR:-.}"

FILE=$(printf '%s' "$INPUT" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const j=JSON.parse(s);process.stdout.write(String(j?.tool_input?.file_path??""))}
    catch{process.stdout.write("")}
  })' 2>/dev/null) || exit 0

# Only source files we can actually format.
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md) ;;
  *) exit 0 ;;
esac
[ -f "$FILE" ] || exit 0
[ -f "$ROOT/package.json" ] || exit 0

cd "$ROOT" 2>/dev/null || exit 0

# Format silently — success needs no commentary.
npx --no-install prettier --write "$FILE" >/dev/null 2>&1 || true

# Lint only this file; report problems back to Claude.
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx)
    if ! OUT=$(npx --no-install eslint "$FILE" 2>&1); then
      printf '%s' "$OUT" | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const t=s.trim().slice(0,2000);
          if(!t)process.exit(0);
          process.stdout.write(JSON.stringify({hookSpecificOutput:{
            hookEventName:"PostToolUse",
            additionalContext:"eslint reported problems in the file you just edited. Fix them before moving on:\n"+t
          }}))
        })' 2>/dev/null
    fi
    ;;
esac

exit 0
