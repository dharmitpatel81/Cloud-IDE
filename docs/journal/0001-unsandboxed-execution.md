# 0001 — Unsandboxed execution reads anything on the host

**Built:** A Fastify server with one route, `POST /run`. It takes code from the
browser, writes it to a file in `server/workspace/`, and runs it with a plain
`child_process.spawn("python", [file])`. React + CodeMirror on the frontend,
a Run button, stdout/stderr shown back on the page.

**Broke:** Typed this into the editor and hit Run:

```python
with open(r"C:\Windows\win.ini") as f:
    print(f.read())
```

It printed the file. No error, no permission prompt, nothing. Same thing works
for anything else the local Windows account can read — SSH keys, other
projects, whatever.

**The number:** Zero. That's how many access checks stand between "text typed
in a browser tab" and "read any file my user account can read." Not
partial protection, not filtered, actually zero.

**Why, not just what:** the server doesn't sandbox the code, it just runs it.
`child_process.spawn` doesn't create a new user or a new filesystem view, it
just starts a process, and that process inherits every permission the Node
server itself has, which is every permission I have. There's no real fix for
this at the code level, you can't blocklist your way out of "the interpreter
can do anything a normal program can do." The actual fix is an OS-level
boundary around the whole process, a container, which is Phase 2.

**Would do differently:** nothing, honestly. This is the version you're
supposed to build first so the wall is real instead of theoretical. Trying to
patch this with path filters before moving to containers would've just taught
me that path filters don't work, which is a worse way to learn the same
lesson.
