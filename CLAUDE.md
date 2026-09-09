# Collaborative Cloud IDE

Browser-based IDE: write, run, and share code with no local setup. Multiple people edit one
project live; files persist in the cloud.

**Learn-by-doing project.** Build the obvious version, push it until it visibly breaks,
measure the break, then adopt the fix. We do not start from the "correct" architecture — a
system you rebuilt because you watched it fail is understood; one you copied is memorized.
The record of those failures in `docs/journal/` is this project's most valuable output.

## The one rule

**Naive is fine. Naive and publicly reachable is not.**

Until Phase 9, this runs on localhost, LAN, or an authenticated tunnel — never a public URL.
Everything else here fails *educationally*: divergent documents, leaked containers, dropped
sockets. An unsandboxed code runner on a public IP fails *catastrophically, within hours* —
scanners find open code-execution endpoints fast, and it costs real money. That wall teaches
nothing you can't get from this paragraph. Hence the small floor in §3; everything else we
learn the hard way.

## 1. The loop

Every phase: **build the obvious thing** (don't anticipate) → **break it on purpose** (run
the named experiment) → **measure** (a number, not "feels slow" — this is the actual skill)
→ **fix and write a journal entry** (built / broke / number / fixed / would do differently).

## 2. Phases

Your original plan, kept intact, with the wall at each step. Don't build a phase's fix early
— arriving at it is the point.

**1 — Editor + local backend.** React + CodeMirror, Fastify, `child_process` runs the code.
- *Break:* from the browser, read a file outside the project — your SSH key, `/etc/passwd`.
- *Learn → fix:* user code runs as **you**, with your permissions. This is why containers
  exist. → Phase 2.

**2 — Runner in Docker.** One container.
- *Break:* (a) `while(true){}`; (b) two browsers both write `main.py`; (c) after an hour,
  `docker ps -a` and count leaks.
- *Measure:* container start time; containers leaked per hour.
- *Learn → fix:* isolation isn't binary — you need *resource* limits, *tenancy* separation,
  and a *lifecycle*. → container per session + TTL. Keep the open question: who cleans up if
  the server crashes? (Phase 6 answers it.)

**3 — Real-time collab over WebSockets.** Broadcast each change to the room.
- *Break:* two tabs, same cursor line, type simultaneously. Then kill one tab's network 10s.
- *Measure:* characters diverged; whether the docs are ever byte-identical again.
- *Learn → fix:* the best failure in the project. Broadcast operations **cannot** converge —
  order differs per client and no order is correct. → Yjs CRDT. Delete the broadcast code,
  don't patch it. Notice how much simpler reconnect gets.

**4 — Login as its own service.** Sessions/JWT, users own projects.
- *Break:* open someone else's project by pasting its id. Then check whether your **WebSocket
  upgrade** authorizes at all — naive versions guard the page and forget the socket.
- *Learn → fix:* authn (who) vs authz (what), on *every* entry point. → resolve ownership
  server-side; never trust a client-sent id. Toy passwords are fine to learn on, but never
  hold a real person's real password — swap to OIDC before anyone else uses this.

**5 — Kubernetes locally, by hand.** kind/minikube. Write a Pod manifest, apply, exec,
delete. Repeat until pods and services are boring. **No cloud billing yet.**
- *Break:* delete a bare pod — nothing returns it. Do the same to a Deployment.
- *Learn:* the reconciliation loop (desired vs actual) is the whole idea. The rest is detail.

**6 — Orchestrator automates workspaces.** A service calls the K8s API on project open.
- *Break:* stopwatch one open, then ten. Kill the orchestrator mid-create; inspect the debris.
- *Measure:* **cold start p50/p95** (expect 15–40s); pods leaked per crash; node memory at 10.
- *Learn → fix:* why warm pools exist, and why a reconciliation loop beats fire-and-forget —
  a crashed one-shot creator orphans pods forever; a loop cleans up next pass.
- *Expect:* adding TTL cleanup destroys user files. That's Phase 8 arriving uninvited. **Let
  it.** Being forced into persistence teaches dependency order better than a reordered plan.

**7 — Networking.** Your plan says sticky sessions. Try it.
- *Break:* two workspaces, two browsers — watch requests hit the wrong pod, or watch affinity
  do nothing at all.
- *Learn → fix:* sticky sessions keep you on the same replica of an **identical,
  interchangeable** service. Your pods are **distinct and individually addressable** — no
  cookie hash means "project 47." You need a **lookup table** (`workspace_id → pod address`
  in Redis) read by a proxying gateway. Then get WS upgrades through the proxy; fiddly. Your
  plan predicted this is the hardest step — correct.

**8 — Persistence to S3.** Snapshot the workspace; restore on open. MinIO locally.
- *Break:* kill a pod mid-edit. Then snapshot on every keystroke and watch cost and latency.
- *Measure:* data lost per crash; snapshot frequency vs cost.
- *Learn → fix:* **state that exists only in a pod is already lost.** → debounced snapshots +
  on-idle + on-shutdown, and exactly one writer per project.

**9 — Hardening. Required before any public URL.** gVisor/Kata runtime, non-root, read-only
rootfs, dropped capabilities, seccomp, NetworkPolicy default-deny egress, **block
`169.254.169.254`**, quotas, warm pool, billing alerts.
- *Learn:* a stock container shares the host kernel — one CVE and user code owns every
  workspace on the node. The metadata endpoint is how an escaped container steals your cloud
  account's IAM role.
- Security tests in CI: path traversal, metadata access, fork bomb, cross-tenant read — each
  asserted to **fail**.

**10 — Production polish.** OTel tracing; four dashboards: cold start p95, snapshot success
rate, sync latency p95, cost per workspace-hour. Load test. Runbooks.

**11 — Stretch.** AI assist: explain code, suggest fixes.

**Current phase: 2.** ← keep updated.

The shape all this converges on: a **trusted control plane** (auth, projects, orchestrator)
that never executes user code, and an **untrusted data plane** (workspace pods) that never
holds a credential. Most security questions reduce to that sentence — but it means far more
after you've built the version that violated it.

## 3. The security floor

Cheap protections from the first container — the floor below which failure stops being
educational.

1. **Not publicly reachable before Phase 9.**
2. **Every container gets `--memory`, `--cpus`, `--pids-limit`.** One flag each; turns a fork
   bomb into a shrug.
3. **Never `--privileged`, never mount the Docker socket.** Both hand over the host outright.
4. **Non-root inside the container.** One Dockerfile line.
5. **No real secrets near user code, none committed.** Gitignored `.env` from commit one.
6. **Billing alerts before the first cloud resource.** At a number that annoys you.

Network policy, seccomp, gVisor, read-only rootfs are Phase 9 — learned properly, in context.

## 4. Stack

Add a row when a phase needs it. An unused dependency is homework with no payoff.

| Phase | Layer | Choice |
|---|---|---|
| 1 | Frontend / editor | React + Vite + TypeScript, CodeMirror 6 |
| 1 | Backend | Node 20 + Fastify + TypeScript |
| 2 | Sandbox | Docker via `dockerode` |
| 3 | Collab / terminal | `ws` → Yjs + `y-codemirror.next`; `node-pty` + xterm.js |
| 4 | Database | Postgres + Drizzle (Compose) |
| 6 | Orchestration | Kubernetes (kind) + `@kubernetes/client-node` |
| 7 | Routing state | Redis |
| 8 | Object storage | S3 (MinIO locally) |
| 9 | Sandbox runtime | gVisor `RuntimeClass` |
| 10 | Observability | OpenTelemetry + Prometheus + Grafana |

TypeScript throughout: shared types across the wire, and Yjs is JS-native.

## 5. Repo layout

Start flat; split when a phase forces it. Extracting a service you've written teaches you
where the real boundaries are — guessing upfront doesn't.

```
Phase 1:  web/  server/
Phase 4:  apps/{web,api,auth}/  packages/shared-types/
Phase 6:  + apps/{orchestrator,gateway,workspace-agent}/  infra/k8s/
docs/journal/   numbered: what broke, the number, the fix   <- not optional
docs/adr/       decisions that were hard to reverse
```

**Scoped rules** live in `.claude/rules/`, each with `paths:` frontmatter so it loads only
when a matching file is touched — which is why this file stays short. They already cover
phases we haven't reached, so the first Dockerfile, manifest, and agent are governed before
they exist. Every rule file **must** have `paths:` — one without it loads at launch, always,
and defeats the point.

| Rule | Fires on |
|---|---|
| `backend.md` | `server/**`, `apps/{api,auth,gateway,orchestrator}/**` |
| `frontend.md` | `web/**`, `apps/web/**` |
| `containers.md` | any `Dockerfile*`, `docker-compose*` |
| `workspace-agent.md` | `apps/workspace-agent/**` |
| `kubernetes.md` | `infra/{k8s,terraform}/**` |
| `docs.md` | `docs/{journal,adr}/**` |

## 6. Conventions

- **Measure before you fix.** Every migration needs a number attached. Fixing on vibes is the
  habit this project exists to break.
- **One journal entry per wall.** Five paragraphs max.
- **ADRs for one-way doors** (datastore, wire protocol, isolation boundary). When a later
  phase overturns one, don't edit it — write the new one and mark the old `Superseded by
  0007`. The supersession chain *is* the learning, made legible.
- **Rewrite, don't patch, when the model was wrong.** Phase 3's broadcast code and Phase 7's
  sticky sessions get deleted. Spotting "wrong abstraction" vs "buggy code" is a skill.
- **Failure paths in the same commit** as the happy path, for anything touching network,
  Docker, or K8s.

## 7. Notes for Claude

- **Don't skip ahead.** In Phase 2, build the Phase 2 version — not one anticipating Phase 7.
  Premature correctness defeats the point of this repo.
- **Do flag the wall, once, briefly.** "This diverges when two people type at once — that's
  Phase 3" is useful. Silently building Yjs instead is not.
- **Diagnose before fixing.** Ask what was measured; suggest the isolating experiment. The
  debugging is the curriculum.
- **The §3 floor is not negotiable**, even in the roughest prototype. Everything else is.
- **Prompt for the journal entry** after a wall is hit — it won't get written otherwise.
- Explain the *why*, and name the general concept (reconciliation, CRDT convergence, trust
  boundary) so it transfers.
