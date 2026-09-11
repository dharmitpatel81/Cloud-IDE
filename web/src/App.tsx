import { useState, useRef, useEffect, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";

const DEFAULT_CODE = `print("hello world")\n`;
const WS_URL = "ws://127.0.0.1:3001";
const ROOM = "cloud-ide";

function App() {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [ready, setReady] = useState(false);

  // The Y.Doc is the source of truth for the text. There is deliberately no
  // React state mirroring it — that second copy is what drifts.
  const ydocRef = useRef<Y.Doc | null>(null);
  if (!ydocRef.current) ydocRef.current = new Y.Doc();
  const ydoc = ydocRef.current;
  const ytext = useMemo(() => ydoc.getText("code"), [ydoc]);

  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const initialText = useRef("");

  useEffect(() => {
    const p = new WebsocketProvider(WS_URL, ROOM, ydoc);

    p.on("status", (event: { status: string }) => setConnection(event.status));
    p.on("sync", (isSynced: boolean) => {
      if (!isSynced) return;
      // Seed only if the room is genuinely empty, otherwise every client that
      // joins would append another copy of the default.
      if (ytext.length === 0) ytext.insert(0, DEFAULT_CODE);
      // The binding assumes editor doc === ytext at attach time.
      initialText.current = ytext.toString();
      setReady(true);
    });

    setProvider(p);
    return () => p.destroy();
  }, [ydoc, ytext]);

  const extensions = useMemo(
    () => (provider ? [python(), yCollab(ytext, provider.awareness)] : [python()]),
    [provider, ytext],
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
      <button className="run-btn" onClick={runCode} disabled={running || !ready}>
        {running ? "Running..." : "Run"}
      </button>
      <div className="editor-wrap">
        {ready ? (
          <CodeMirror
            value={initialText.current}
            height="300px"
            theme="dark"
            extensions={extensions}
          />
        ) : (
          <div className="editor-placeholder">connecting to the room…</div>
        )}
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
