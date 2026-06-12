---
description: Post-build paper-trace — generate a scenario matrix for the change just built, trace each against code on disk, demand 100%
argument-hint: [what was built / which change to verify]
---

Run the `trace` skill on: $ARGUMENTS

If `$ARGUMENTS` is empty, trace the most recent build in this conversation (the change most recently written to disk).

Process: define the contract under test → generate the scenario matrix (original incident replayed, symmetry directions, every actor/path, boundaries, no-regression cells, fail-open paths, escape hatches, adjacent consumers) → trace each scenario against the CODE ON DISK with file:line citations → grade at 100% or stop and report the gap. Output is one table + honest footnotes + the score. STRICT paper exercise — reads only.
