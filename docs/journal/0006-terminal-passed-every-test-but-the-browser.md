# 0006 — The terminal passed every test except the browser
Date: 2026-09-13 · Phase: 4

**Built:** xterm.js in the browser, a WebSocket, and `docker exec` with a TTY
on the server. Tested it with a Node script that opened the socket, sent the
init message, typed `pwd && ls`, and printed what came back. It printed a
prompt and the right output, so I reported the terminal as working.

**Broke:** Opened in Chrome, the panel was blank. I then reported it fixed
twice more, each time from reading code rather than looking at it, and it was
blank both times.

**Measured:** **Six independent bugs** stood between the script and a working
terminal. The script could see exactly one of them, and I misread it: its very
first output began with a stray `H` before `[?2004h`. That `H` was byte 0x48,
the length field of Docker's 8-byte stream header — framing that should not
exist on a TTY stream — and I dismissed it as escape-code noise. **Two "it's
fixed" claims were wrong.** Driving the real app in headless Chrome found every
remaining bug in its first run.

**Fixed:** The six (detail below): React StrictMode disposing xterm mid-setup;
a CSS variable passed as a canvas font; the init message reusing `/run`'s
schema, so an *empty* project silently never got a shell; the first prompt
printed before anyone was listening; `Tty` set when creating the exec but not
when starting it; and the size message landing before the shell existed. The
fix that mattered more was the process: a Playwright script that signs up,
creates a project, waits for `$`, types, and screenshots — the path a user
actually takes.

**Would do differently:** This is the third time. Journal 0003 had experiment
runs that didn't isolate the variable; 0004's curl didn't send the header the
browser sent; now a Node client that isn't React, has no canvas, and always
sent a file. The rule: **a test proves the thing it exercises, and nothing
next to it.** If the product is a page in a browser, the test is a browser.
And an unexplained byte in the output is a finding, not noise.

---

## Deep dive

### The six, and why the script couldn't see them

| # | Symptom in Chrome | Cause | Why the script missed it | Fix |
|---|---|---|---|---|
| 1 | Crash, blank panel | StrictMode mounts, disposes, remounts in one tick; xterm's renderer finishes setup asynchronously and hit a disposed instance | Not React | Defer setup one tick, so the synchronous remount cancels it (same trick as the Yjs provider) |
| 2 | Terminal alive but invisible | `fontFamily: "var(--font-mono)"` — xterm measures cells on a canvas, and canvas can't resolve CSS variables | No canvas | Literal font stack |
| 3 | Never starts on an empty project | Init reused `/run`'s file list schema, which requires ≥1 file; the invalid init was ignored silently | Always sent a file | No minimum; an invalid init now closes the socket with a reason |
| 4 | Blank until you type | The shell prints its prompt the instant it starts, before the tab is attached to the output | Timing happened to work | Keep the last 64 KB of output and replay it to each tab that attaches |
| 5 | Garbage before the prompt | `Tty: true` on `exec` create but not on `exec.start`, so Docker kept its 8-byte stream framing | **Visible** — the stray `H` — and ignored | `Tty: true` on start too |
| 6 | Lines wrapping in the wrong place | The resize message arrived before the shell existed and was dropped | Never checked wrapping | Send the size inside the init message |

### What each wrong "fixed" was based on

1. After fixing #1: "the crash matches the error signature, so it's fixed."
   True, and #2 was right behind it.
2. After fixing #2: "a CSS variable can't work on a canvas, so that's it." Also
   true, and #3 and #4 were right behind it.

Both diagnoses were correct. The claim that the feature worked was the error —
each was a statement about one bug, reported as a statement about the product.

### The browser harness

`playwright-core` driving the installed Chrome (no browser download): sign up,
create a project, open it, wait for `.xterm-rows` to contain `$`, click into
the terminal, type, wait for output, screenshot, and collect console errors.
It later caught two more bugs in the same way — the file mirror's first
version, and the explorer showing `node_modules`.
