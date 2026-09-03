---
paths:
  - "**/Dockerfile*"
  - "**/docker-compose*.yml"
  - "**/docker-compose*.yaml"
  - "infra/docker/**"
---

# Container image rules (Phase 2+)

Images that run user code are a security boundary, not a packaging convenience.

## Every image that runs user code

- **`USER` a non-root uid.** One line, and it removes most of what an escape is worth.
- **No build secrets in layers.** `ARG` values and anything `COPY`'d then deleted stay in
  history. Secrets come in at runtime, never at build.
- **Pin base images by digest**, not `latest` — a reproducible sandbox is a reviewable one.
- Minimal contents. Every extra binary in the image is a tool the user's code gets to run:
  no compilers you don't need, no `curl`, no cloud CLIs. `docker`, `kubectl`, and cloud SDKs
  must never appear.
- Separate image per language runtime. One image with every language is a bigger attack
  surface and a slower cold start.

## Every `docker run` of user code

Required, from the first container in Phase 2 — these are the §3 floor in the root CLAUDE.md:

```
--memory --cpus --pids-limit --read-only  (+ tmpfs for the writable project path)
--cap-drop ALL  --security-opt no-new-privileges
--network none   (until a phase actually needs egress)
```

**Never** `--privileged`, `-v /var/run/docker.sock`, `--network host`, or a bind mount of a
host path outside the project. Each hands over the host outright — if a tutorial suggests one,
it's a tutorial about something else.

## Compose

- Compose runs dev dependencies (Postgres, Redis, MinIO) — **never user workloads.** User code
  is started programmatically by `runner/`, with the flags above.
- Dev credentials in Compose are still not committed as real secrets, and dev ports bind to
  `127.0.0.1`, not `0.0.0.0`. A laptop on café wifi is a public host.
