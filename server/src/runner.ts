import Docker from "dockerode";

const docker = new Docker();
const RUNNER_IMAGE = "cloud-ide-runner-python:latest";
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

export async function runInContainer(
  hostFilePath: string,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const container = await withTimeout(
    docker.createContainer({
      Image: RUNNER_IMAGE,
      // -u: unbuffered stdout/stderr, so a killed script's output isn't lost
      // sitting in a buffer it never got to flush.
      Cmd: ["python", "-u", "/home/runner/script.py"],
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
        Binds: [`${hostFilePath}:/home/runner/script.py:ro`],
      },
    }),
    "createContainer",
  );

  const stdout = createCappedSink();
  const stderr = createCappedSink();
  let timedOut = false;
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
    await Promise.race([
      container.wait(),
      new Promise((resolve) => {
        waitCeiling = setTimeout(resolve, TIMEOUT_MS + KILL_GRACE_MS);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (waitCeiling) clearTimeout(waitCeiling);
    // A removal that genuinely fails is a leaked container — the exact thing
    // this phase exists to measure, so it must never disappear silently.
    await withTimeout(container.remove({ force: true }), "remove").catch((err) => {
      console.error(`failed to remove container ${container.id}:`, err);
    });
  }

  return { stdout: stdout.text(), stderr: stderr.text(), timedOut };
}
