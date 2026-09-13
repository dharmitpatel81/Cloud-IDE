# 0007 — The trusted server was following links the sandbox made
Date: 2026-09-13 · Phase: 4

**Built:** To let the shell and the editor share files, a mirror in the server
(`workspaceSync.ts`) polls the terminal's folder and writes editor changes into
it. That folder is bind-mounted read-write into the container. The file-writing
code came from `projectFiles.ts`, whose comment said no `realpath` was needed
"because the folder is brand new and only we write into it."

**Broke:** Found by cross-checking the code against `backend.md` ("path
containment after `realpath`, so symlinks can't step out"), not by an incident.
The premise of that comment stopped being true the moment a container could
write to the folder. The experiment: in a throwaway container with the same
kind of bind mount, run `ln -s /etc/hostname`, `ln -s ../../package.json`, and
a link to a sibling file, then look at all three from the host server's side.

**Measured:** **3 of 3 links made inside the container are real symbolic links
on the host** (`lstat().isSymbolicLink()` is true). On this Windows + Docker
Desktop machine, reading through them failed with `EACCES`, so **0 of 3 were
followable here** — luck of the platform, not a defense. On Linux or macOS,
`../../package.json` resolves to the server's own folder. The mirror already
skipped links when *reading*, but when *writing* an editor change it called
`writeFile` on whatever sat at that path, and `writeFile` follows links.

**Fixed:** Every write, mkdir and delete the mirror does now checks each part of
the path with `lstat` first and refuses if any part is a link; reads re-check
with `lstat` just before reading. This narrows the hole without closing it: a
shell can swap a link in between the check and the write — **time-of-check to
time-of-use**. Closing it means the trusted server never touches a folder that
untrusted code can write. The mirror belongs inside the sandbox, talking to
the server over a socket — that's Phase 6's `workspace-agent`, and now I know
why it exists.

**Would do differently:** Re-read every "this is safe because…" comment when
the code is reused somewhere new. The comment was right where it was written;
copying the code into a new context silently broke its premise. The general
concept is the **trust boundary**: CLAUDE.md's target shape is a trusted
control plane that never runs user code and an untrusted data plane that
never holds a credential. A trusted process reading and writing files an
untrusted process controls is the control plane reaching into the data plane —
the exact violation, made by accident.

---

## Deep dive

### The experiment's output

```
inside the container (ls -la /w):
  abs-link   -> /etc/hostname
  real.txt
  rel-escape -> ../../package.json
  rel-inside -> real.txt

from the host (Node on Windows):
  abs-link    isSymbolicLink true   readFile EACCES
  real.txt    isSymbolicLink false  readFile "real\n"
  rel-escape  isSymbolicLink true   readFile EACCES
  rel-inside  isSymbolicLink true   readFile EACCES
```

Even `rel-inside`, a harmless link to a sibling file, failed to read on the
host. Windows can't resolve a link Linux wrote, which is why nothing broke
here — and why "it didn't break on my machine" is no evidence either way.

### What an attack would have looked like on a Linux host

1. In the terminal: `rm notes.txt && ln -s ~/.ssh/authorized_keys notes.txt`
   (any path the *server's* user can write).
2. The mirror sees `notes.txt` is no longer a regular file.
3. Anyone with the project open types into `notes.txt` in the editor.
4. The mirror calls `writeFile(".../notes.txt", text)`, the host follows the
   link, and the server overwrites a file outside the project, as the server's
   user.

The container never left its sandbox. It just left a link lying where the
trusted process would follow it.

### Why `lstat` checks can't be the final answer

Check-then-write is two steps, and the attacker controls the timing between
them. The durable fixes don't leave a gap: either the process that writes
lives *inside* the same boundary as the attacker (so following a link can only
reach sandboxed files), or file operations are done relative to an
already-open directory handle with no-follow flags. The first is the
`workspace-agent` design; the second isn't portable to this Windows host.
