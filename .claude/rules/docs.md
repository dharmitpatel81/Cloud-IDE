---
paths:
  - "docs/journal/**"
  - "docs/adr/**"
---

# Journal and ADR rules

## Journal entries

One entry per wall hit. Filename `NNNN-short-slug.md`, e.g. `0003-crdt-divergence.md`.

```markdown
# NNNN — Title
Date: YYYY-MM-DD · Phase: N

**Built:** the naive version, in two or three sentences.
**Broke:** the experiment I ran, and exactly what went wrong.
**Measured:** the number.
**Fixed:** what I changed and why that addresses the cause.
**Would do differently:** what I'd know to check earlier next time.
```

- **No entry without a number in Measured.** "It felt slow" isn't a finding; "cold start p95
  was 34s" is. No number means the wall wasn't measured and the fix is a guess.
- Write it when the wall is hit, not batched at the end of a phase. The specifics — the exact
  error, the wrong guess you made first — are gone in a week, and they're the valuable part.
- Five paragraphs max for the entry itself — a lab notebook, not a blog post. Longer notes
  (diagrams, reproduction steps, review findings) may follow in an optional `## Deep dive`
  appendix below a `---` divider, so the entry stays short and the detail stays findable.
- **Record the wrong turn.** Anyone can read the fix in the final code; only this file says why
  the obvious approach failed.
- Name the general concept (reconciliation, CRDT convergence, trust boundary) so it transfers
  to the next project instead of staying trivia about this one.

## ADRs

Filename `NNNN-short-slug.md`. Four sections: **Context** (the forces, including the measured
number), **Decision**, **Alternatives rejected** (and why), **Consequences** (including what
this makes harder).

- One ADR per one-way door: a datastore, a wire protocol, an isolation boundary, a dependency
  inside `workspace-agent`.
- **Never edit a decision that was later overturned.** Write the new ADR and mark the old one
  `Superseded by NNNN`. The supersession chain is the learning, made legible — it's the part a
  reviewer can't get from reading the final code.
