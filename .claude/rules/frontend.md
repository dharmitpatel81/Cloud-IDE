---
paths:
  - "web/**"
  - "apps/web/**"
---

# Frontend rules

## The client is not a security boundary

- Anyone can open devtools and call the API directly. **Every check the UI makes exists on the
  server too.** Hiding a button is UX, never enforcement.
- **No secrets in the bundle.** Anything reaching `import.meta.env.VITE_*` is public — no API
  keys, no S3 credentials, no signing secrets. A feature that seems to need one in the client
  needs a server endpoint instead.
- Tokens live in memory or an httpOnly cookie, never `localStorage` — an XSS in an app that
  renders other users' content walks straight out with it.

## Rendering other people's content

This app displays filenames, code, and terminal output written by other users.

- **Never `dangerouslySetInnerHTML`** on anything from the server. Terminal output goes through
  xterm.js; code goes through the editor; filenames render as text.
- Treat a collaborator's name, cursor label, and filename as hostile strings.

## Editor state (from Phase 3)

- **The Yjs document is the single source of truth for text.** Don't mirror the buffer into
  React state and sync the two — that second copy is the bug. Render from the doc; let the
  binding own it.
- Local edits apply optimistically and reconcile through the CRDT. Never block typing on a
  server round trip.

## Connections

- **Assume the socket drops.** Every WebSocket gets reconnect with exponential backoff and
  jitter, and the UI shows connection state honestly — "reconnecting" is information the user
  needs; a silent dead socket is a bug report.
- Bound anything queued while offline. Unbounded buffering turns a blip into a tab crash.
- **Degrade, don't white-screen.** If the runtime dies, the editor stays open and readable
  with the terminal marked unavailable. Losing the sandbox must never look like losing work.

## Shape

- Server payload types come from the shared package — no hand-written duplicates drifting out
  of sync with the API.
- Fetches have timeouts and a rendered error state. "Loading forever" is not an error state.
