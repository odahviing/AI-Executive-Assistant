# Project: Unified Person Store — the #1 next build

**Owner directive (2026-05-31):** This is THE key item. Build **all phases in one go** — not phased across versions. One place that holds *every* person Maelle knows, internal AND external, with their data + history, so when she books (or anything) she already has the context (past bookings, preferences, notes). Internal people carry more (Slack, Graph free/busy); external carry less — *who cares* — they live in the same store with the same shape.

## The problem today
The model is **Slack-first**: `slack_id` is the PK of `people_memory` and the universal handle everywhere (engagement, social, coord rosters, the attendee resolver). So "external" is a second-class citizen with nowhere to live:
- `recordBookingInPersonMemory` **skips attendees with no slack_id** → pure-email externals (gmail candidates, customers) are never persisted.
- The dedicated `known_contacts` table (email-keyed) was **scaffolded but never wired** — only the `CREATE TABLE` exists in `db/client.ts`; nothing reads/writes it.
- Net real bug (2026-05-31): owner asked to book with "Max Attias" (gmail) "who you already know" — Maelle had no record, asked for the email again, even though he'd been booked before. Externals-with-a-Slack-account (guests) ARE remembered; pure-email externals are not.

## Target architecture

### Identity
- **Surrogate PK `person_id`** (e.g. `p_<ulid>`) — stable, never changes, independent of email/slack.
- **Identity attributes (both nullable, both unique-indexed):** `email`, `slack_id`. Match a person by either.
- **`kind`: `internal` | `external`** — derived (email domain == owner company → internal; or has slack_id). A tag, not a wall.
- Surrogate over email-as-PK because emails change, people have several, some start name-only — and we need to **merge** (an external row matched by email later gains a slack_id when they join Slack → no duplicate row).

### One table — evolve `people_memory` → `people`
Same row shape for everyone:
```
person_id (PK) · email (uniq) · slack_id (uniq, null for external)
name · name_he · kind · org (company; mostly external)
timezone · state · gender(+provenance) · working_hours · currently_traveling
notes(JSON) · interaction_log(JSON) · profile_json(prefs/behavior)
engagement_rank · last_seen · last_social_at · created_at · updated_at · source
```
Internal rows fill Slack/Graph-derived fields; external rows leave them null and fill what's learned (org, prefs, history). **`interaction_log` (history) and `profile_json` (prefs) exist for both** — that's the "past bookings / preferences in one place."

### One resolution function — the chokepoint
`resolvePerson({ slackId?, email?, name? }) → person_id` — find-or-create, match order **slack_id → email → fuzzy name**, with **merge** when a new handle attaches to an existing person. EVERY caller (booking, coord, the `resolveAttendeeEmail` helper, brief, social) routes through it instead of slack-id lookups. This single chokepoint is what makes "Max Attias — on your records?" resolve.

### Write path — booking persists everyone
Drop the "skip no-slack-id" rule in `recordBooking`. On every booking/coord/move: `resolvePerson` each attendee (create external rows on first sight), append the booking to *their* `interaction_log`. Second time you book Max → she has email, org, prior booking.

### Free-text layer (md catalog)
Keep per-person markdown (`memory/peopleMemory.ts`) for rich "what we've discussed" — but **re-key from name-slug to `person_id`** so externals get md files too. Table = canonical identity + structured; md = narration detail. One catalog line per person (internal + external) injected into the prompt.

### Slack-gated by CAPABILITY, not storage
External people are stored and remembered like anyone — they just can't do Slack-only actions: **proactive social DMs** + **`find_slack_user`** need a slack_id, **Graph free/busy** needs a calendar. Those features check "has slack_id / calendar?" and skip gracefully. Storage unified; capability degrades.

## Build scope (all in one — owner directive)
1. Schema: `person_id` + `kind` + unique indexes on email/slack_id; backfill existing rows (generate person_id from slack_id/email); fold `known_contacts` rows in (currently none) and DROP it.
2. `resolvePerson` find-or-create + merge; route booking, coord, `resolveAttendeeEmail`, brief, social reads through it.
3. `recordBooking` persists external attendees + writes `interaction_log` for all.
4. Re-key the md catalog to `person_id`.
5. Re-point social/engagement reads to `person_id` (keep slack_id where DMing genuinely needs it).
6. Backward-compat shim (`getBySlackId` view) during transition so nothing breaks mid-build.

## Risk note
`slack_id` is load-bearing in many places (engagement_rank, social_subjects.person_slack_id, coord rosters, brief). This is a real migration — treat it as a project with its own typecheck/paper-trace pass, not a patch. But per owner: ship it as ONE build, not dribbled across versions.
