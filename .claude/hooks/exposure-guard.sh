#!/usr/bin/env bash
# PreToolUse (matcher: Bash). The project's one deterministic gate.
#
# CLAUDE.md's rule is "naive is fine, naive and publicly reachable is not." That rule
# only holds if it cannot be argued away, so it lives here rather than in prose.
#
# Blocks with exit 2, which blocks unconditionally even if this script's stdout is
# malformed. A security gate must fail CLOSED. Everything else passes through silently.
set -uo pipefail

INPUT=$(cat)

# Extract tool_input.command properly. Fall back to the raw payload if node is
# unavailable — a false positive costs one confirmation, a false negative costs the
# thing this hook exists to prevent.
CMD=$(printf '%s' "$INPUT" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const j=JSON.parse(s);process.stdout.write(String(j?.tool_input?.command??""))}
    catch{process.stdout.write("")}
  })' 2>/dev/null) || CMD=""
[ -z "$CMD" ] && CMD="$INPUT"

block() {
  echo "BLOCKED by exposure-guard: $1" >&2
  echo "If this is genuinely intended, run it yourself outside Claude Code." >&2
  exit 2
}

# --- 1. Public exposure. Forbidden before Phase 9. -------------------------------
if printf '%s' "$CMD" | grep -qiE '(^|[^a-z])(ngrok|cloudflared|localtunnel|\blt\b)([^a-z]|$)|tailscale +funnel|serveo|bore\.pub'; then
  block "opens a public tunnel to a machine running unsandboxed user code. Phase 9 (hardening) must land first."
fi

if printf '%s' "$CMD" | grep -qiE '(--host[= ]+0\.0\.0\.0|--address[= ]+0\.0\.0\.0|-p +0\.0\.0\.0:|type=LoadBalancer|kubectl +expose)'; then
  block "binds or exposes a service on all interfaces. Bind 127.0.0.1 until Phase 9."
fi

# --- 2. Sandbox escape. Forbidden always. ---------------------------------------
if printf '%s' "$CMD" | grep -qiE 'docker[^|]*(--privileged|--network[= ]+host|--pid[= ]+host|--cap-add[= ]+(all|sys_admin))'; then
  block "runs a container with host-level privileges. This defeats the isolation the whole project exists to build."
fi

if printf '%s' "$CMD" | grep -qE '/var/run/docker\.sock'; then
  block "mounts the Docker socket into a container — that is root on the host, handed to user code."
fi

# --- 3. Cost. Ask before anything billable. --------------------------------------
if printf '%s' "$CMD" | grep -qiE 'terraform +(apply|destroy)|eksctl +create|gcloud +container +clusters +create|az +aks +create'; then
  block "creates or destroys billable cloud infrastructure. Confirm billing alerts exist, then run it yourself."
fi

# --- 4. Deploy gate: tests must pass first. ---------------------------------------
if printf '%s' "$CMD" | grep -qiE '(vercel|netlify|fly) +deploy|railway +up|git +push +.*(prod|production)|docker +push'; then
  if [ -f "${CLAUDE_PROJECT_DIR:-.}/package.json" ] && grep -q '"test"' "${CLAUDE_PROJECT_DIR:-.}/package.json" 2>/dev/null; then
    if ! (cd "${CLAUDE_PROJECT_DIR:-.}" && npm test >/tmp/predeploy-test.log 2>&1); then
      echo "BLOCKED: tests are failing, so this must not ship." >&2
      tail -20 /tmp/predeploy-test.log >&2
      exit 2
    fi
  fi
fi

exit 0
