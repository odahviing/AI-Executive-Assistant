# Person-memory / stored-attribute layer — product plan

Status: **Phase 1 BUILT (2026-06-24), typecheck clean, NOT yet bundled/restarted.** Phases 2 (sweep) pending.
Author: memory-rebuild chat. Grounded in a file:line trace of the layer on 2026-06-24.

---

## 0. The problem, in one line

Maelle stores facts about people (name, native-script name, language, timezone, gender,
location) and steers outbound behavior off them forever — but the store can't tell a fact
**the owner taught her** from a **guess she made from one message**, and can't fix a guess
that turned out wrong. So a one-off freezes, drives every future message, never
self-corrects.

Three live failures, one root:

| Incident | Stored | Reality | What shipped to the human |
|---|---|---|---|
| **Yael / names** | name transliterated fresh at send time | she spells it עידן / עדי / יעל | עידן→אידן, עדי→אדי, יעל→יאל — wrong spelling, every reply |
| **Ayala / language** | `language_preference = Hebrew` (guessed once) | she writes English | a Hebrew relay to an English speaker |
| **Gidon / timezone** | `timezone = Europe/Amsterdam` (guessed once) | he's in Israel now | meeting times presented in Amsterdam |

---

## 1. The model — two questions for every stored fact

### Q1 — Did the owner tell me, or did I guess?
- **Owner told me** → trusted, **sticky**, it wins, nothing auto-overwrites it.
- **I guessed it** → it's a *guess*. **A guess never silently steers how Maelle talks to
  someone.** A guess either gets confirmed, or it defers to the live signal.

### Q2 — Do I need to store this, or can I look it up live?
- **Language** is the case: don't freeze a "preference." Read what they're writing **right
  now**; **default English**. The owner can still *pin* a language to override.

That's the whole model. Everything below is these two rules applied.

**The one structural change underneath it:** every steering attribute must carry *"guess
or owner-told?"*. Today only `gender`/`timezone`/`state` carry provenance — and even they
steer at full authority regardless of who set them. The fix is one rule applied
everywhere: **guess → does not steer; owner/confirmed → steers.**

**Explicitly cut from scope** (this is where the first draft over-grew): no
`person_attribute_signal` evidence table, no "count N agreeing chats to auto-promote"
thresholds, no schema-wide provenance migration. Auto-promotion ("she's written English 5
times, stop asking") is a **future nice-to-have**, not this build.

---

## 2. How the three bugs are fixed

| Bug | Rule | Behavior after |
|---|---|---|
| **Ayala (language)** | Q2 — derive live | Writes English → gets English. Default English. Owner-pin overrides. |
| **Gidon (timezone)** | Q1 — a guess doesn't steer | Guessed TZ stays marked a guess. **Before it changes a time shown to a human, Maelle confirms it once.** Owner-set = sticky, no confirm. |
| **Yael (names)** | store once, freeze, never re-guess | Name kept as **English + native form**, captured once (from how they write it, or owner-taught), frozen. Owner correction permanent. |

---

## 3. Names — English + native form (generic, not Hebrew-specific)

Names are both an identity key *and* a steering attribute, and today they're neither
governed. The fix is **language-agnostic** — Hebrew is just the owner's case; a French
colleague gets the accented French form, a Russian one gets Cyrillic.

- **`name`** (unchanged) = the Latin / Slack identity *mirror*. Slack keeps overwriting it;
  it's how we match and show owner-facing rosters. English address form.
- **`name_native`** (new, governed) = how this person writes their own name in their own
  script. Replaces the Hebrew-only `name_he` concept. Carries provenance (guess vs owner).

**Rendering changes from "transliterate at send" to "resolve once → freeze → reuse":**

1. Composing in a non-Latin / native language → if `name_native` is owner/confirmed, **use
   it verbatim. Never re-transliterate a governed value.**
2. If `name_native` is absent → transliterate **once**, **store the result as a guess**,
   use it. Every later send reads the stored value — so even an unconfirmed native name is
   **stable**, not re-guessed each reply (this alone kills the עידן↔אידן drift).
3. The person's **own** spelling, when they write their own name in-thread, is the
   strongest signal → capture it; owner correction promotes it to sticky.
4. Owner correction ("עידן not אידן") = sticky. End of drift.

The spelling is decided in **data with provenance**, not re-derived in the prompt every
reply ([systemPrompt.ts:491-502](src/core/orchestrator/systemPrompt.ts) rule moves
prompt→data).

---

## 4. Side-by-side: today vs proposed

| Concern | Today | Proposed |
|---|---|---|
| Name (Latin) | Slack overwrites unconditionally ([people.ts:367](src/db/people.ts)) | Unchanged — Latin mirror |
| Name (native script) | Hebrew-only `name_he`, no provenance, transliterated fresh per reply → drift | Generic `name_native`, provenance-tracked, transliterate-once-then-freeze |
| Language outbound | Stored frozen pref ([resolver.ts:641](src/core/requests/resolver.ts)) | **Derived** from recent inbound thread; default English; owner-pin override |
| Timezone outbound | Guessed value used silently ([resolver.ts:659](src/core/requests/resolver.ts)) | Guessed TZ **confirms once before steering** a shown time; owner-set steers silently |
| Does a guess steer outbound? | **Yes, full authority** | **No** — defers to live signal, or confirms first |
| Provenance coverage | 3 fields (gender/timezone/state) | + name_native, + language is derived not stored |
| Owner-set facts | win for the 3 ranked fields only | sticky and win, everywhere they steer |
| Self-correction | none | language self-corrects by being live; guesses confirm-or-defer |

---

## 5. Build phases

**Phase 1 — the three live bugs (the whole point).**
- **Language**: derive outbound from the recent inbound thread, default English; keep an
  owner-pin override. Stop reading a frozen `language_preference` to steer.
  (sites: [resolver.ts:641](src/core/requests/resolver.ts), capture-pass language write)
- **Names**: introduce governed `name_native` (provenance) + transliterate-once-then-freeze;
  move the Hebrew render rule from prompt → data; generalize off Hebrew-only.
- **Timezone**: a guessed timezone confirms once before it steers a presented time;
  owner-set steers silently.
- **Guess-doesn't-steer rule**: the minimal "is this a guess?" marker on the steering
  attributes touched above (not a schema-wide refactor).

**Phase 2 — cleanup / sweep.**
- One-time correction of polluted rows (Ayala language, Gidon TZ, drifted names).
- Trim the stale **coord-state-machine section** from `project_architecture.md` memory
  (coord was fully removed in v3.5.0).
- Sweep leftover memory bugs from the parallel chats.

**Future (not now):** auto-promotion of repeated guesses to confirmed (the
evidence-counting idea, cut from this build).

---

## 6. Decisions — all locked (2026-06-24)

1. **Language** → derive from recent inbound thread, **default English**, owner-pin override.
2. **Names** → **English + native form**, generic across languages (not Hebrew-specific),
   transliterate-once-then-freeze.
3. **Guessed timezone** → **confirm before steering** (not silent-for-math).
4. **Owner-set** → sticky, wins, never auto-overwritten.
5. **Scope** → kept small: no evidence ledger / promotion thresholds / schema-wide
   migration. Three live bugs first.

---

## 7. Key file:line index (for the build session)

- `upsertPersonMemory` unconditional name write — [people.ts:367](src/db/people.ts)
- provenance rank + `setCoreFieldWithProvenance` — [people.ts:132](src/db/people.ts), [people.ts:260-308](src/db/people.ts)
- profile_json writer (no provenance) — [people.ts:455-473](src/db/people.ts)
- Hebrew render rule (prompt, to move to data) — [systemPrompt.ts:491-502](src/core/orchestrator/systemPrompt.ts)
- capture pass extract + apply — [capturePass.ts:100-131](src/memory/capturePass.ts), [capturePass.ts:195-325](src/memory/capturePass.ts)
- live inbound language detect — [detectMessageLanguage.ts:44-90](src/utils/detectMessageLanguage.ts), called [orchestrator/index.ts:1023](src/core/orchestrator/index.ts)
- language read for relay — [resolver.ts:641](src/core/requests/resolver.ts)
- timezone read for relay / slot — [resolver.ts:659](src/core/requests/resolver.ts), [attendeeAvailability.ts:120](src/utils/attendeeAvailability.ts)
- memory write tools — [assistant.ts:99-204](src/core/assistant.ts) (update_person_profile), [assistant.ts:248-278](src/core/assistant.ts) (confirm_gender)
