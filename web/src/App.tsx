import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";

const DEFAULT_CODE = `print("hello world")\n`;

function App() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [running, setRunning] = useState(false);

  async function runCode() {
    setRunning(true);
    setStdout("");
    setStderr("");
    try {
      const res = await fetch("http://127.0.0.1:3001/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      setStdout(data.stdout);
      setStderr(data.stderr);
      if (data.timedOut) {
        setStderr((prev) => prev + "\n[killed: exceeded 5s time limit]");
      }

    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <h2>Cloud IDE — Phase 1</h2>
      <button className="run-btn" onClick={runCode} disabled={running}>
        {running ? "Running..." : "Run"}
      </button>
      <div className="editor-wrap">
        <CodeMirror
          value={code}
          height="300px"
          extensions={[python()]}
          onChange={(value) => setCode(value)}
          theme="dark"
        />
      </div>
      <div className="output-label">stdout</div>
      <pre className="output-box">{stdout}</pre>
      <div className="output-label">stderr</div>
      <pre className="output-box stderr">{stderr}</pre>
    </div>
  );

}

export default App;