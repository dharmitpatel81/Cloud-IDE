import { useState, useRef, useEffect, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";

const WS_URL = "ws://127.0.0.1:3001";
const ROOM = "cloud-ide";

function App() {
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

  // Built once and never replaced, so the editor's extensions stay stable and
  // yCollab doesn't mint a second undo manager. Connecting is the effect's job.
  const providerRef = useRef<WebsocketProvider | null>(null);
  if (!providerRef.current) {
    providerRef.current = new WebsocketProvider(WS_URL, ROOM, ydoc, { connect: false });
  }
  const provider = providerRef.current;

  useEffect(() => {
    const onStatus = (event: { status: string }) => setConnection(event.status);
    provider.on("status", onStatus);
    provider.connect();
    return () => {
      provider.off("status", onStatus);
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
      const res = await fetch("http://127.0.0.1:3001/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ytext.toString() }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        setError(`Server error (${res.status}). Your code did not run.`);
        return;
      }
      const data = await res.json();
      setStdout(data.stdout);
      setStderr(data.stderr);
      if (data.timedOut) {
        setStderr((prev) => prev + "\n[killed: exceeded 5s time limit]");
      } else if (data.exitCode === 137) {
        setStderr((prev) => prev + "\n[killed: exit 137, likely exceeded the 128MB memory limit]");
      } else if (data.exitCode) {
        setStderr((prev) => prev + `\n[exited with code ${data.exitCode}]`);
      }
    } catch {
      setError("Could not reach the server. Is it running on port 3001?");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <h2>Cloud IDE — Phase 3</h2>
      <div className="output-label">socket: {connection}</div>
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

export default App;
