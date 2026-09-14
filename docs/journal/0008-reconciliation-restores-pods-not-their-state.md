# 0008 — Kubernetes brings a pod back, but not its files or a clean shutdown
Date: 2026-09-13 · Phase: 5

**Built:** A local Kubernetes cluster with kind, and the terminal's workspace
image running in it. First as a bare Pod written by hand
([infra/k8s/pod.yaml](../../infra/k8s/pod.yaml)), then the same pod inside a
Deployment ([infra/k8s/deployment.yaml](../../infra/k8s/deployment.yaml)).
Both keep the §3 floor: non-root user, read-only root filesystem, all
capabilities dropped, CPU/memory/disk limits, and no Kubernetes API token.

**Broke:** Three experiments. Deleting the bare pod: nothing brought it back.
Deleting the Deployment's pod: a new one appeared at once — but a file written
to `/workspace` just before was gone, and for a moment the old and new pods
both ran. Deleting an idle pod: it sat in `Terminating` for half a minute. The
pod runs only `sleep infinity`. Kubernetes asks it to stop with SIGTERM, and
because `sleep` is PID 1, Linux ignores that signal for it. Kubernetes then
waits the full 30-second grace period and kills it with SIGKILL.

**Measured:** Bare pod replaced: **never**. Deployment pod replaced in
**1.1 s** (the image was already on the node). File kept: **no**. Stopping one
idle pod: **31.4 s**, which is the 30 s grace period plus about 1.4 s. After the
fix: **1.0 s**.

**Fixed:** First proved the cause: the same SIGTERM killed a second `sleep` at
once but left PID 1 running. Then made PID 1 a shell that handles the signal:
`sh -c "trap 'exit 0' TERM; sleep infinity & wait"`. Did *not* just set
`terminationGracePeriodSeconds: 1`. That gives the same number but hides the
bug. In Phase 8 those grace seconds are when the workspace saves its files,
and a PID 1 that ignores SIGTERM gets killed before saving, however long the
wait. The two other findings aren't fixed here on purpose: losing the file is
Phase 8 (persistence), and two pods at once is the "one writer per project"
problem.

**Would do differently:** Check that the experiment actually ran before
trusting its number. My first timing said 0.5 s, but `$old` was empty, so no
pod was deleted and the script "found" the original pod. Later a `kill -TERM
1` check looked like it passed, but `kill` wasn't installed, so no signal was
sent. Both looked like results. A measuring script should stop with an error
when its input is missing. The idea underneath all three experiments is
**reconciliation**: a Deployment stores what *should* exist and a controller
keeps fixing the difference — but it restores the *template*, never what was
inside the old pod.

---

## Deep dive

### What each experiment showed

| Experiment | What happened | What it teaches |
|---|---|---|
| Delete a bare Pod | `No resources found` | A bare pod is its own request; delete it and nothing remembers it should exist |
| Delete a Deployment's pod | New pod `Ready` in 1.1 s | The Deployment's `replicas: 1` lives in etcd; a controller sees 0 and makes 1 |
| Check `a.txt` in the new pod | `No such file or directory` | The new pod is a fresh copy of the template; `emptyDir` is created empty and dies with its pod |
| `kubectl get pods` right after | Old pod `Terminating`, new pod `Running` | A Deployment starts the replacement before the old one is gone, so it does not guarantee a single writer |
| Delete an idle pod | 31.4 s | PID 1 ignored SIGTERM, so the full grace period ran out |

### How the cause was proved

```text
$ kubectl exec $p -- cat /proc/1/cmdline
sleepinfinity                                     # PID 1 is sleep

$ kubectl exec $p -- sh -c "kill -TERM 1; echo sent"
sent                                              # pod still Running, RESTARTS 0

$ kubectl exec $p -- sh -c "sleep 300 & pid=$!; kill -TERM $pid; ..."
died on SIGTERM                                   # same program, not PID 1
```

Same program, same signal; the only difference is being PID 1. The kernel does
not apply a signal's default action ("terminate") to PID 1 unless the process
installed a handler, and `sleep` installs none.

### The change

```yaml
# before: 31.4 s to stop
command: ["sleep", "infinity"]
# after: 1.0 s to stop
command: ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"]
```

`wait` returns as soon as a trapped signal arrives, so the shell exits right
away. In Phase 6 the workspace-agent will be PID 1 and must handle SIGTERM
itself — that is where "save on shutdown" (Phase 8) will run.

### The wrong turns, as they happened

1. `kubectl delete pod $old` with `$old` never set → `error: resource(s) were
   provided, but no name was specified`. The wait loop then matched the
   original pod (every name differs from an empty one) and printed
   `ready after 0.5 s`. The "replacement" had the same name and was 42 s old.
2. `kubectl exec $p -- kill -TERM 1` → `executable file not found`. `kill` is a
   shell builtin and the slim image has no separate `kill` program. The pod
   still showed `Running`, which looked like proof but wasn't — nothing was sent.

### The Docker link

`docker stop` has the same two steps (SIGTERM, wait 10 s, SIGKILL). The Run
sandbox never hit it because it force-removes containers.
