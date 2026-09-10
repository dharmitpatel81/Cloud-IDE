import { useState, useRef, useEffect } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";


const DEFAULT_CODE = `print("hello world")\n`;
const COLLAB_URL = "ws://127.0.0.1:3001/collab";


function App() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState("connecting");

  const viewRef = useRef<EditorView | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const applyingRemote = useRef(false);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    function connect() {
      const ws = new WebSocket(COLLAB_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnection("connected");

      ws.onmessage = (event) => {
        const view = viewRef.current;
        if (!view) return;
        const change = JSON.parse(event.data);
        // Apply the peer's edit at the position THEY computed it for.
        applyingRemote.current = true;
        view.dispatch({ changes: change });
        applyingRemote.current = false;
      };

      ws.onclose = () => {
        if (closed) return;
        setConnection("reconnecting");
        retry = window.setTimeout(connect, 1000);
      };
    }

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);


  async function runCode() {
    setRunning(true);
    setStdout("");
    setStderr("");
    setError("");
    try {
      const res = await fetch("http://127.0.0.1:3001/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        // Without this, a failed run renders exactly like a successful one that printed nothing.
        setError(`Server error (${res.status}). Your code did not run.`);
        return;
      }
      const data = await res.json();
      setStdout(data.stdout);
      setStderr(data.stderr);
      if (data.timedOut) {
        setStderr((prev) => prev + "\n[killed: exceeded 5s time limit]");
      } else if (data.exitCode === 137) {
        // SIGKILL with no stderr is almost always the kernel enforcing --memory.
        setStderr(
          (prev) => prev + "\n[killed: exit 137, likely exceeded the 128MB memory limit]",
        );
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
      <h2>Cloud IDE — Phase 2</h2>
      <div className="output-label">socket: {connection}</div>

      <button className="run-btn" onClick={runCode} disabled={running}>
        {running ? "Running..." : "Run"}
      </button>
      <div className="editor-wrap">
        <CodeMirror
          value={code}
          height="300px"
          extensions={[python()]}
          theme="dark"
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
          onChange={(value, viewUpdate) => {
            setCode(value);
            if (applyingRemote.current) return;
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            viewUpdate.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              ws.send(JSON.stringify({ from: fromA, to: toA, insert: inserted.toString() }));
            });
          }}
        />

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