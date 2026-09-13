# 0001 — Yjs CRDT as the collaborative editing wire protocol

Status: Accepted · Date: 2026-09-11 · Phase: 3

## Context

Phase 3 first shipped the obvious design: every CodeMirror change was
broadcast to the room as `{from, to, insert}`, and each client applied what it
received straight to its editor. It worked for sequential typing and failed
completely under concurrency.

Measured with two clients, one taken offline mid-edit: **three of six edits
were delivered, line 2 matched in one position out of five, and the two
documents (25 and 26 bytes) never became identical again.** Full write-up in
`docs/journal/0003-broadcast-cannot-converge.md`.

The cause isn't a bug in the transport. A character offset only means
something relative to one specific document state, so applying a peer's offset
to a document that has diverged is wrong by construction, and each later edit
compounds it. Worse, no correct ordering exists: both users typed at position
21 of their own document at the same instant and both were right, so the
information needed to order them was never in the message.

`CLAUDE.md` §6 names wire protocol as a one-way door, hence this record.

## Decision

Adopt **Yjs** as the document data structure, `y-websocket` as its transport,
and `y-codemirror.next` to bind the Y.Text to the editor. The broadcast code
was deleted rather than patched.

On the client the Y.Doc is the single source of truth for text, with no React
state mirroring it. The server holds each room's authoritative document
through `setupWSConnection` and seeds a new room once via
`setContentInitializor`.

Version note: `y-websocket` split its server half into `@y/websocket-server`,
which depends on a Yjs 14 prerelease, while `y-codemirror.next` requires Yjs
13. Both halves are therefore pinned to `y-websocket@2.1.0`, which still
bundles its server helper and peer-depends on Yjs 13.

## Alternatives rejected

**Sequence numbers, or a server-assigned total order.** Tells you what order
messages were sent in, but ordering was never the problem — each offset was
computed against a different document. Ordering wrong operations consistently
still produces wrong text.

**Authoritative server copy, last write wins.** Moves the question to "whose
version survives," and whoever loses has their typing silently discarded. In
an editor that's a data-loss bug, not a conflict policy.

**Acknowledgements before applying local edits.** Makes typing wait on a
network round trip. Correctness bought by making the editor feel broken.

**Operational Transform.** Genuinely solves convergence, and is what Google
Docs used for years. Rejected because it needs a central server to transform
operations against each other, its transform functions are notoriously hard to
get right, and Yjs gives peer-to-peer convergence with a maintained library
and a CodeMirror binding already written.

## Consequences

Convergence stopped being our problem. The same experiment now delivers **six
of six edits, both documents byte-identical**, reached independently by both
clients with no server arbitration, because CRDT merges are deterministic and
commutative.

A lot of code disappeared with it: the echo-suppression flag, the manual
reconnect loop, the change serializer, and the mirrored React state. Reconnect
handling became a single status listener, and the connection indicator became
honest for free, because `y-websocket` runs its own ping/pong rather than
trusting `readyState`.

What this makes harder:

- **Merged results are deterministic, not intentional.** Concurrent edits at
  the same position interleave by client id. Nobody's text is corrupted, but
  the outcome can be what neither person meant.
- **Persistence must speak Yjs.** Phase 8 will snapshot CRDT state, not a text
  file. Restoring means applying a Y.Doc update, and any external process that
  writes to a project has to go through Yjs too.
- **Documents live in server memory and are currently never freed.** Bounded
  to one room today. Per-project rooms in Phase 4 make lifecycle a real
  question, and it's the Phase 2 leak lesson reappearing at a new layer.
- **Yjs is now load-bearing across the whole stack** — client, server, and
  eventually storage — along with its version compatibility, as the pinning
  above already shows.
- **The editor can no longer be driven by a React `value` prop.** Anything
  that replaces the document wholesale fights the CRDT and gets broadcast to
  everyone as a real edit. Text changes have to go through the Y.Text.

## Update — 2026-09-13

Not a reversal: Yjs stands. Two details above are out of date. Rooms are no
longer seeded through `setContentInitializor`; seeding moved to project
creation, templates were later removed, and rooms now start empty. And the
prediction that "any external process that writes to a project has to go
through Yjs too" came true with the terminal: `server/src/workspaceSync.ts`
turns file changes into minimal Y.Text edits instead of replacing text
wholesale. See ADR 0003.
