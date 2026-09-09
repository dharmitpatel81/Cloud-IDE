# 0002 — A hung script leaks a container forever
Date: 2026-09-09 · Phase: 2

**Built:** Moved code execution off bare `child_process.spawn` and into Docker.
Every `/run` request creates a fresh container from a digest-pinned
`python:3.11-slim` image, running as a non-root user, with `--memory`,
`--cpus`, `--pids-limit`, a read-only root filesystem, all capabilities
dropped, and no network. The submitted script gets bind-mounted in
read-only. One container per run, removed after it finishes.

**Broke:** Typed `while True: pass` into the editor and hit Run. The request
just sat there. In a second terminal, `docker ps` showed the container still
alive and spinning. Killed it by hand, clicked Run again with the same code,
got a second stuck container. Nothing about the setup would ever stop this on
its own, the container just runs until someone notices and kills it manually.

**Measured:** Two hangs, two leaked containers, zero self-cleanup. A 100%
leak rate on anything that doesn't finish by itself. Separately, timed a
normal container run at about 1.1 seconds of pure startup overhead before the
script even executes, worth remembering since that's now the cost every
single run pays, on top of whatever the code itself takes.

**Fixed:** Stopped using dockerode's `docker.run()` shortcut, since it only
hands back the container reference after everything's already done, too late
to kill anything mid-run. Switched to creating the container directly,
starting it, and arming a 5-second timer right after start, before awaiting
completion. If the script finishes first, the timer gets cancelled. If the
timer fires first, it calls `container.stop({ t: 2 })`, which is Docker's own
version of "ask nicely with SIGTERM, then force it with SIGKILL if that's
ignored." Re-ran the same infinite loop, it got killed at 5 seconds instead
of hanging forever, and `docker ps -a` came back clean afterward.

**Would do differently:** Two things worth naming, not fixing. First, the
plan's other break test, two tabs both writing `main.py`, never actually
happened here, because Phase 1 already gave every run a random filename to
avoid two requests colliding on one script file. Lucky, not planned, but
worth knowing why. Second, the plan's suggested fix is "container per session
plus TTL," and what got built instead is container-per-run, a fresh one every
click. That's a real, simpler version of the same idea (bounded, cleaned up,
nothing orphaned), it just means every run repays that 1.1 second startup
cost instead of reusing a warm container across a session. That reuse only
starts paying for itself once sessions and collaboration actually matter, so
it's staying out for now instead of getting built early.
