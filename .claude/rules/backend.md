---
paths:
  - "server/**"
  - "apps/api/**"
  - "apps/auth/**"
  - "apps/gateway/**"
  - "apps/orchestrator/**"
---

# Backend rules

These services execute code written by strangers, or route to something that does. That
single fact drives every rule here.

## The execution boundary

- **Exactly one module may start a process or container** — `runner/`. Nothing else calls
  `exec`, `spawn`, `eval`, `vm`, or shells out. Routes needing to run code go through it.
- Every execution is created with an **owner and a hard deadline, registered before we await
  anything**. A process we forgot about is a process nobody will kill.
- **Kill on timeout, and verify the kill.** An ignored `SIGTERM` still needs `SIGKILL`.
- From Phase 2, no execution path bypasses `--memory`, `--cpus`, `--pids-limit`.

## Input

- **Parse every request body and WS message with a zod schema at the edge.** Never spread an
  unvalidated object; never interpolate raw input into a shell string, path, or query.
- **Path containment:** resolve every path against the project root and reject anything that
  escapes — after `realpath`, so symlinks can't step out. No file operation takes a client
  path directly.
- Cap request body, file size, and output buffer explicitly. An unbounded read is an OOM
  waiting for someone to find it.

## Auth (from Phase 4)

- **Every route authorizes, and so does every WebSocket upgrade.** The upgrade is the one
  people forget — guarding the page and leaving the socket open is a real breach class.
- **Resolve ownership server-side** from the session. A `projectId` in a payload is a request,
  not a fact. No "fetch by id" skips the ownership check.
- **Rate-limit anything that starts execution**, per user — not per IP; one user has many tabs.
- No anonymous writes, no anonymous execution.

## Output and logging

- **Return the user program's stderr; never return server internals.** The program's error
  output is the product. Our stack traces, paths, and env are not — they map the host.
- **Never log file contents, source code, terminal output, tokens, or auth headers.** Log ids,
  durations, sizes, outcomes.
- Every log line carries a request id; every execution logs `start / exit code / duration /
  killed-by-timeout`.

## Orchestrator only

- It is the **only** service holding K8s API credentials, and its ServiceAccount is
  namespace-scoped least-privilege (see the k8s rule). Nothing else talks to the cluster.
- Reconcile toward desired state on a loop; never fire-and-forget. A crashed one-shot creator
  orphans pods forever.

## Shape

- Config from validated env at boot — **fail fast on a missing var**, never default a secret.
- Anything touching network, Docker, or K8s ships its timeout, retry-with-backoff, and
  give-up path in the same commit as the happy path.
- Handlers stay thin: validate → authorize → call a service function → map the result.
