import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { python } from "@codemirror/lang-python";
import type { ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";
import { api, ApiError, type Project, type User } from "./api";
import { ClearIcon, FileCodeIcon, FilesIcon, LogoIcon, PlayIcon, ProjectsIcon } from "./icons";

const WS_URL = `ws://${location.host}/collab`;
const FILE_NAME = "main.py";
const REVOKED_CLOSE_CODE = 4001;

const CONNECTION_LABELS: Record<string, string> = {
  connected: "Live",
  connecting: "Connecting…",
  disconnected: "Reconnecting…",
  unreachable: "Offline",
};

type RunOutput = { stdout: string; stderr: string; note: string; failed: boolean };

export function Editor({
  project,
  user,
  onClose,
  onSessionEnded,
}: {
  project: Project;
  user: User;
  onClose: () => void;
  /** Must be referentially stable: it's a dependency of the connection effect. */
  onSessionEnded: () => void;
}) {
  const [output, setOutput] = useState<RunOutput | null>(null);
  const [requestError, setRequestError] = useState("");
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  // The Y.Doc is the source of truth for the text. There is deliberately no
  // React state mirroring its contents — that second copy is what drifts.
  // useState is only here to create one instance and keep it.
  const [ydoc] = useState(() => new Y.Doc());
  const ytext = useMemo(() => ydoc.getText("code"), [ydoc]);

  // The room is the project id, and the server rejects the upgrade unless you
  // own it. App keys this component by project id, so a different project
  // always gets a fresh mount, doc, and provider. `connect: false` matters:
  // StrictMode calls this initializer twice and discards one result, and an
  // unconnected throwaway is harmless where a connected one is a second socket.
  const [provider] = useState(
    () => new WebsocketProvider(WS_URL, project.id, ydoc, { connect: false }),
  );

  // React StrictMode double-invokes this effect in dev: mount, cleanup,
  // mount again, synchronously, on this same provider instance. `destroy()`
  // removes the doc/awareness listeners that make local edits sync at all,
  // and a later `connect()` doesn't restore them — so calling it directly in
  // this cleanup would silently break collaboration in dev. Deferring it
  // lets the synchronous remount cancel it first; a real unmount has nothing
  // left to cancel it, so it actually fires and releases everything.
  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkingSession = useRef(false);

  useEffect(() => {
    if (pendingDestroy.current !== undefined) {
      clearTimeout(pendingDestroy.current);
      pendingDestroy.current = undefined;
    }

    const onStatus = (event: { status: string }) => setConnection(event.status);

    // A failed connection means the server is down *or* this session is gone
    // (the upgrade got a 401 — browsers don't say which). Ask the API to tell
    // them apart, so a signed-out tab doesn't sit on "Offline" forever.
    const onConnectionError = (event: Event) => {
      // StrictMode's dev remount closes the first socket mid-handshake; its
      // late error isn't about the connection we have now.
      if (event.target !== provider.ws) return;
      setConnection("unreachable");
      if (checkingSession.current) return;
      checkingSession.current = true;
      api
        .me()
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            provider.disconnect();
            onSessionEnded();
          }
        })
        .finally(() => {
          checkingSession.current = false;
        });
    };

    // The server closes with 4001 when it revokes this session (signed out
    // in another tab, or expired). Stop reconnecting and go back to sign-in.
    const onConnectionClose = (event: CloseEvent | null) => {
      if (event?.code !== REVOKED_CLOSE_CODE) return;
      provider.disconnect();
      onSessionEnded();
    };

    provider.on("status", onStatus);
    provider.on("connection-error", onConnectionError);
    provider.on("connection-close", onConnectionClose);
    provider.connect();

    return () => {
      provider.off("status", onStatus);
      provider.off("connection-error", onConnectionError);
      provider.off("connection-close", onConnectionClose);
      provider.disconnect();
      pendingDestroy.current = setTimeout(() => {
        provider.destroy();
        // The provider only removes its own listeners; the document (and its
        // awareness timer) lives until it's destroyed too.
        ydoc.destroy();
      }, 0);
    };
  }, [provider, ydoc, onSessionEnded]);

  const extensions = useMemo(
    () => [python(), yCollab(ytext, provider.awareness)],
    [ytext, provider],
  );

  // Must stay referentially stable: the editor wrapper reconfigures every
  // extension whenever this prop's identity changes.
  const onUpdate = useCallback((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    setCursor({ line: line.number, col: head - line.from + 1 });
  }, []);

  async function runCode() {
    if (running) return;
    setRunning(true);
    setOutput(null);
    setRequestError("");
    try {
      const data = await api.run(ytext.toString());
      let note = `Process exited with code ${data.exitCode}`;
      let failed = data.exitCode !== 0;
      if (data.timedOut) {
        note = "Killed: exceeded the 5s time limit";
        failed = true;
      } else if (data.exitCode === 137) {
        // SIGKILL with no stderr is almost always the kernel enforcing --memory.
        note = "Killed: exit 137, likely exceeded the 128MB memory limit";
      }
      setOutput({ stdout: data.stdout, stderr: data.stderr, note, failed });
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }

  // Ctrl/Cmd+Enter runs. Caught in the capture phase, before the event reaches
  // CodeMirror, whose default keymap would otherwise insert a blank line.
  function onEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    // Mid-composition (IME input), Enter commits the text; leave it alone.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void runCode();
  }

  const terminalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = terminalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, requestError, running]);

  const offline = connection === "unreachable";

  return (
    <div className="ide">
      <header className="titlebar">
        <div className="titlebar-left">
          <button type="button" className="brand brand-btn" onClick={onClose} title="All projects">
            <LogoIcon size={16} /> Cloud IDE
          </button>
          <span className="breadcrumb">
            › <strong>{project.name}</strong> › {FILE_NAME}
          </span>
        </div>
        <div className="titlebar-right">
          <span className="kbd">Ctrl+Enter</span>
          <button
            type="button"
            className="btn btn-run"
            onClick={runCode}
            disabled={running}
            title="Run (Ctrl+Enter)"
          >
            <PlayIcon size={12} /> {running ? "Running…" : "Run"}
          </button>
        </div>
      </header>

      <div className="workbench">
        <nav className="activitybar" aria-label="Views">
          <div className="activity active" title="Explorer" aria-current="page">
            <FilesIcon />
          </div>
          <button type="button" className="activity" title="All projects" onClick={onClose}>
            <ProjectsIcon />
          </button>
        </nav>

        <aside className="sidebar">
          <div className="sidebar-header">EXPLORER</div>
          <div className="tree-section">{project.name}</div>
          <div className="tree-item active">
            <FileCodeIcon size={14} className="file-python" /> {FILE_NAME}
          </div>
          <p className="sidebar-note">One file per project for now.</p>
        </aside>

        <main className="editor-area">
          <div className="tabs">
            <div className="tab">
              <FileCodeIcon size={14} className="file-python" /> {FILE_NAME}
            </div>
          </div>

          {offline && (
            <div className="banner" role="status">
              Can't reach the collaboration server. Your edits are kept locally and will sync
              once it's back. Is the backend running on port 3001?
            </div>
          )}

          <div className="editor-host" onKeyDownCapture={onEditorKeyDown}>
            {/* No `value` prop on purpose: passing one makes the wrapper replace
                the whole document whenever it changes, which would clobber the
                CRDT. The editor starts empty, matching the empty Y.Text, and the
                binding delivers the initial sync as a delta. */}
            <CodeMirror height="100%" theme={vscodeDark} extensions={extensions} onUpdate={onUpdate} />
          </div>

          <section className="panel" aria-label="Output">
            <div className="panel-header">
              <span className="panel-tab">OUTPUT</span>
              <button
                type="button"
                className="icon-btn"
                title="Clear output"
                onClick={() => {
                  setOutput(null);
                  setRequestError("");
                }}
              >
                <ClearIcon size={14} />
              </button>
            </div>
            <div className="terminal" ref={terminalRef}>
              {running && <div className="term-muted">Running {FILE_NAME}…</div>}
              {!running && !output && !requestError && (
                <div className="term-muted">Press Run or Ctrl+Enter to execute {FILE_NAME}.</div>
              )}
              {output && (
                <>
                  <div className="term-cmd">$ python {FILE_NAME}</div>
                  {output.stdout && <pre>{output.stdout}</pre>}
                  {output.stderr && <pre className="term-err">{output.stderr}</pre>}
                  <div className={output.failed ? "term-note bad" : "term-note"}>
                    [{output.note}]
                  </div>
                </>
              )}
              {requestError && <div className="term-err">{requestError}</div>}
            </div>
          </section>
        </main>
      </div>

      <footer className={offline ? "statusbar offline" : "statusbar"}>
        <div className="status-group">
          <span className="status-item">
            <span className={`status-dot ${connection}`} />
            {CONNECTION_LABELS[connection] ?? connection}
          </span>
          <span className="status-item">{project.name}</span>
        </div>
        <div className="status-group">
          <span className="status-item">
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="status-item">Python</span>
          <span className="status-item status-email">{user.email}</span>
        </div>
      </footer>
    </div>
  );
}
