import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const WS_URL = `ws://${location.host}/terminal`;
const MAX_BACKOFF_MS = 10_000;

type ConnState = "connecting" | "open" | "reconnecting";

const CONNECTION_LABELS: Record<ConnState, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
};

/** A real shell in the project's sandbox — one per project, shared by every
 *  tab that opens it (like `tmux attach`), not a private shell per tab. Its
 *  /workspace is the project: the server mirrors the folder and the shared
 *  document into each other, so a file made here shows up in the explorer,
 *  and an edit in the editor is on disk for the next command. */
export function TerminalPanel({ projectId }: { projectId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<ConnState>("connecting");

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | undefined;

    function setup() {
      let closed = false;
      let attempt = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let ws: WebSocket | null = null;

      const term = new XTerm({
        fontSize: 14,
        // A literal stack, not var(--font-mono): xterm measures character
        // cells on a canvas, and the Canvas 2D `font` property can't resolve
        // a CSS custom property — it silently keeps the default font instead,
        // which throws off cell sizing and leaves the terminal blank.
        fontFamily: "Cascadia Code, 'JetBrains Mono', Consolas, 'Courier New', monospace",
        theme: { background: "#0f0f0f", foreground: "#d4d4d4", cursor: "#d4d4d4" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      if (hostRef.current) term.open(hostRef.current);

      // fit() reads the container's current layout box; calling it while
      // that box is still zero-sized (a layout not yet settled) sends xterm
      // nonsense dimensions and it throws deep inside its renderer later.
      function safeFit() {
        const el = hostRef.current;
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
      }
      safeFit();

      function connect() {
        if (closed) return;
        setConnection(attempt === 0 ? "connecting" : "reconnecting");
        const socket = new WebSocket(`${WS_URL}/${projectId}`);
        socket.binaryType = "arraybuffer";
        ws = socket;

        socket.onopen = () => {
          if (closed) return;
          attempt = 0;
          setConnection("open");
          safeFit();
          socket.send(JSON.stringify({ type: "init", cols: term.cols, rows: term.rows }));
        };
        socket.onmessage = (event) => {
          if (typeof event.data === "string") return; // no text frames from the server today
          term.write(new Uint8Array(event.data as ArrayBuffer));
        };
        socket.onclose = () => {
          if (closed) return;
          const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
          attempt++;
          retryTimer = setTimeout(connect, backoff + Math.random() * backoff * 0.3);
        };
      }
      connect();

      const onData = term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
      });

      const resizeObserver = new ResizeObserver(() => {
        safeFit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
      if (hostRef.current) resizeObserver.observe(hostRef.current);

      return () => {
        closed = true;
        clearTimeout(retryTimer);
        resizeObserver.disconnect();
        onData.dispose();
        ws?.close();
        term.dispose();
      };
    }

    // React StrictMode double-invokes this effect in dev: mount, cleanup,
    // mount again, synchronously. xterm.js defers part of its renderer setup
    // to run asynchronously after `open()`, so creating a terminal and
    // disposing it again in the same tick races that setup and crashes deep
    // inside xterm's internals. Deferring the real work lets the synchronous
    // remount cancel it first — the same trick `Workspace.tsx` uses to defer
    // the Yjs provider's `destroy()` for the same underlying reason.
    const timer = setTimeout(() => {
      if (!cancelled) teardown = setup();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      teardown?.();
    };
  }, [projectId]);

  return (
    <div className="term-xterm-wrap">
      <div className="term-xterm" ref={hostRef} />
      {connection !== "open" && <div className="term-conn-banner">{CONNECTION_LABELS[connection]}</div>}
    </div>
  );
}
