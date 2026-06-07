# Bug-chat task — L-12 (shadow-notify tool-name regex)

Small, latent code fix from the v3.3.0 audit. **Propose-first**: read the two cited sites, confirm, then fix. Run `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json` from `E:/Code/Maelle` after.

---

## L-12 (T-8) — Tool-name extraction regex drops digits/capitals

**Files** (two sites, same pattern):
- `src/connectors/slack/postReply.ts:376` — `s.match(/^\[([a-z_]+)/)?.[1] ?? ''` (builds the shadow-DM tool hint, e.g. "(create_meeting, message_colleague)")
- `src/core/orchestrator/index.ts:1938` — `s.match(/^\[([a-z_]+)/)` (builds the grounded-confirmation fallback when Sonnet returned no user-facing text)

**Bug story**: both regexes extract the tool name from an action-tape marker like `[create_meeting OK …]` using the character class `[a-z_]+`. That matches lowercase letters and underscores only. Every tool name today is lowercase snake_case, so it works — but the day someone registers a tool with a **digit** (`book_block_v2`) or a **capital** (`manageRoutine`), the regex silently truncates the name (`book_block_v` / `manage`) or drops it entirely. The shadow hint and the fallback confirmation would then show a wrong/blank tool name. Pure latent — no live bite today.

**Fix**: broaden the class at BOTH sites to `[a-z0-9_]+` (or `[a-zA-Z0-9_]+` if you want to be capital-safe too). One-line each. Keep the `^\[` anchor.

**Risk**: trivial — strictly widens what matches; today's lowercase names are unaffected. **Cost**: 1-min.

---

## NOT included: L-8 (R-5) — already fixed, do nothing

The original handoff listed R-5 ("catch-up runs after `app.start()` — amplifies the double-reply race"). I verified on disk: this is **already fixed**. `src/index.ts` now runs **Phase 2 (catch-up) BEFORE Phase 3 (`app.start()`)**, and the `await` on catch-up is load-bearing (Phase 2 comment + invariant #5/#10 in `docs/AGENT_LOOP_INVARIANTS.md`). There is nothing to send for L-8. If the owner expected an L-8 fix, the numbering may have drifted — confirm which finding was meant.
