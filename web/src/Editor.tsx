import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";
import { api, type Project } from "./api";

const WS_URL = `ws://${location.host}/collab`;

export function Editor({ project, onClose }: { project: Project; onClose: () => void }) {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState("connecting");

  // The Y.Doc is the source of truth for the text. There is deliberately no
  // React state mirroring it — that second copy is what drifts.
  const ydocRef = useRef<Y.Doc | null>(null);
  if (!ydocRef.current) ydocRef.current = new Y.Doc();
  const ydoc = ydocRef.current;
  const ytext = useMemo(() => ydoc.getText("code"), [ydoc]);

  // The room is the project id, so each project gets its own document, and
  // the server rejects the upgrade unless you own that project. Built once
  // per project so the editor's extensions stay stable.
  const providerRef = useRef<WebsocketProvider | null>(null);
  const providerProjectId = useRef<string | null>(null);
  if (providerRef.current && providerProjectId.current !== project.id) {
    providerRef.current.destroy();
    providerRef.current = null;
  }
  if (!providerRef.current) {
    providerRef.current = new WebsocketProvider(WS_URL, project.id, ydoc, { connect: false });
    providerProjectId.current = project.id;
  }
  const provider = providerRef.current;

  useEffect(() => {
    const onStatus = (event: { status: string }) => setConnection(event.status);
    // Without this the label reads "connecting" forever when the server is
    // simply down — y-websocket only reports "disconnected" if it had
    // connected at least once.
    const onConnectionError = () => setConnection("unreachable");

    provider.on("status", onStatus);
    provider.on("connection-error", onConnectionError);
    provider.connect();

    return () => {
      provider.off("status", onStatus);
      provider.off("connection-error", onConnectionError);
      provider.disconnect();
    };
  }, [provider]);

  const extensions = useMemo(
    () => [python(), yCollab(ytext, provider.awareness)],
    [ytext, provider],
  );

  async function runCode() {
    setRunning(true);
    setStdout("");
    setStderr("");
    setError("");
    try {
      const data = await api.run(ytext.toString());
      setStdout(data.stdout);
      setStderr(data.stderr);
      if (data.timedOut) {
        setStderr((prev) => prev + "\n[killed: exceeded 5s time limit]");
      } else if (data.exitCode === 137) {
        setStderr((prev) => prev + "\n[killed: exit 137, likely exceeded the 128MB memory limit]");
      } else if (data.exitCode) {
        setStderr((prev) => prev + `\n[exited with code ${data.exitCode}]`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <button type="button" className="link-btn" onClick={onClose}>
          ← Projects
        </button>
        <h2>{project.name}</h2>
      </div>
      <div className="output-label">socket: {connection}</div>
      {connection === "unreachable" && (
        <div className="error-banner">
          Can't reach the collaboration server. Your edits are saved locally and
          will sync once it's back. Is the backend running on port 3001?
        </div>
      )}
      <button className="run-btn" onClick={runCode} disabled={running}>
        {running ? "Running..." : "Run"}
      </button>
      <div className="editor-wrap">
        {/* No `value` prop on purpose: passing one makes the wrapper replace
            the whole document whenever it changes, which would clobber the
            CRDT. The editor starts empty, matching the empty Y.Text, and the
            binding delivers the initial sync as a delta. */}
        <CodeMirror height="300px" theme="dark" extensions={extensions} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="output-label">stdout</div>
      <pre className="output-box">{stdout}</pre>
      <div className="output-label">stderr</div>
      <pre className="output-box stderr">{stderr}</pre>
    </div>
  );
}
