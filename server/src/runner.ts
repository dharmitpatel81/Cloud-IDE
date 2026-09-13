import Docker from "dockerode";
import type { Duplex } from "node:stream";
import { mkdir, rm } from "node:fs/promises";

const docker = new Docker();
const TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 3000; // extra time to let stop()/kill() actually take effect
const DAEMON_TIMEOUT_MS = 10000; // ceiling on any single Docker API call
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB per stream, past this we drop bytes

// A wedged daemon must not hang the request forever — every call we await gets a ceiling.
async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`docker ${label} timed out after ${DAEMON_TIMEOUT_MS}ms`)),
          DAEMON_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createCappedSink() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    writer: {
      write: (chunk: Buffer) => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - bytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        if (slice.length < chunk.length) truncated = true;
        chunks.push(slice);
        bytes += slice.length;
      },
    },
    text: () =>
      Buffer.concat(chunks).toString() +
      (truncated ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""),
  };
}

async function killContainer(container: Docker.Container) {
  try {
    // stop() sends SIGTERM, waits `t` seconds, then SIGKILLs if still alive.
    await container.stop({ t: 2 });
  } catch {
    // stop() itself failed (already exited, daemon hiccup, etc) — escalate.
    await container.kill().catch(() => {});
  }
}

export type Runtime = "python" | "node";

const PROJECT_MOUNT = "/workspace";

// One image per language: a smaller attack surface and a faster start than
// one image holding every runtime. Built from server/runner/<runtime>/.
const RUNTIMES: Record<Runtime, { image: string; command: (entry: string) => string[]; env: string[] }> = {
  python: {
    image: "cloud-ide-runner-python:latest",
    // -u: unbuffered stdout/stderr, so a killed script's output isn't lost
    // sitting in a buffer it never got to flush.
    command: (entry) => ["python", "-u", entry],
    // The project is mounted read-only, so there's nowhere to cache bytecode.
    env: ["PYTHONDONTWRITEBYTECODE=1"],
  },
  node: {
    image: "cloud-ide-runner-node:latest",
    command: (entry) => ["node", entry],
    env: [],
  },
};

export async function runInContainer({
  hostDir,
  entry,
  runtime,
}: {
  /** The run's own folder on the host, holding the project's files. */
  hostDir: string;
  /** Path of the file to run, relative to the project root. */
  entry: string;
  runtime: Runtime;
}): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number | null }> {
  const { image, command, env } = RUNTIMES[runtime];
  const creating = docker.createContainer({
    Image: image,
    // Run from the project root, so `import greeting` and "./lib/greet.js"
    // resolve against the project the way they would on your own machine.
    WorkingDir: PROJECT_MOUNT,
    // "./" so a file named like a flag ("--inspect") is still read as a file.
    Cmd: command(`./${entry}`),
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { "cloud-ide.owner": "runner" },
    HostConfig: {
      Memory: 128 * 1024 * 1024,
      NanoCpus: 0.5 * 1e9,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "size=16m,mode=1777,noexec,nosuid" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: "none",
      // Read-only: user code can read its project but not rewrite it.
      Binds: [`${hostDir}:${PROJECT_MOUNT}:ro`],
    },
  });

  const container = await withTimeout(creating, "createContainer").catch((err) => {
    // Giving up on the call doesn't cancel it — if the create lands afterwards
    // we never get the handle, so reap it here or it's orphaned for good.
    creating.then(
      (late) => late.remove({ force: true }).catch(() => {}),
      () => {},
    );
    throw err;
  });

  const stdout = createCappedSink();
  const stderr = createCappedSink();
  let timedOut = false;
  let exitCode: number | null = null;
  let deadline: NodeJS.Timeout | undefined;
  let waitCeiling: NodeJS.Timeout | undefined;

  try {
    const attachStream = await withTimeout(
      container.attach({ stream: true, stdout: true, stderr: true }),
      "attach",
    );
    container.modem.demuxStream(attachStream, stdout.writer, stderr.writer);

    await withTimeout(container.start(), "start");

    // Deadline registered before we await completion — an execution nobody
    // watches is an execution nobody kills.
    deadline = setTimeout(() => {
      timedOut = true;
      killContainer(container).catch(() => {});
    }, TIMEOUT_MS);

    // Bound the whole wait, independent of whether stop()/kill() themselves
    // misbehave — the request always returns, even if the kill didn't.
    const finished = await Promise.race([
      container.wait() as Promise<{ StatusCode: number }>,
      new Promise<undefined>((resolve) => {
        waitCeiling = setTimeout(() => resolve(undefined), TIMEOUT_MS + KILL_GRACE_MS);
      }),
    ]);
    exitCode = finished?.StatusCode ?? null;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (waitCeiling) clearTimeout(waitCeiling);
    // A removal that genuinely fails is a leaked container — the exact thing
    // this phase exists to measure, so it must never disappear silently.
    await withTimeout(container.remove({ force: true }), "remove").catch((err) => {
      console.error(`failed to remove container ${container.id}:`, err);
    });
  }

  return { stdout: stdout.text(), stderr: stderr.text(), timedOut, exitCode };
}

// --- Terminal sessions -----------------------------------------------------
//
// Unlike runInContainer above, a shell needs a process that survives across
// many commands, not one that's removed after a single run. So this is a
// second, long-lived container per project, kept in memory for as long as the
// server runs. Deliberately no TTL or cleanup on disconnect here yet — that's
// the wall this is expected to hit (Phase 2 named it, "container per session
// + TTL", but the runner above never needed the "per session" half until
// now). Leaving it unsolved is the point: measure the leak, then fix it.

export type TerminalSession = {
  container: Docker.Container;
  activeShell?: { exec: Docker.Exec; stream: Duplex };
  cleanup: () => Promise<void>;
};

const terminalSessions = new Map<string, TerminalSession>();
// Two tabs opening the same project at once must share one container, so
// the second waits on the first's creation instead of starting its own.
const creating = new Map<string, Promise<TerminalSession>>();

/** A directory for the container to mount, and how to tear it down. */
export type Workspace = { dir: string; cleanup: () => Promise<void> };

// Built from server/runner/workspace/: node + npm + python3, non-root. A
// shell is where you switch between runtimes freely, so unlike a one-shot
// run it doesn't get a single-language image.
const TERMINAL_IMAGE = "cloud-ide-workspace:latest";
const TERMINAL_MOUNT = "/workspace";
const TERMINAL_HOME = "/home/node";
// bash reads PS1 from the environment when started with --norc, so the
// prompt is ours to set: user@host in green, cwd in blue, like a stock Debian
// login shell — the difference between "a terminal" and "a text box".
const PROMPT = String.raw`\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ `;

/** The project's long-lived shell container, starting one if none exists
 *  yet. `prepare` is only called for a fresh session: it produces the
 *  directory the container mounts as /workspace (see workspaceSync.ts, which
 *  keeps that directory and the project's document in step both ways). */
export function getOrCreateTerminalSession(
  projectId: string,
  prepare: () => Promise<Workspace>,
): Promise<TerminalSession> {
  const existing = terminalSessions.get(projectId);
  if (existing) return Promise.resolve(existing);
  const pending = creating.get(projectId);
  if (pending) return pending;

  const promise = createTerminalSession(projectId, prepare).finally(() => creating.delete(projectId));
  creating.set(projectId, promise);
  return promise;
}

async function createTerminalSession(
  projectId: string,
  prepare: () => Promise<Workspace>,
): Promise<TerminalSession> {
  const { dir, cleanup: cleanupFiles } = await prepare();
  // $HOME on disk next to the workspace, not in memory: npm's cache alone
  // outgrows any tmpfs worth charging against the container's memory limit.
  const homeDir = `${dir}-home`;
  await mkdir(homeDir, { recursive: true });
  const cleanup = async () => {
    await cleanupFiles();
    await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  };

  const creating = docker.createContainer({
    Image: TERMINAL_IMAGE,
    WorkingDir: TERMINAL_MOUNT,
    // No-op main process: every command actually run comes in through exec.
    Cmd: ["sleep", "infinity"],
    Labels: { "cloud-ide.owner": "terminal", "cloud-ide.project": projectId },
    HostConfig: {
      // Roomier than a one-shot run: `npm install` and a dev server need it.
      // Still the §3 floor — every limit is set, just higher.
      Memory: 512 * 1024 * 1024,
      NanoCpus: 1 * 1e9,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "size=64m,mode=1777,nosuid" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // Egress on, unlike every other container here: a shell you can't
      // `npm install` from isn't a workspace. This is the first container
      // that can reach out — and, on a bridge network, reach the host's
      // LAN too. Locking that down (default-deny NetworkPolicy, no metadata
      // endpoint) is Phase 9; until then, the §3 "never publicly reachable"
      // rule is what keeps this sane.
      NetworkMode: "bridge",
      // Read-write, unlike runInContainer's mount: a shell needs to create
      // and edit files, not just read them.
      Binds: [`${dir}:${TERMINAL_MOUNT}:rw`, `${homeDir}:${TERMINAL_HOME}:rw`],
    },
  });

  const container = await withTimeout(creating, "createContainer").catch(async (err) => {
    creating.then(
      (late) => late.remove({ force: true }).catch(() => {}),
      () => {},
    );
    await cleanup();
    throw err;
  });

  try {
    await withTimeout(container.start(), "start");
  } catch (err) {
    await container.remove({ force: true }).catch(() => {});
    await cleanup();
    throw err;
  }

  const session: TerminalSession = {
    container,
    cleanup: async () => {
      terminalSessions.delete(projectId);
      await container.remove({ force: true }).catch((err) => {
        console.error(`failed to remove terminal container ${container.id}:`, err);
      });
      await cleanup();
    },
  };
  terminalSessions.set(projectId, session);
  return session;
}

/** Removes the project's container and workspace directory, if it has one. */
export async function endTerminalSession(projectId: string) {
  await terminalSessions.get(projectId)?.cleanup();
}

/** The session's current shell, starting a fresh one if there's none yet or
 *  the last one exited (e.g. someone typed `exit`). Shared by every client
 *  attached to this project — like `tmux attach`, not an independent shell
 *  per tab: a pty has exactly one authoritative owner (the process itself),
 *  so fanning one shell's I/O out to every viewer is the correct model here,
 *  not a shortcut. `/bin/sh -c` is guaranteed to exist; it hands off to bash
 *  if this image has it, or stays a plain shell if not. */
export async function attachShell(session: TerminalSession) {
  if (session.activeShell) return session.activeShell;

  const exec = await withTimeout(
    session.container.exec({
      Cmd: ["/bin/sh", "-c", "exec bash --norc || exec sh"],
      Env: [`PS1=${PROMPT}`, "TERM=xterm-256color", `HOME=${TERMINAL_HOME}`],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    }),
    "exec create",
  );
  // Tty on the *start* call too, not just on create: without it the daemon
  // still frames the output with 8-byte stream headers, which reach the
  // browser as garbage before the prompt. With it, stdout/stderr arrive raw
  // and combined — no demuxStream, unlike the non-tty attach in runInContainer.
  const stream = await withTimeout(exec.start({ hijack: true, stdin: true, Tty: true }), "exec start");
  const activeShell = { exec, stream };
  session.activeShell = activeShell;
  stream.on("close", () => {
    if (session.activeShell === activeShell) session.activeShell = undefined;
  });
  return activeShell;
}

export function resizeShell(exec: Docker.Exec, cols: number, rows: number) {
  return exec.resize({ h: rows, w: cols }).catch(() => {});
}
