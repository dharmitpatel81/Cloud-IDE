# Collaborative Cloud IDE

Browser-based IDE, built phase by phase. See [CLAUDE.md](./CLAUDE.md) for the
full project plan, current phase, and the rules for how we build here — read
it before touching anything.

## Setup (Phase 1)

Requires: Node 20+, npm, and [conda](https://docs.conda.io/) (used to isolate
the Python interpreter that runs submitted code).

```bash
# one-time: create the env the backend shells out to
conda create -n cloud-ide-runner python=3.11
```

Every terminal you use for this repo should have the env active:

```bash
conda activate cloud-ide-runner
```

Then, in two separate terminals (both with the env active):

```bash
# terminal 1 — backend, http://127.0.0.1:3001
cd server
npm install
npm run dev

# terminal 2 — frontend, http://localhost:5173
cd web
npm install
npm run dev
```

Open `http://localhost:5173`, write some Python, hit Run.

## Branching

- `main` stays deployable at the current phase.
- Build features on a branch (`git checkout -b your-name/feature`), open a PR,
  merge one at a time.
- Don't build ahead of the phase marked current in `CLAUDE.md`.

## Known limitation (by design, for now)

Phase 1 has no sandboxing — submitted code runs with full local permissions.
See `docs/journal/0001-unsandboxed-execution.md`. Don't run this anywhere but
localhost. This gets fixed in Phase 2.
