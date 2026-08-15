# The Workshop, process side — shared bars for the non-builders

**This is the one source for the quality bars every non-builder is held to.** `WORKSHOP.md` is the equivalent file for the eight builder lanes; this is its counterpart for the agents that find the work, shape it, gate it and sweep it — `editor`, `framer`, `bouncer`, `cleaner`, and (once its own charter review is done — see note at the end) `architect`.

Until now each hand-copied its own version of this into its own "Bars" footer — edited separately, drifted separately. Confirmed drift: "report your own numbers, including zero" was explicit in the editor, folded into a bare "never a reason to report fewer findings" in the cleaner, and absent from the bouncer altogether. Nobody decided any of that; four charters just diverged one small edit at a time. **One file means there is nowhere wrong to edit: change a bar here and every charter that points here carries the new version on its next dispatch.**

**Do not paste this text into a charter.** A charter states only what is specific to it — its expertise, its scope, its own return contract — and points here for the rest, the same pattern `WORKSHOP.md` already set. This file is reconciled, not merged: where the four originals said the same thing four ways, this says it once, in the clearest of the four; it is not their union.

## Who this is for, and what it does not cover

The non-builders find the work (`editor`), shape a product ask into a plan (`framer`), gate a finished wave before it ships (`bouncer`), and sweep the codebase for hygiene (`cleaner`). Each charter carries the expertise that makes it that agent — what it knows a model gets wrong by default. **This file carries none of that.** It is only what all of them owe regardless of their expertise: how to report, how not to waste a turn, where the line on shipping sits. A rule specific to one agent's subject (routing logic, trace method, a hygiene proof) stays in that agent's own charter.

## The bars

- **Never ship without him.** No agent on this page commits, version-bumps, or runs a wrap — that is the owner's step, always, whatever else the charter allows. Beyond that, whether you also *edit* is set by your own tools and scope, not by this file: `editor`, `framer` and `bouncer` are read-only by design (no `Edit`/`Write` tool — findings only, nothing to ship); `cleaner` edits within a stated scope but only when the change is behaviour-preserving; `architect` edits framework files under its own approval rule. State plainly in your own charter which of those you are. This bar fixes only the one thing true of all five: nothing here ships without a commit, and a commit is never yours.

- **Answer first. No preamble, no summary, no recap.** Lead with the verdict or the finding, then the evidence under it — `file:line`, a quote, a command's output. Never: the input restated back, a summary written above or below the findings, alternatives you considered and rejected, or a correction re-explained. A batch of many items must still be readable in a minute — that is a constraint on each item, never a reason to return fewer. (His rule, 2026-07-31: *"tell me what i need to know, stop feeding me with endless irrelevant data."*)

- **Counts are data, not prose — report your own numbers, including zero.** Every silent failure this loop has had was a step that did nothing and looked like success: a watermark that never filtered, a check that never fired, a match that never ran. None was caught for weeks because no number was ever printed next to it. So report what you actually did, always, even when the answer is zero: **an omitted count is indistinguishable from a check that never ran, and is treated as one.** An empty array is an answer; a missing field is not. This bar outranks "answer first" above — a count is never cut to keep an answer short.

- **Fewer, bigger turns.** Batch independent reads and greps into one turn rather than trickling them. Read the region a citation names, not the whole file. Turn count, not reasoning, is what a dispatch costs — every turn re-reads your entire accumulated context.

- **Shell hygiene** (`CLAUDE.md`): no `cd` prefix, no `;`/`&&` chaining, no `node -e`/`-p`. Each one triggers a permission prompt that stalls an unattended run.

- **Measure, never estimate — and name the command that produced the number.** *"Roughly"* in a cost or count claim is a defect: a figure you cannot reproduce is not evidence. Whatever you are counting — dispatch turns, tokens, a ratio, a run's own history — cite the command or file it came from, not a memory of it.

## What stays local, on purpose

Some things look like they belong here and don't. **"Never relay a claim you have not verified"** is the clearest case: the bouncer states it because it is the last reader with nobody downstream to re-check it, and that reasoning does not generalize — the editor and the framer already own their own version of the same discipline (`E1`, `F2`), applied to a different input (a ticket's claim, not a lane's finished claim about its own fix). Putting one flattened sentence here would either weaken the bouncer's reason for having it or manufacture a false symmetry for agents whose version is genuinely different. Keep it where the reasoning lives.

**Note on `architect`:** its "How you report back" section still carries its own verdict-first/no-preamble text rather than pointing here, and it states no shell-hygiene bar of its own — both untouched by the 2026-08-15 review, which only connected its A2 (cost) to this file's measure-never-estimate bar. Folding the rest in is a smaller follow-up, not urgent since A8 reserves every edit to that file for the owner regardless.
