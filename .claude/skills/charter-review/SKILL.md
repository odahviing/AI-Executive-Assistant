---
name: charter-review
description: |
  The Workshop chat's deep, rule-by-rule pass over one agent charter (.claude/agents/*.md) — done interactively with the owner, one charter at a time, never rushed. Fixes stale citations, reviews scope/frontmatter, cross-checks the changelog for undecided product decisions, lists every rule for owner approval in plain language, takes feedback, and lands one clean renumbering sweep at the end. Triggered when the owner says "let's go over the X charter", "charter review", "go over librarian/matchmaker/gatekeeper/etc", or similar. First run: librarian.md, 2026-08-18 — use that pass as the worked template when in doubt.
---

# Charter review

Seven steps, in order, one charter at a time. Don't start the next charter until this one is clean end to end.

**Keep every response short and direct — this is a back-and-forth, not a report.** Owner's ruling, 2026-08-18: long answers are hard to track across a long session. State the change or the answer, skip the surrounding explanation unless asked for it. This applies hardest in steps 4-7, where the owner is reacting rule by rule — one line per rule confirmed, a couple lines for anything that needs a decision.

**Builder charters are his; non-builder charters are mostly the framework's.** Owner's observation, 2026-08-19, after framer: a builder's rules (Matchmaker, Registrar, Gatekeeper, ...) encode his own product opinions — reviewing one is a real negotiation over what Maelle should do. A non-builder's rules (editor, framer, bouncer, cleaner, architect) are mostly Workshop machinery — schema-field contracts and process mechanics for how the framework itself runs, not product taste. Expect a non-builder pass to move faster: the question per rule is usually "is this mechanism sound and minimal," not "do I personally want this," and a rule that's pure field-plumbing (names a literal engine schema field, verify with grep before assuming) doesn't need the same depth of debate a product rule earns.

**No renumbering before the owner has been through the WHOLE charter once — this is settled, stop asking.** Owner's ruling, 2026-08-18: doing it earlier creates confusion; renumbering only ever happens in the one final run, step 7. This holds no matter which step surfaces a numbering problem — a vacant tag found in step 1's citation check, an out-of-file-order tag found in step 2's scope review, a gap opened by step 4 feedback. Note it (one line) and move on; don't offer it as a choice, don't fix it early even when it looks trivial.

## 1. Fix citations and stale comments

Grep every `file:line` citation in the charter — frontmatter tag-map notes, inline rule citations, the orient section's pointer into `project_architecture.md` — against the actual current code. A recent CHANGELOG entry naming a rewrite ("the social layer, rebuilt," "profiler becomes librarian") is the first place to suspect drift; a rewritten file shifts every line number below it.

This is architect's own "third kind" bug (`architect.md` A4) — a citation gone stale needs no owner ruling. Fix it directly, no need to ask. Also check the orient section's own claim about a shared doc for staleness — it can end up describing a problem that was already fixed elsewhere, becoming stale itself.

## 2. Review the charter outside the rules

Frontmatter description, opening narrative, "What you own" / "you do NOT own" scope lines. Look for:
- A dated tag-mapping bookkeeping note ("L14 moved to L2 on...", "vacant, never reused") — banned as of the owner's 2026-08-18 ruling (see step 7). Strip on sight.
- A scope claim about a sibling lane that no longer matches that lane's current charter.
- Narrative that restates what a shared doc (`WORKSHOP.md`, `project_architecture.md`) already says.

**Scope verification — does the ownership list match reality, not just read plausibly?** Citation-checking (step 1) confirms a `file:line` still points where it claims; this is a different, missed check for a while: does the *set* of things claimed still match the codebase, in both directions. For every file/mechanism named in "What you own," confirm it still exists, still does what's claimed, and is still owned by this lane, not quietly moved to a sibling during an unrelated wave. Then flip it: does anything fall inside the charter's own scope *description* — the plain-English sentence, not the file list — that isn't named anywhere in the list? A new file, a new dispatcher, a mechanism added since the charter was last touched. Re-verify every "you do NOT own → [sibling]" line the same way: is that sibling's current charter still the one that actually claims it. **Best delegated to the lane itself** — it knows its own codebase better than a read from outside can — so dispatch the builder agent to self-audit its own scope section as part of closing the charter, rather than guessing at completeness from the charter text alone.

## 3. Cross-check the CHANGELOG for undecided product decisions

Read back through **4.3.0 through HEAD** — the owner's ruling, 2026-08-18: that's roughly when the Workshop/charter framework itself started (4.1.0 was the agent squad's own creation), so anything before it predates this whole process and isn't fair game to expect a charter caught. Everything from 4.3.0 on is real risk — the first pass on librarian/instructor/diplomat/slackmaster only checked 4.5.3-HEAD and missed the 4.3.0-4.5.2 range entirely; re-run step 3 against the fuller window for any charter already closed under the shorter one. For anything in this charter's territory, look for: Look specifically for:
- A real behavioral reversal ("a new colleague is no longer permanently unreachable socially").
- A new numeric or threshold decision — a cap, a window, a ranking (a 3-category cap, a once-a-day throttle).
- A rewritten subsystem whose new rules never made it into the charter as rules.

Don't flag a plain bug fix that doesn't change any standing decision — only genuinely new, durable, non-obvious calls. If something looks like a framework/process bug instead of a product one (e.g. the same fix double-logged across two changelog versions), flag it separately as architect's territory — don't fold it into this charter's list.

## 4. List every rule for owner approval, long form

One rule at a time or in small batches — never dump the whole rule list with no substance and call it reviewed. State what each rule actually means in plain language, not just its one-line label.

**Every rule opens with a short category tag** (2-4 words — "Identity — record creation," "Access — write authority," "Social — outbound throttle") so its kind is scannable before reading the mechanism. Standard as of 2026-08-18; apply retroactively to a charter's already-written rules the first time it goes through this process.

Take feedback rule by rule. **Do not reorder or renumber tags during this pass**, even when a rule gets cut, merged, or a gap opens — that gets closed once, at the end (step 7). Renumbering mid-pass means sweeping `src/` citations twice for no reason.

## 5. Verify anything the owner questions against the actual code

"Isn't this risky," "who said this," "seems like a duplicate" are real questions, not rhetorical ones — grep the actual implementation and check git history before answering. Don't guess and don't reassure without checking.

Worked example, and its correction: the owner asked whether librarian's gender-authority ranking (`owner > person > auto`) was risky. Verifying in `src/db/people.ts`'s `SET_BY_RANK` and the `confirm_gender` handler in `src/core/assistant.ts` confirmed exactly what the code does — a colleague's own later correction of their own gender really is refused if the owner set it first. That confirmed the MECHANISM, not that it was wrong. The owner's actual ruling: **not a bug — owner wins over person, deliberately, consistent with L5's write-authority model where the owner already outranks everyone for every field.** Verifying against code tells you what the code does; it never tells you which side is *right* when a rule looks inconsistent with another — that is always the owner's call, never something to infer from the code and dispatch a fix for.

**An agent never fixes its own charter's rules or authority model, however "obviously" a discrepancy reads.** Only the owner rules on that; the lane just executes it once decided. Don't propose "send it to the lane to fix" for anything that is actually a decision about what the system *should* do — reserve that offer for a genuine implementation bug the owner has already agreed is wrong.

A rule that traces to zero owner ruling AND zero currently-shipped behavior is unearned narration (`architect.md` A17's decision check) — flag it. A rule that traces to real shipped behavior, even with no single explicit ruling moment behind it, is fine to keep as an honest description — say so plainly either way, and if the owner still doesn't want it as a numbered rule, it can move to unnumbered prose instead of being cut outright (see the retention rule's demotion to an unnumbered history paragraph in librarian.md, 2026-08-18).

## 6. Compile ONE consolidated summary, only once feedback is exhausted

Applied changes vs. still-open items (needs an owner decision) vs. deliberately deferred (e.g. a structural reorg held for step 7). Don't summarize partway through a charter — wait until the owner has reacted to every rule in the file at least once, then give the whole picture in short.

## 7. Clean the charter: one final pass, then move on

Resolve every remaining open item first. Then, in one dispatch:
- Renumber sequentially, no gaps, no vacant slots.
- Strip any dated tag-mapping note — git history carries that, the live file only states what's true now (owner's ruling, 2026-08-18: *"we will remove clauses, merge ones, and reuse numbers — don't want to hear about keeping comments and such"*).
- Sweep every citation of a changed tag — in `src/`, the ledger, and any sibling charter that cross-references this one (e.g. a sibling charter citing one of `architect.md`'s own tags) — in the same pass, with before/after grep-count proof (architect's A10 standard).
- Confirm every rule carries its category label from step 4.
- **Full read-through of the whole file, once, as a document** — not just the enumerated items above. A charter edited piecemeal across a long session (rewrites, a merge, a demotion to prose, new rules inserted) accumulates seams a targeted diff won't catch: a citation to a tag that moved but wasn't part of this sweep, a section intro that no longer matches what's under it, duplicated content, a stale count in the frontmatter. This step is "make it perfect," not "make the enumerated items correct" — fix anything genuinely broken that turns up, not only what was asked for.

This mechanical sweep is exactly what the architect dispatch did for `librarian.md` on 2026-08-18 — reuse that dispatch's structure (exact old→new mapping, collision-safe simultaneous substitution via placeholders, explicit carve-out for genuinely historical dated narrative vs. live citations) as the template prompt for the next charter.

Then move to the next charter.
