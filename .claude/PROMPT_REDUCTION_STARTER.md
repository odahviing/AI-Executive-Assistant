# Prompt-reduction chat — starter / handoff (2026-05-29 update)

**Trigger for a new chat:** paste this file as the first message, then say "let's work on prompt reduction" / "let's cut the 46K prefix."

This is an UPDATE layered on the standing plan. Read in this order:
1. The usual context loads (MEMORY.md, project_overview.md, SESSION_STARTER.md, CLAUDE.md).
2. **`.claude/PROJECT_REDUCE_PROMPTS.md`** — the standing prompt-reduction plan (modules A-G, #95). Most modules already shipped; modules A + B remain.
3. **This file** — what a latency-focused session (2026-05-26 → 29) learned about *where the cost actually is*. It reframes the project. Where this contradicts the older doc, this wins (it's based on real token-usage data the old doc didn't have).

---

## Why this update exists

A separate chat spent several days on **latency**, added **token-usage logging**, and got the first real per-call-site cost data. The headline finding changes the prompt-reduction strategy:

### Finding 1 — Sonnet is ~99% of spend, and it's the orchestrator main loop

From `LLM usage` logs (the new instrumentation, see below):
- `orchestrator` label = **~99% of logged LLM cost.** Gates + classifiers are rounding error.
- **Sonnet : Haiku spend ratio ≈ 126 : 1.**
- The auxiliary Haiku migrations done this session (claim-checker, merged classifier) save latency but only cents — they were never where the money was.

**Implication:** cutting cost means cutting the orchestrator's per-call payload (the cached prefix) and/or its iteration count. Nothing else moves the needle.

### Finding 2 — the cached prefix is ~46K tokens, and it's MOSTLY TOOL DEFINITIONS

Real log line (orchestrator iteration 1, fresh thread):
```
cache_creation_input_tokens: 46042   ← the cached prefix, written once per 5-min window
cache_read_input_tokens:     ~46-47K ← every subsequent iteration reads it (cheap)
```

The cached prefix = `tools` array + static system prose (Anthropic caches everything up to the `cache_control` breakpoint on the static system block; `tools` are sent before `system`, so they're in the cache). See `src/core/orchestrator/index.ts:~893` (`cache_control: { type: 'ephemeral' }` on `promptParts.static`).

**Estimated split (NOT yet instrumented — VERIFY FIRST):**
- Static system prose (identity, honesty rules, language, Hebrew, social layer, tone): ~6-9K tokens.
- **48 tool definitions: ~37-40K tokens (~80%).** `find_available_slots` alone ≈ 2K; `create_meeting` / `coordinate_meeting` similar.

⚠️ **Discrepancy to resolve:** the 2026-05-15 measurement in `PROJECT_REDUCE_PROMPTS.md` put tools at ~23K (and said "NOT cached"). Now the cached block is 46K and tools appear to be ~37-40K and ARE cached. Two things changed: (a) the cache restructure pulled tools into the cached prefix; (b) tools likely grew (venue skill, candidate_slots, more). **The new chat's FIRST task is to instrument the precise tools-vs-prose token split** — don't cut on my estimate.

**Implication:** the original project framed reduction as "move prose RULES to code" (modules A-G, ~13K cut). That's still valid but it's attacking the ~6-9K prose, not the ~37-40K tools. **The bigger mass is the tool definitions.** "Kill the big prompt" ≈ "cut the tool surface."

### Finding 3 — the caching tension (matters for the structure choice)

The 46K is *cached*: reads cost $0.30/M (1/10th of $3/M fresh input); creation costs $3.75/M.
- The expensive moment is **cache creation on the first iteration of the first turn in each 5-min window** (~$0.17). It was 58% of one example turn's cost.
- Subsequent iterations read the cache at ~$0.014 each.

**Per-turn scope filtering FRAGMENTS the cache.** The current scope filter (classifyTurn → toolScopes → getSkillTools) ships a different tool subset per turn-type. Each distinct subset is a different cache prefix → more cache misses → more $3.75/M creation hits. **Small-but-unstable can cost more than big-but-stable.** Any tool-reduction work must be designed around cache stability, not just raw token count.

---

## The reframed option set (ranked: lowest-risk / highest-leverage first)

1. **Instrument the exact tools-vs-prose split** (~1 line). Log `JSON.stringify(tools).length` vs `promptParts.static.length` once per turn, or token-estimate both. Resolve the 46K composition before cutting. **Do this first.**

2. **Tool-description audit + trim** — biggest lever, no architecture change, no coherence risk. The 48 tool descriptions have become mini-prompts (embedded rules, multiple examples, edge cases). Much of that belongs in the (scoped) skill prompt, not in a schema billed on every cached turn. Target: cut the tool block by a third with zero behavior change. Pull tool-call frequency from logs first to know which tools even earn their prefix slot.

3. **Tool cull** — drop dead/rarely-fired tools from the default surface. Measure firing frequency from `Tool executed` log lines.

4. **Stable tool *bundles* instead of per-turn subsets** — collapse the scope filter to ~3 fixed bundles (meetings / social / general). Each caches independently and stays warm per domain: small prefix AND cache-stable. Fixes the Finding-3 fragmentation.

5. **Sub-agents — LAST resort.** The real case for them is tool separation + cache stability (a meetings sub-agent ships ~10 stable tools + focused prompt ≈ 12K cached prefix), NOT prose separation. But: router-hop latency, context handoff, and **coherence risk — Maelle's whole value is being ONE assistant.** Heaviest lift, only one that risks the product's voice. Don't start here; 2-4 likely capture most of the win.

---

## What this session already shipped (all UNCOMMITTED in the tree)

These are latency changes; the prompt-reduction chat inherits them. None bundled/version-bumped yet.

- **claim-checker**: extended honesty rules B-G removed (were advisory-only since v2.8.5); moved to Haiku.
- **Merged classifier** (`src/core/social/classifyTurn.ts`): the old `classifyOwnerIntent` (Sonnet) + `classifyToolScope` (Haiku) collapsed into ONE Haiku call. **Module G (intent-aware tools) now lives here** — `classifyTurn` owns scope. The old two files were DELETED; their types moved into `classifyTurn.ts`.
- **autoExpand fix** (`ops.ts`): single-slot validation calls (`create_meeting`/`move_meeting` Guard B) pass `autoExpand:false` — killed ~5s of wasted widening calendar reads per colleague booking.
- **`candidate_slots` on `find_available_slots`**: batch-validate N specific times in one tool call instead of N sequential Sonnet iterations. (Note: this ADDED ~200 tokens to find_available_slots' description — relevant to the tool-trim work.)
- **Token-usage logging** (`src/utils/usageLog.ts` — `logLlmUsage(label, model, response)`): wired into `callClaude` (orchestrator), claim_checker, classify_turn, human_gate, security_gate, concision_pass, close_loop. **This is the measurement tool for the prompt-reduction work.**

---

## Measurement tools

- **Prompt size:** `node scripts/measure-prompts.cjs` (from the standing plan — static/dynamic/tools breakdown, top-10 tools by size). **This is the key tool for prompt reduction — use it before/after every cut.**
- **Live cost per call-site:** parse `LLM usage` log lines. A parser was written at `C:/Users/idanc/AppData/Local/Temp/maelle-cost.js` (groups by label + model, applies rates). Temp may not persist — rebuild if gone: parse `{"message":"LLM usage", label, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, cost = (in*rate_in + out*rate_out + cacheRead*rate_cr + cacheWrite*rate_cw)/1e6. Sonnet ≈ $3/$15 in/out, $3.75 cacheWrite, $0.30 cacheRead. Haiku ≈ $1/$5, $1.25, $0.10. **Verify current rates against Anthropic docs.**
- **Tool firing frequency:** grep `"Tool executed"` log lines, group by `tool` — tells you which of the 48 tools earn their prefix slot.

---

## Key file pointers

- **System prompt builder:** `src/core/orchestrator/systemPrompt.ts` — `buildSystemPromptParts` (static at ~line 429, dynamic at ~646, returns `{static, dynamic}`). The static block is the cached prose.
- **System block assembly + cache breakpoint:** `src/core/orchestrator/index.ts:~878-896` (`systemBlocksDynamic` join; `cache_control` on static at ~893).
- **Tool definitions:** in each skill file's tool list `description` fields. Biggest: `src/skills/meetings.ts` (find_available_slots, create_meeting, coordinate_meeting, move_meeting…).
- **Tool scope filter:** `src/skills/registry.ts` — `getSkillTools(profile, role, scopes)` + `ALWAYS_ON` set. Scope comes from `classifyTurn` (`src/core/social/classifyTurn.ts`).
- **Post-draft gates (each its own Sonnet/Haiku call):** `src/utils/{claimChecker,humanGate,securityGate,dateVerifier}.ts`, plus concision pass in `postReply.ts`.

---

## Operational caveats (read before measuring)

- **A rogue PM2 process was running the OLD compiled code** (`dist/`) alongside `npm run dev` (new code). Slack Socket Mode load-balanced turns between them ~50/50, so half of 2026-05-28's data is OLD-code and contaminates any before/after comparison. **Confirm only ONE process is running** before trusting measurements; clear stale `dist/` (`rm -rf dist/`).
- **PM2 + auto-deploy are nominally OFF**, but something resurrected PM2 — verify `pm2 list` is empty.
- Owner runs `npm run dev`; **restart picks up changes** (uncommitted tree won't be live until restart).
- Filter analysis to NEW-code turns: a turn is new-code iff it emits an `LLM usage` line (old code didn't have the instrumentation).

---

## Standing rules (unchanged — from PROJECT_REDUCE_PROMPTS.md + CLAUDE.md)

- **Propose first, build only on explicit "go/build/do it".** Bundle/version only on "wrap/ship/commit/bundle".
- **Default version bump = PATCH.**
- **No new prompt rules to fix things** — this project REDUCES prompt. Only add a short rule if it replaces a longer deleted one (net negative).
- **Code over prompt** for deterministic things; **trust Sonnet** for judgment. Don't merge rules, don't delete rules just to delete.
- **No personal info in code** (repo is public) — read from `profile.*`.
- **Measure with real numbers**, not estimates — record before→after in each CHANGELOG entry.
- **No `cd <path> &&` prefix** on shell commands.

---

## Recommended first move for the new chat

Don't touch code yet. Start with **Finding-2's open question**: add the one-line instrument that logs the exact `tools` token count vs `static prose` token count per turn, restart, capture a few real turns, and confirm the split. Then pull tool-firing frequency. *Then* propose the tool-description-trim plan with real numbers. Cut with knowledge, not the ~80% estimate.
