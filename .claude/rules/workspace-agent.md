---
paths:
  - "apps/workspace-agent/**"
---

# Workspace agent rules (Phase 6+)

**This code runs inside the sandbox, in the same process space as the user's code.**

Assume the user has root in this container, is reading this source, and is actively trying to
use this agent as a way out. Everything below follows from that.

## What must never be here

- **No credentials of any kind.** No database URL, no Redis URL, no cloud key, no IAM role, no
  signing secret, no other user's token. Not in env, not in the image, not fetched at boot.
- **No direct connection to anything in the control plane** except the gateway. If the agent
  needs S3, the control plane hands it a **scoped, short-lived pre-signed URL** for one prefix
  — the agent never holds S3 credentials.
- **No `workspace_id` parameter anywhere.** This agent serves exactly one project, decided at
  pod creation. An agent that can be asked which project to open is an agent that can be asked
  for someone else's.

## Trust runs both ways

- Everything arriving from the gateway is parsed with a schema before use.
- **The control plane must not trust this agent either.** A compromised agent will lie — about
  identity, about paths, about sizes. Authorization belongs at the gateway, decided from the
  session, never from a value the agent reported.

## Filesystem

- Every path resolves against the project root and is rejected if it escapes, checked after
  `realpath` so symlinks can't step out.
- Bound file sizes, total workspace size, and output buffers. The user controls all three.

## Dependencies

- **Every dependency here is attack surface.** Keep the list minimal, prefer the standard
  library, and justify additions in an ADR.
- No dependency shared with a package that holds credentials — shared code is a path between
  the two planes.

## Lifecycle

- Snapshot to storage on a debounce after edits, on idle, and on shutdown. **State that exists
  only in this pod is already lost** — a node can vanish without a shutdown signal.
- Exactly one agent writes a given project's storage prefix at a time.
- Handle `SIGTERM` properly: flush, snapshot, exit. Kubernetes gives a grace period; use it.
