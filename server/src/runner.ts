import Docker from "dockerode";

const docker = new Docker();
const RUNNER_IMAGE = "cloud-ide-runner-python:latest";
const TIMEOUT_MS = 5000;

export async function runInContainer(
  hostFilePath: string,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const container = await docker.createContainer({
    Image: RUNNER_IMAGE,
    Cmd: ["python", "/home/runner/script.py"],
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Memory: 128 * 1024 * 1024,
      NanoCpus: 0.5 * 1e9,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: "none",
      Binds: [`${hostFilePath}:/home/runner/script.py:ro`],
    },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
  container.modem.demuxStream(
    attachStream,
    { write: (chunk: Buffer) => stdoutChunks.push(chunk) },
    { write: (chunk: Buffer) => stderrChunks.push(chunk) },
  );

  await container.start();

  // Deadline registered before we await completion — an execution nobody
  // watches is an execution nobody kills.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    // stop() sends SIGTERM, waits `t` seconds, then SIGKILLs if it's still alive.
    container.stop({ t: 2 }).catch(() => {});
  }, TIMEOUT_MS);

  await container.wait();
  clearTimeout(deadline);
  await container.remove().catch(() => {});

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    timedOut,
  };
}
