# Agent-loop invariants — the load-bearing facts no comment in code states clearly

This doc captures the silent invariants the orchestrator + transport + gate stack rely on. Each one is "this works because X" — break X and the system drifts in a way that won't typecheck-fail or grep-find. If you're refactoring, read this first.

Last refresh: v3.3.x (after the post-3.3.0 audit wave).

---

## 1. `turnLeftWorkPending` is **sticky once set**

Where: `core/orchestrator/index.ts`. Inside the tool loop, when Maelle calls a tool that "parks" work for someone else (coordinate_meeting initiating, message_colleague with await_reply, create_approval, outreach_send), `turnLeftWorkPending` flips to `true` and **stays true** for the remainder of the turn.

Why it matters: this flag is the gate for whether a social coda fires at end-of-turn (`v3.2.5`). If Maelle is mid-flight (returned a question to a participant, pending approval, etc.), no coda. Clearing it mid-turn would let an unrelated tool call reset it and produce a coda after-the-fact attached to mid-flight work — the "btw that Samuel L. Jackson movie…" non-sequitur class.

**Don't**: re-initialize per tool call. **Do**: only set true, never set false within the turn.

---

## 2. `cache_control` is attached ONLY to the static prompt block

Where: `core/orchestrator/index.ts:905-910`. The system prompt is split into `promptParts.static` (skills + rules) and `promptParts.dynamic` (date, people, threadContext, action tape, etc.). Only `static` gets `cache_control: { type: 'ephemeral' }`.

Why it matters: Anthropic caches based on cumulative byte equality. If the static block accidentally becomes dynamic (a date interpolated into the skills section, a turn-specific signal mixed in), every turn invalidates the cache → cost explodes silently. No test currently asserts the static block stays static.

**Don't**: inject anything per-turn into the static section. **Do**: prefer adding to the dynamic block even if it makes that block larger.

---

## 3. MPIM senderRole is clamped **before** the orchestrator ever sees `input`

Where: `connectors/slack/app/processMessage.ts:111-123` (moved out of the orchestrator by gh#154's permission layer, v4.5.0 — this used to be a mutation of `input.senderRole` inside `core/orchestrator/index.ts`; now `role` is resolved once at the Slack transport boundary and handed to the orchestrator already clamped). When an MPIM message arrives, `role` is clamped to `'colleague'` even for the owner, while `isOwnerInGroup` is computed separately and stays `true`. Downstream code has TWO senderRole-ish signals: `input.senderRole === 'colleague'` AND `input.isOwnerInGroup === true`. The COMBO means "owner-in-MPIM, gets colleague tools."

Why it matters: any code that reads `input.senderRole` alone gets a misleading answer on owner-in-MPIM. Permission checks that read both fields work; checks that read only senderRole silently downgrade the owner.

**Don't**: rely on `senderRole` alone for permission gates. **Do**: check `(senderRole === 'owner' || isOwnerInGroup === true)` for owner-tier intent.

---

## 4. Tool-call cache treats `{ error: string }` as not-cacheable; `summarizeToolCall` treats same shape as FAILED — consistent by accident

Where: `utils/toolCallCache.ts` + `utils/orchestratorTurnSummary.ts`. Tools returning `{ error: 'rule_violation', message: '...' }` are NOT cached (would poison retries) AND are stamped `FAILED` in the tool-summary for the claim-checker.

Why it matters: a future tool that returns `{ error: 'unrecoverable' }` legitimately (terminal state, not retryable) would still be marked FAILED and flagged by the claim-checker. The two consumers happen to agree on the `{error}` shape; if one drifts, retries leak through.

**Don't**: introduce a third "tool result envelope shape" without updating both consumers. **Do**: keep using `{ error: string }` as the universal failure sentinel.

---

## 5. `processedDedup`'s 10-min TTL is load-bearing across catch-up + socket-flush

Where: `connectors/slack/processedDedup.ts:28` + `core/background.ts:483` + `index.ts` Phase ordering (post-v3.3.x audit fix C-4).

The TTL covers: (a) Slack re-delivering the same event within a single live process (the original use case); (b) **also** the gap between catch-up posting a reply (and stamping ts) and Slack flushing the queued event to the live socket after `app.start()`. Without (b), the live handler would re-process the event and double-reply.

This works because **`index.ts` Phase 2 (catch-up) runs BEFORE Phase 3 (`app.start()`)**. Catch-up populates the dedup Set; socket flush hits the populated Set.

Why it matters: re-ordering Phase 2 and Phase 3 silently breaks (b). The Phase comments in `index.ts` explain this — keep them, and don't fire-and-forget catch-up (the `await` in Phase 2 is load-bearing).

**Don't**: race catch-up against `app.start()`. **Do**: keep the await + phase order.

---

## 6. `CalendarEvent.categories` is on the type — the 23 `as unknown as` casts are gone

Where: `connectors/graph/calendarTypes.ts:12` (`calendar.ts` re-exports it now — the file split into `calendarTypes`/`calendarReads`/`calendarMutations`/`findAvailableSlots`). The field is canonical now.

Why it matters: pre-v3.3.x audit, ~23 sites cast `(ev as unknown as { categories?: string[] })` because the field was structurally on Graph's response but missing from our type. We added it to the type and deleted every cast. A future reader who reverts the type field (thinking it's redundant) will resurface all 23 casts AND the next person to add a usage will use the cast pattern.

**Don't**: remove `categories?: string[]` from `CalendarEvent`. **Do**: just use `ev.categories ?? []`.

---

## 7. `news.md` is owner-taught free text — CODE DOES NOT PARSE IT

Where: `skills/news.ts:parseNewsPrefs`. The function returns `{ interestsText: md }` and that's it. Earlier versions regex'd `Preferred sources:` / `Blocked sources:` lines into Tavily include/exclude_domains; that was deleted in v3.3.x because (a) it was an implicit format contract on free-text owner content (any other phrasing silently dropped) and (b) it violated the skillPreferences architecture invariant ("free-text — LLM reads, code doesn't parse").

Why it matters: Tavily now runs unsteered; source preferences live in the LLM compose pass via the prompt context. If anyone re-introduces a parser to "re-enable source filtering," they'll re-create the silent-drop bug.

**Don't**: parse news.md in code. **Do**: trust the compose pass to weigh sources based on the free text the owner wrote.

---

## 8. `COLLEAGUE_ALLOWED_TOOLS` is enforced at TWO layers, by design

Where: `skills/registry.ts:302` (the Set) + `skills/registry.ts:filterToolsByScope` (shipping-layer filter) + `skills/registry.ts:executeSkillTool` (dispatch chokepoint, added v3.3.x).

Why it matters: layer 1 (filter) keeps Sonnet from SEEING owner-only tools. Layer 2 (chokepoint) refuses if Sonnet somehow names one anyway. If layer 1 has a bug (Module G coverage gap), layer 2 catches.

**Don't**: assume layer 1 alone is enough. **Do**: add new owner-only tools to BOTH:
- Layer 1: leave them OUT of `COLLEAGUE_ALLOWED_TOOLS`.
- Layer 2: the chokepoint reads the same Set; nothing to add (one source of truth).

The 4-name `ownerOnlyTools` Set in `core/assistant.ts:430` is a NARROWER set (tools whose colleague-self rewrite makes no sense — e.g. `manage_preference`). The chokepoint at registry covers everything; the assistant.ts Set is in-handler defense for the specific tools that share AssistantSkill.

---

## 9. The thread-action engine ONLY runs on `!isMpimChannel && threadTs !== event.ts && threadFetchOk`

Where: `connectors/slack/app/handlers.ts:1032-1106` (`app.ts` split into `app/handlers.ts` + `app/processMessage.ts` since). The owner-presence gate runs for mid-thread real-channel mentions only.

Why it matters: top-of-thread channel mention (`threadTs === event.ts`) falls through to normal orchestrator processing — colleague role, no owner authority. That's the design: people can use Maelle in channels by @-mentioning at top-of-thread, and her response is colleague-tier.

MPIM thread mentions are handled by the MPIM owner-in-group authority model elsewhere. Channel mid-thread mentions need owner-presence to grant owner-tier action.

**Don't**: widen this gate to top-of-thread. **Do**: if you need to broaden colleague responses in channels, do it at the orchestrator's colleague path, not in thread-action territory.

---

## 10. Catch-up's `markProcessed(msgTs)` fires BEFORE the reply post

Where: `core/background.ts:746` (inside `replayMissedMessage`, which starts at `:740`). The mark happens before `chat.postMessage`. If we re-ordered (mark after post), Slack's at-least-once re-delivery in the window between post and mark could double-reply.

Why it matters: even with C-4's Phase-2-before-Phase-3 ordering, the dedup Set is the line of defense against any future race where catch-up + live overlap.

**Don't**: move the `markProcessed` call after the post. **Do**: keep it pre-post.

---

## 11. The owner-presence gate uses `last 5 messages` only (post-v3.3.x)

Where: `core/threadActions/index.ts:ownerPostedInThread`. We slice to the last 5 messages before checking owner presence.

Why it matters: pre-v3.3.x the gate scanned the ENTIRE thread. A "👍" from owner months ago granted any thread participant indefinite owner-tier authority. The recency window makes the gate read "is the owner currently engaged here?" not "has the owner ever touched this thread."

Sender-is-owner short-circuit at `connectors/slack/app/handlers.ts:1111-1112` handles "owner @-mentions Maelle in any thread" — that bypasses this gate entirely, so the recency window only filters the non-owner @-mentioner case.

**Don't**: remove the slice. **Do**: tune the window size if real-world data shows 5 is too tight.

---

## 12. The identity-spoof judge sees `last 15 user messages` (post-v3.3.x)

Where: `utils/securityGate.ts:judgeIdentityClaim`. Inside the judge's prompt construction, `recentUserMessages.slice(-15)`.

Why it matters: pre-v3.3.x sliced to last 5, which let attackers pad 5 benign turns after an impersonation claim to push it out of window. 15 is enough to cover realistic conversation padding without ballooning prompt cost. The claimed-email regex `detectClaimedEmail` is still bounded to same-domain only — that's the cheap pre-filter; the judge is the precision layer.

**Don't**: tighten back to 5. **Do**: if you see padding attacks with 15-turn padding, the right move is a different detection layer (not a wider window).
