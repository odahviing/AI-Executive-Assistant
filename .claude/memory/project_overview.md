---
name: Maelle Project Overview
description: What Maelle is, how she's built (the lane structure), and how a bug or feature reaches production
type: project
---

Maelle is an AI executive assistant platform built in Node.js/TypeScript. She lives primarily on Slack, books meetings against Microsoft Graph (Outlook calendar), reasons with Anthropic Claude (Sonnet 5 for the agentic loop, Haiku for guards/classifiers — see `project_architecture.md`'s LLM layer section), and persists to SQLite via better-sqlite3. Configuration is per-tenant YAML (`config/users/<name>.yaml`); one deployment can host several executives, each with their own Slack app identity.

**Mission / filter for every decision:** "would a real human EA do this?" — outranks speed, completeness, elegance.

**Current shipped version: 4.7.5.** `CHANGELOG.md` is the canonical, in-repo version-by-version history — it is not duplicated here or in `project_architecture.md`. Read it for what actually changed release to release; this file describes the durable shape, not the diff.

## Where she runs

Maelle runs on the GCP VM `maelle-agent-vm` (europe-west4-b) under PM2, not on any contributor's laptop (cutover 2026-07-31). Deploys are automatic: a `git push` to `master` is pulled, built, and restarted by the VM's own watcher within about two minutes. There is exactly one Slack socket — running a second local instance produces `too_many_connections` and is never done. See `project_gcp_migration.md` for the migration history and `reference_cloud_logs.md` for how to read her live logs.

## Transports

Slack is the primary, fully-live surface. Email is live but narrow (v4.3.0+): the owner forwards a scheduling request to Maelle's mailbox, she computes options and replies to him only — a one-address transport by construction, with a much smaller tool allowlist than Slack gets. WhatsApp is built for the owner's own front door (wired, gated on a per-profile phone number no tenant has set) but not open to anyone else yet — see `project_architecture.md`'s Transport layer section for the exact state of each.

## How Maelle gets built — the agent framework

Maelle's own codebase is maintained by a set of charter-bound agents, each owning a slice of the product. This is deliberately summarized here, not reproduced: each agent's actual rules live in its own charter file (`.claude/agents/<name>.md`), and copying them into a second document is exactly the kind of drift that made this file stale for months. `.claude/SESSION_STARTER.md` is the living, actively-maintained source for the current roster, naming conventions, and rule-tag assignments — read it first for anything framework-shaped.

**Eight builder lanes**, each a specialist over one product area: **Matchmaker** (the scheduling/calendar core), **Registrar** (the async requests spine — approvals, outreach, reminders, follow-ups), **Gatekeeper** (the output-time gate stack), **Librarian** (identity, the person store, and — since 2026-08-11 — news, brief content, meeting summaries, venues and the knowledge base), **Instructor** (the system prompt and tool descriptions — runs last in every build wave), **SlackMaster** (everything inside the Slack workspace), **Diplomat** (everything reaching someone outside the workspace — mail today, WhatsApp/iMessage when they open), **Handyman** (whatever no other lane owns yet).

**Non-lane agents** around them: the **Editor** finds and routes bug-shaped work (open GitHub `Bug` issues plus a log review) to the lane that owns the fix; the **Framer** does the same job for product/feature work (an `Improvement`/`Feature` issue, or an idea not filed yet), producing a decomposition the owner rules on before anything builds; the **Bouncer** is the adversarial gate before a wrap — one read over a finished wave's combined diff, asking whether it's safe to ship and whether it meets the bar; the **Cleaner** is a periodic hygiene sweep (dead code, stale comments, dead config) run by hand, not in the nightly rotation; the **Architect** owns the framework itself (the engines, the Manager skill, this file's own upkeep) and never touches product code. (A **Quartermaster** for runtime cost and latency existed for one morning on 2026-08-03 and was deleted the same day; that subject is **Handyman's**, rules H4–H5 (standalone); the tier-is-his-call rule moved to the Shared charter's rule 13 on 2026-08-04.)

## How a bug reaches production

One run of the **Manager** (`/manager`, `.claude/skills/manager/SKILL.md`) does the whole pass: the Editor finds and routes the work → the owning lanes build in parallel (Instructor last, since it depends on what the others land) → the Bouncer runs one combined-diff verify → a cumulative report lands for the owner to read. Agents build within their charter without asking permission per item — that autonomy is the loop's whole point — but **no agent ever commits**. Only the owner wraps: reviews the report, and if he's satisfied, runs the `wrap` skill, which bundles the session's work into a version bump, a `CHANGELOG.md` entry, and a push. The owner triggers every run himself; there is no timer.

## How a feature reaches production

The same Manager, via a different invocation (`.claude/workflows/feature.js`), because feature intake is a product-decision shape, not a bug-triage shape. The Framer reads the ticket (or a bare idea) against the actual code and returns a plan plus any blocking questions — and builds nothing. The owner approves or reshapes it. Only then does a second pass dispatch the owning lanes in dependency order, Instructor last, followed by one Bouncer pass over the combined diff. Same commit rule: the owner wraps, never an agent.

## Related references

- `project_architecture.md` — the deep technical layer: directory structure, the orchestrator loop, the requests-spine state machine, the output-gate security stack, the transport layer, the DB schema. Read it for "how does X actually work in code."
- `.claude/SESSION_STARTER.md` — the living operational front door: current lane roster, rule-tag assignments, open bugs, the framework's own recent history.
- `.claude/ARCHITECTURE_MAP.md` — a one-page diagram-level map (mermaid flowchart of the hot path) for a fast mental refresh.
- `CHANGELOG.md` — canonical version history. This file and `project_architecture.md` describe durable structure; they do not restate what shipped in which release.
