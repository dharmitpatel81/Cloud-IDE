import Docker from "dockerode";

const docker = new Docker();
const RUNNER_IMAGE = "cloud-ide-runner-python:latest";
const TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 3000; // extra time to let stop()/kill() actually take effect
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB per stream, past this we just drop bytes

function cappedWriter(chunks: Buffer[], bytesRef: { n: number }) {
  return {
    write: (chunk: Buffer) => {
      if (bytesRef.n >= MAX_OUTPUT_BYTES) return;
      const remaining = MAX_OUTPUT_BYTES - bytesRef.n;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      bytesRef.n += slice.length;
    },
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
  const container = await docker.createContainer({
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
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  let deadline: NodeJS.Timeout | undefined;

  try {
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    container.modem.demuxStream(
      attachStream,
      cappedWriter(stdoutChunks, { n: 0 }),
      cappedWriter(stderrChunks, { n: 0 }),
    );

    await container.start();

    // Deadline registered before we await completion — an execution nobody
    // watches is an execution nobody kills.
    deadline = setTimeout(() => {
      timedOut = true;
      killContainer(container);
    }, TIMEOUT_MS);

    // Bound the whole wait, independent of whether stop()/kill() themselves
    // misbehave — the request always returns, even if the kill didn't.
    await Promise.race([
      container.wait(),
      new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + KILL_GRACE_MS)),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    await container.remove({ force: true }).catch(() => {});
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    timedOut,
  };
}
