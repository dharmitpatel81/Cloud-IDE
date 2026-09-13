import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { api, ApiError, type Project, type User } from "./api";
import { CodeEditor, type Cursor } from "./CodeEditor";
import { FileExplorer, type Draft } from "./FileExplorer";
import { TerminalPanel } from "./Terminal";
import {
  KIND_LABELS,
  baseName,
  createFile,
  createFolder,
  deleteEntry,
  fileKind,
  parentOf,
  projectFs,
  renameEntry,
  runtimeFor,
  snapshotFiles,
  useFiles,
  useMapKeys,
  useMapValue,
  type EntryRef,
} from "./files";
import { ClearIcon, CloseIcon, FileTypeIcon, HomeIcon, LogoIcon, PlayIcon } from "./icons";

const WS_URL = `ws://${location.host}/collab`;
const REVOKED_CLOSE_CODE = 4001;
const PROJECT_DELETED_CLOSE_CODE = 4004;

const CONNECTION_LABELS: Record<string, string> = {
  connected: "Live",
  connecting: "Connecting…",
  disconnected: "Reconnecting…",
  unreachable: "Offline",
};

// Browser-safe choices: Ctrl+N, Ctrl+W and Ctrl+Tab belong to the browser and
// can't be taken over by a page, so file and tab commands use Alt instead.
const SHORTCUTS: [string, string[]][] = [
  ["Run the open file", ["Ctrl+Enter"]],
  ["New file / folder", ["Alt+N", "Alt+Shift+N"]],
  ["Close tab", ["Alt+W"]],
  ["Previous / next tab", ["Alt+[", "Alt+]"]],
  ["Rename / delete in explorer", ["F2", "Delete"]],
  ["Find and replace", ["Ctrl+F"]],
  ["Suggestions", ["Ctrl+Space"]],
  ["Toggle comment", ["Ctrl+/"]],
  ["Move line up / down", ["Alt+↑", "Alt+↓"]],
];

type RunOutput = { command: string; stdout: string; stderr: string; note: string; failed: boolean };

export function Workspace({
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
  const [runningPath, setRunningPath] = useState<string | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [loaded, setLoaded] = useState(false);
  const [cursor, setCursor] = useState<Cursor>({ line: 1, col: 1 });
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  // Tabs hold file ids, not paths, so a tab stays open when anyone renames it.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // The Y.Doc is the source of truth for every file. There is deliberately no
  // React state mirroring file contents — that second copy is what drifts.
  // useState is only here to create one instance and keep it.
  const [ydoc] = useState(() => new Y.Doc());
  const fs = useMemo(() => projectFs(ydoc), [ydoc]);

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
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (pendingDestroy.current !== undefined) {
      clearTimeout(pendingDestroy.current);
      pendingDestroy.current = undefined;
    }

    const onStatus = (event: { status: string }) => setConnection(event.status);

    // Until the first sync the maps are empty because nothing has arrived
    // yet, not because the project is empty.
    const onSync = (isSynced: boolean) => {
      if (isSynced) setLoaded(true);
    };

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
    // in another tab, or expired) and 4004 when the project was deleted.
    // Either way, stop reconnecting and leave.
    const onConnectionClose = (event: CloseEvent | null) => {
      if (event?.code === REVOKED_CLOSE_CODE) {
        provider.disconnect();
        onSessionEnded();
      } else if (event?.code === PROJECT_DELETED_CLOSE_CODE) {
        provider.disconnect();
        onClose();
      }
    };

    provider.on("status", onStatus);
    provider.on("sync", onSync);
    provider.on("connection-error", onConnectionError);
    provider.on("connection-close", onConnectionClose);
    provider.connect();

    return () => {
      provider.off("status", onStatus);
      provider.off("sync", onSync);
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
  }, [provider, ydoc, onSessionEnded, onClose]);

  const files = useFiles(fs);
  const folderPaths = useMapKeys(fs.folders);
  const pathById = useMemo(() => new Map(files.map((file) => [file.id, file.path])), [files]);

  // Tabs are derived from what still exists. When a collaborator deletes a
  // file you have open, its tab simply drops out — no effect has to notice.
  const tabs = useMemo(() => openTabs.filter((id) => pathById.has(id)), [openTabs, pathById]);
  const activeId = activeTab !== null && pathById.has(activeTab) ? activeTab : (tabs.at(-1) ?? null);
  const activePath = activeId === null ? null : (pathById.get(activeId) ?? null);
  const activeText = useMapValue(fs.contents, activeId);
  const activeKind = activePath ? fileKind(activePath) : null;
  const runtime = activePath ? runtimeFor(activePath) : null;

  function flashNotice(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  }

  function openFile(id: string) {
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveTab(id);
  }

  function closeTab(id: string) {
    const index = tabs.indexOf(id);
    const remaining = tabs.filter((tab) => tab !== id);
    setOpenTabs(remaining);
    if (id === activeId) setActiveTab(remaining[Math.min(index, remaining.length - 1)] ?? null);
  }

  function cycleTab(step: number) {
    if (tabs.length === 0) return;
    const index = activeId ? tabs.indexOf(activeId) : 0;
    setActiveTab(tabs[(index + step + tabs.length) % tabs.length]);
  }

  function createFromDraft(draft: Draft, name: string): string | null {
    try {
      if (draft.kind === "folder") createFolder(fs, draft.dir, name);
      else openFile(createFile(fs, draft.dir, name));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Couldn't create that.";
    }
  }

  function renameFrom(ref: EntryRef, newName: string): string | null {
    try {
      renameEntry(fs, ref, newName);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Couldn't rename that.";
    }
  }

  async function runActiveFile() {
    if (runningPath !== null) return;
    if (!activePath) {
      flashNotice("Open a .py or .js file to run it.");
      return;
    }
    if (!runtime) {
      flashNotice(`${baseName(activePath)} can't run. Run works on .py and .js files.`);
      return;
    }

    // The whole project goes along, so imports between files work. Two files
    // can end up with one name when two people create it at the same moment.
    const seen = new Set<string>();
    for (const file of files) {
      const key = file.path.toLowerCase();
      if (seen.has(key)) {
        setOutput(null);
        setRequestError(`Two files are named ${file.path}. Rename one, then run again.`);
        return;
      }
      seen.add(key);
    }
    const snapshot = snapshotFiles(fs, files);

    const path = activePath;
    setRunningPath(path);
    setOutput(null);
    setRequestError("");
    try {
      const data = await api.run(path, snapshot);
      let note = `Process exited with code ${data.exitCode}`;
      let failed = data.exitCode !== 0;
      if (data.timedOut) {
        note = "Killed: exceeded the 5s time limit";
        failed = true;
      } else if (data.exitCode === 137) {
        // SIGKILL with no stderr is almost always the kernel enforcing --memory.
        note = "Killed: exit 137, likely exceeded the 128MB memory limit";
      }
      setOutput({ command: `${runtime} ${path}`, stdout: data.stdout, stderr: data.stderr, note, failed });
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setRunningPath(null);
    }
  }

  // Registered in the capture phase, so these run before CodeMirror sees the
  // key (its keymap would otherwise turn Ctrl+Enter into a blank line).
  // Re-registered each render so the handlers always see current state.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (mod && !event.altKey && event.key === "Enter") {
        claim();
        if (!event.repeat) void runActiveFile();
        return;
      }
      if (mod && !event.altKey && event.key.toLowerCase() === "s") {
        claim();
        flashNotice("Not saved to disk yet: files live in server memory, so a restart loses them.");
        return;
      }
      // Alt only. Ctrl+Alt is AltGr on many keyboards, which types characters.
      if (!event.altKey || mod) return;
      // event.code, not event.key: on a Mac, Option+N produces "˜", not "n".
      switch (event.code) {
        case "KeyN":
          claim();
          if (loaded) {
            setDraft({
              kind: event.shiftKey ? "folder" : "file",
              dir: activePath ? parentOf(activePath) : "",
            });
          }
          return;
        case "KeyW":
          claim();
          if (activeId) closeTab(activeId);
          return;
        case "BracketLeft":
          claim();
          cycleTab(-1);
          return;
        case "BracketRight":
          claim();
          cycleTab(1);
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, requestError, runningPath]);

  const offline = connection === "unreachable";
  const running = runningPath !== null;

  // Two open tabs called "index.js" get their folder shown, like VS Code.
  const tabNameCounts = new Map<string, number>();
  for (const id of tabs) {
    const name = baseName(pathById.get(id) ?? "");
    tabNameCounts.set(name, (tabNameCounts.get(name) ?? 0) + 1);
  }

  return (
    <div className="ide">
      <header className="titlebar">
        <div className="titlebar-left">
          <button type="button" className="icon-btn" title="All projects" onClick={onClose}>
            <HomeIcon size={26} />
          </button>
          <span className="project-title">{project.name}</span>
        </div>
        <div className="titlebar-right">
          <span className="user-chip">
            <span className="user-email">{user.email}</span>
            <span className="avatar" aria-hidden="true">
              {user.email.charAt(0).toUpperCase()}
            </span>
          </span>
        </div>
      </header>

      {offline && (
        <div className="banner" role="status">
          Can't reach the collaboration server. Your edits are kept locally and will sync once
          it's back. Is the backend running on port 3001?
        </div>
      )}

      <div className="workbench">
        <aside className="sidebar">
          <FileExplorer
            projectName={project.name}
            files={files}
            folderPaths={folderPaths}
            loaded={loaded}
            activeId={activeId}
            draft={draft}
            onDraftChange={setDraft}
            onOpen={openFile}
            onCreate={createFromDraft}
            onRename={renameFrom}
            onDelete={(ref) => deleteEntry(fs, ref)}
          />
        </aside>

        <main className="editor-area">
          {tabs.length > 0 && (
            <div className="tabs" role="tablist">
              {tabs.map((id) => {
                const path = pathById.get(id) ?? "";
                const active = id === activeId;
                const name = baseName(path);
                return (
                  <div
                    key={id}
                    className={active ? "tab active" : "tab"}
                    title={path}
                    onAuxClick={(event) => {
                      // Middle-click closes, as in every tabbed app.
                      if (event.button === 1) closeTab(id);
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className="tab-label"
                      onClick={() => setActiveTab(id)}
                    >
                      <FileTypeIcon path={path} size={14} />
                      {name}
                      {(tabNameCounts.get(name) ?? 0) > 1 && (
                        <span className="tab-dir">{parentOf(path) || "/"}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="tab-close"
                      title="Close (Alt+W)"
                      aria-label={`Close ${name}`}
                      onClick={() => closeTab(id)}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {activePath && (
            <div className="crumbs">
              {activePath.split("/").map((part, i) => (
                <span key={i}>
                  {i > 0 && <span className="crumb-sep">›</span>}
                  {part}
                </span>
              ))}
            </div>
          )}

          <div className="editor-host">
            {activePath && activeText ? (
              <CodeEditor
                path={activePath}
                ytext={activeText}
                awareness={provider.awareness}
                onCursor={setCursor}
              />
            ) : (
              <div className="welcome">
                <LogoIcon size={72} />
                <dl className="shortcut-list">
                  {SHORTCUTS.map(([label, keys]) => (
                    <div key={label} className="shortcut">
                      <dt>{label}</dt>
                      <dd>
                        {keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        </main>

        <aside className="output-pane" aria-label="Output">
          <div className="output-head">
            <button
              type="button"
              className="btn btn-run"
              onClick={runActiveFile}
              disabled={running || !runtime}
              title={runtime ? "Run (Ctrl+Enter)" : "Open a .py or .js file to run it"}
            >
              {running ? "Running…" : "Run"} <PlayIcon size={14} />
            </button>
            <span className="kbd">Ctrl+Enter</span>
            <button
              type="button"
              className="icon-btn output-clear"
              title="Clear output"
              onClick={() => {
                setOutput(null);
                setRequestError("");
              }}
            >
              <ClearIcon size={18} />
            </button>
          </div>
          <div className="output-box" ref={outputRef}>
            {running && <div className="term-muted">Running {runningPath}…</div>}
            {!running && !output && !requestError && (
              <div className="term-muted">Code output will appear here…</div>
            )}
            {output && (
              <>
                <div className="term-cmd">$ {output.command}</div>
                {output.stdout && <pre>{output.stdout}</pre>}
                {output.stderr && <pre className="term-err">{output.stderr}</pre>}
                <div className={output.failed ? "term-note bad" : "term-note"}>[{output.note}]</div>
              </>
            )}
            {requestError && <div className="term-err">{requestError}</div>}
          </div>
        </aside>
      </div>

      <section className="terminal-pane" aria-label="Terminal">
        <TerminalPanel projectId={project.id} />
      </section>

      <footer className={offline ? "statusbar offline" : "statusbar"}>
        <div className="status-group">
          <span className="status-item">
            <span className={`status-dot ${connection}`} />
            {CONNECTION_LABELS[connection] ?? connection}
          </span>
          {notice && (
            <span className="status-item" role="status">
              {notice}
            </span>
          )}
        </div>
        <div className="status-group">
          {activePath && activeKind && (
            <>
              <span className="status-item">
                Ln {cursor.line}, Col {cursor.col}
              </span>
              <span className="status-item">{KIND_LABELS[activeKind]}</span>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
