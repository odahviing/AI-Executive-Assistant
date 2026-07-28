import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import { savePreference, getPreferences, deletePreference, upsertPersonMemory, appendPersonInteraction, updatePersonProfile, getEventsByActor, getPersonMemory as getPersonMemoryRow, searchPeopleMemory, resolvePerson, getRecentChannelMessages, readInteractionLog, BOOKING_SNAPSHOT_FRAME, type PersonProfile, type PersonInteraction, type PersonNote, type CoreFieldWrite } from '../db';
import { getConnection } from '../connections/registry';
import {
  readPersonMemory,
  writePersonSection,
  resolvePersonSlug,
  slugifyName,
  listPersonFiles,
} from '../memory/peopleMemory';
import { writeSkillPreferences, PREF_SKILLS } from '../utils/skillPreferences';
import { DateTime } from 'luxon';
import logger from '../utils/logger';

/**
 * Turn the per-field outcomes of core-field writes into the honest part of an
 * `update_person_profile` payload.
 *
 * Three outcomes, three different things to say, and only one of them is a
 * problem: a value that LANDED, a value that was ALREADY exactly that, and a
 * value REFUSED because a higher authority holds a different one. This used to be
 * inferred at the tool surface by re-reading the row and string-comparing it to
 * the request — a second, weaker copy of a decision the store already makes
 * (`CoreFieldWrite`, db/people.ts), which could not tell "already true" from
 * "saved" at all. The store decides; this only phrases it.
 */
function describeCoreWrites(
  writes: Array<[field: string, outcome: CoreFieldWrite]>,
  ownerFirstName: string,
): { not_saved?: string[]; already_set?: string[]; notes: string[] } {
  const refused = writes.filter(([, o]) => o === 'refused_lower_authority').map(([f]) => f);
  const already = writes.filter(([, o]) => o === 'already_set').map(([f]) => f);
  const notes: string[] = [];
  if (refused.length > 0) {
    notes.push(`${refused.join(', ')} kept the value ${ownerFirstName} already set — his entry outranks a self-correction. Don't say it's saved; say you've noted it and will confirm with him.`);
  }
  if (already.length > 0) {
    notes.push(`${already.join(', ')} already had exactly that value on file — nothing needed changing, and nothing was refused. Say it's already what you have rather than announcing an update.`);
  }
  return {
    ...(refused.length > 0 ? { not_saved: refused } : {}),
    ...(already.length > 0 ? { already_set: already } : {}),
    notes,
  };
}

/**
 * Assistant Skill — always active, handles learning and memory.
 * This skill is the mechanism by which Maelle builds Layer 2:
 * learned preferences that persist across conversations.
 */
export class AssistantSkill implements Skill {
  id = 'assistant' as const;

  name = 'Assistant (Memory)';
  description = 'Learns and remembers preferences, habits, and context about the user over time';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        // v2.9 — merged from learn_preference + forget_preference + recall_preferences.
        // One tool, three actions on the owner's preference catalog.
        name: 'manage_preference',
        description: `Owner preference catalog — durable facts about how the OWNER works, their habits, or personal style. ONE topic per row, never bundle.

Pick one of three actions:

action='set' — save or update a preference. Requires \`category\`, \`key\`, \`value\`.
  Examples: "prefers calls before noon local time" · "uses metric" · "linkedin posts always published tomorrow afternoon".
  NOT for: facts about other PEOPLE (→ update_person_memory / update_person_profile), company/product knowledge (→ KB markdown files), one-off task details.

action='forget' — remove a previously learned preference. Requires \`key\`.

action='recall' — load preferences from the catalog. The system prompt already shows a PREFERENCES INDEX (categories + key list); use this to load the FULL TEXT.
  - \`category\` → load every preference in that category.
  - \`key\` → load one specific preference by exact key.
  - both omitted → load EVERYTHING (use sparingly — costs tokens; prefer category or key).

Categories are scheduling / communication / general (all about the OWNER).`,
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['set', 'forget', 'recall'],
              description: 'set=create/update, forget=delete, recall=read.',
            },
            category: {
              type: 'string',
              enum: ['scheduling', 'communication', 'general'],
              description: 'set: REQUIRED. recall: optional filter. forget: ignored.',
            },
            key: {
              type: 'string',
              description: 'set: REQUIRED, short unique identifier (lowercase_with_underscores, no name prefix). forget: REQUIRED. recall: optional exact-key load.',
            },
            value: {
              type: 'string',
              description: 'set: REQUIRED, the fact in plain English, ONE topic. forget/recall: ignored.',
            },
          },
          required: ['action'],
        },
      },
      // v1.6.1 — message_colleague and find_slack_channel moved into
      // src/core/outreach.ts (OutreachCoreSkill). This file now only owns
      // memory concerns (preferences, people, interactions, gender).
      {
        name: 'recall_interactions',
        description: `Look up past interactions with a specific person — messages they sent, meetings coordinated, outreach done.
Call this when asked "did you talk to X?", "has [name] contacted you?", "what happened with [name]?", or any question about a specific person's recent activity.
Always call this before saying you haven't interacted with someone.`,
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the person to look up',
            },
          },
          required: ['name'],
        },
      },
      // v2.6.2 (renamed from PersonaSkill v2.2.3) — note_about_person and
      // note_about_self live in SocialSkill (`src/skills/social.ts`). Loaded
      // only when `skills.social: true` in the profile. AssistantSkill keeps
      // the always-on operational tools.
      {
        name: 'update_person_profile',
        description: `Update the structured profile for a person — call this when you've observed enough to reliably assess a dimension.

You don't need explicit statements. Infer from behavior:
- communication_style: describe their message pattern. "Brief, direct, never asks questions back" or "Detailed, conversational, often elaborates".
- language_preference: if they consistently reply in a different language from the one you used — save it here.
- timezone: save as soon as you have a signal. If the person mentions a meeting in ET/PST/GMT/etc., or their email/calendar shows a US/EU/Asia location, save the IANA zone here (e.g. "America/New_York", "America/Los_Angeles", "Europe/London", "Australia/Sydney"). Don't overwrite a known timezone unless the new signal is clearly stronger.
- working_hours: infer from their timezone and when they actually respond. "Israel 9am–6pm" or "Responds in US Eastern mornings".
- role_summary: piece together from calendar meetings you've seen, topics they mention, side context. "EMEA sales lead, focused on Q3 targets."
- reports_to: if you learn who their manager is — save it.
- response_speed: how long they typically take to reply. "immediate", "fast" (under an hour), "hours", "day", "slow", "unreliable".
- collaboration_notes: people they always appear with in meetings, who they coordinate with. "Often in calls with [colleague A] and [colleague B]. Runs Monday team sync."

Only update a field when you have real evidence. Omit fields you don't know yet.
Call this after interactions — not during them. It's a background update.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID — opaque string like "U09EXAMPLE9" (U/W + 6+ alphanumerics, no underscores). NEVER invent a name-shaped id like "U_<NAME>". If you don\'t have the real ID, omit this and pass `colleague_name` (resolved from people_memory), or call `find_slack_user` first.',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the person',
            },
            communication_style: {
              type: 'string',
              description: 'Describe their message style. e.g. "Brief and direct, never elaborates" or "Detailed, conversational, asks questions back"',
            },
            language_preference: {
              type: 'string',
              description: 'Their preferred communication language if different from default. e.g. "Hebrew" or "English"',
            },
            timezone: {
              type: 'string',
              description: 'IANA timezone of the person. Save when the owner volunteers it OR a strong signal lands (calendar invite metadata, explicit mention of ET/PST/GMT). e.g. "America/New_York", "Europe/London", "Asia/Jerusalem". When the owner tells you a CITY/COUNTRY use the `state` field instead — the system will derive the timezone from it.',
            },
            state: {
              type: 'string',
              description: 'Free-text location for the person — city, region, or country ("Boston", "New York", "Israel", "London"). Save when the owner volunteers it ("[Person] lives in Israel") or the person tells you. State is more useful than timezone alone (Boston ≠ NYC even though both are ET). When state lands, the system automatically derives + saves a matching IANA timezone.',
            },
            working_hours: {
              type: 'string',
              description: 'Free-text legacy: when they typically work and respond. e.g. "Israel 9am–6pm" or "US Eastern mornings". Prefer working_hours_structured below for new writes — code paths that intersect availability read the structured shape, not this string.',
            },
            working_hours_structured: {
              type: 'object',
              description: 'Structured working window — populate alongside working_hours when you have confirmed values. Code paths that intersect attendee availability in slot search read this. Save ONLY when the colleague confirmed the values directly OR when they\'re obvious from a strong signal (explicit mention of their hours, calendar invite metadata). Don\'t guess.',
              properties: {
                workdays: {
                  type: 'array',
                  description: 'Day names they work on. e.g. ["Sunday","Monday","Tuesday","Wednesday","Thursday"] for Israel; ["Monday","Tuesday","Wednesday","Thursday","Friday"] for US/EU.',
                  items: { type: 'string', enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] },
                },
                hoursStart: { type: 'string', description: 'HH:MM in their local time. e.g. "09:00".' },
                hoursEnd:   { type: 'string', description: 'HH:MM in their local time. e.g. "18:00".' },
                timezone:   { type: 'string', description: 'Optional IANA TZ — only set if it differs from their people_memory.timezone (rare). e.g. "America/New_York".' },
              },
              required: ['workdays', 'hoursStart', 'hoursEnd'],
            },
            role_summary: {
              type: 'string',
              description: 'What they do, what they care about. e.g. "EMEA sales lead, focused on Q3 targets and team hiring"',
            },
            reports_to: {
              type: 'string',
              description: "Their manager's name",
            },
            response_speed: {
              type: 'string',
              enum: ['immediate', 'fast', 'hours', 'day', 'slow', 'unreliable'],
              description: 'How quickly they typically respond: immediate=within minutes, fast=under an hour, hours=few hours, day=next day, slow=2+ days, unreliable=no pattern',
            },
            collaboration_notes: {
              type: 'string',
              description: 'Who they work with, what meetings they appear in. e.g. "Always in EMEA calls with David. Runs Monday team sync."',
            },
            name_he: {
              type: 'string',
              description: 'Hebrew spelling of the person\'s name. Save once when you have a reliable spelling — either you see them write their name in Hebrew, or the owner teaches you. e.g. "אלינור אבני" or "עידן כהן". Avoid guessing transliterations.',
            },
            engagement_rank: {
              type: 'number',
              description: 'Numeric social engagement rank 0–3. 0=don\'t initiate social with them (opt-out), 1=minimal, 2=neutral (default for new), 3=loves to chat. Set ONLY when the owner explicitly directs you ("rank [name] at 3", "never ping [name]" → 0). Don\'t auto-set — the system auto-adjusts based on ping responses.',
            },
            vip: {
              type: 'boolean',
              description: 'Mark this person a VIP (or pass false to un-mark). VIP means: whenever you book a meeting from a thread, this person\'s calendar is ALWAYS checked and the time is optimized around them (non-VIPs are invited but not gating). Set ONLY when the owner explicitly says so — "[name] is a VIP", "always check [name]\'s calendar", "[name]\'s time always matters". Never auto-set.',
            },
            currently_traveling: {
              type: 'object',
              description: 'Travel window for the person. Stored profile timezone/state are defaults — when the colleague is travelling somewhere else for a stretch, set this so slot search and time-of-day display use the travel location instead. Set when (a) the colleague volunteers it ("I\'m in Boston next week", "Boston time"), or (b) the owner tells you ("[Person] is in NYC for a week"). Pass `clear: true` to wipe a known-stale travel window. Either pass concrete `from`+`until` dates, OR pass `from` + one of `for_days`/`for_weeks` and the system derives `until`. The system auto-clears the field once `until` passes.',
              properties: {
                location: { type: 'string', description: 'Free text: "Boston", "NYC", "London". Use a city when known.' },
                from:     { type: 'string', description: 'ISO yyyy-MM-dd — first day at the location. If they fly mid-day, use the day they land.' },
                until:    { type: 'string', description: 'ISO yyyy-MM-dd — last day at the location. Optional if you pass for_days/for_weeks instead.' },
                for_days:  { type: 'number', description: 'Trip length in days. Use when colleague says "for a few days" / "five days". The system derives until = from + for_days - 1.' },
                for_weeks: { type: 'number', description: 'Trip length in weeks. Use when colleague says "for a week" / "two weeks". The system derives until = from + (for_weeks * 7) - 1.' },
                clear:    { type: 'boolean', description: 'Set true to clear an outdated travel window without setting a new one. Use when the owner says "she\'s back" or the trip is over.' },
              },
            },
          },
          required: ['colleague_slack_id', 'colleague_name'],
        },
      },
      {
        name: 'log_interaction',
        description: `Record an activity in the interaction timeline for a person.
Call this to create a permanent memory of what happened with someone — work or social.

Call this whenever:
- A meeting was booked involving this person ("Booked 45min between [owner] and [person] for Thu 10 Apr 14:00")
- You sent or scheduled a message to them ("Sent message asking about Q3 timeline")
- They replied to something ("They confirmed Tuesday 3pm works for the sync")
- You had a meaningful conversation ("Discussed onboarding plan and new team hire")
- A social topic came up ("Talked about their new baby — excited, due in June")
- You coordinated anything involving them ("Coordinated EMEA sync — found a slot everyone agreed to")

Keep summaries short but specific — enough to understand what happened without reading the full conversation.
Bad: "Had a chat"
Good: "Talked about the Q3 roadmap; they're worried about timeline but confident in the team"

This builds a timeline that Maelle can reference later — so when someone asks "did you book that meeting?" or "what did we discuss last week?", the answer is already there.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID — opaque string like "U09EXAMPLE9" (U/W + 6+ alphanumerics, no underscores). NEVER invent a name-shaped id like "U_<NAME>". If you don\'t have the real ID, omit this and pass `colleague_name` (resolved from people_memory), or call `find_slack_user` first.',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the person',
            },
            type: {
              type: 'string',
              enum: ['meeting_booked', 'message_sent', 'message_received', 'conversation', 'social_chat', 'coordination', 'other'],
              description: 'meeting_booked=a calendar event was created, message_sent=Maelle sent a DM, message_received=they replied/reached out, conversation=back-and-forth exchange, social_chat=personal/social topic, coordination=scheduling/logistics work, other=anything else',
            },
            summary: {
              type: 'string',
              description: 'Short specific headline. Include names, dates, and outcomes where relevant. e.g. "Booked 30min sync for Fri 11 Apr 10:00" or "They replied — confirmed Thursday afternoon works"',
            },
          },
          required: ['colleague_slack_id', 'colleague_name', 'type', 'summary'],
        },
      },
      {
        name: 'confirm_gender',
        description: `Lock in a person's gender after they told you directly (or the owner confirmed on their behalf). ONCE SET THIS WAY, THE GENDER IS FROZEN — no auto-detector (pronouns, image, name-LLM) will ever overwrite it.

Call this in exactly these situations:
- A colleague replies to your gender-check question ("את או הוא?") — save their answer.
- A colleague volunteers it directly ("I'm a woman", "אני זכר", "she/her").
- The owner tells you someone's gender.

Do NOT call this to save a guess. Auto-detection already handles guesses in the background; this tool is only for human confirmation.

After calling this, use the correct Hebrew/English gendered forms from now on and never ask again.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID of the person whose gender is being confirmed — opaque string like "U09EXAMPLE9" (starts with U or W, then 6+ alphanumerics, NO underscores). NEVER write "U_<NAME>" — looks right, is invented. Omit if you don\'t have the real ID; pass `colleague_name` and the system resolves from people_memory.',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the person.',
            },
            gender: {
              type: 'string',
              enum: ['male', 'female'],
              description: 'The confirmed gender. If the answer was ambiguous, do NOT call this tool — ask once more instead.',
            },
          },
          required: ['colleague_slack_id', 'gender'],
        },
      },
      {
        name: 'get_person_memory',
        description: `Load everything you know about a person: their markdown notes (residence, workplace, working hours, communication style) PLUS your relationship history with them — past social notes (★) and recent exchanges (↳ what they reached out about, what was discussed).

Call this when:
- A person in WORKSPACE CONTACTS shows a "N notes on file" hint and that person is relevant to the current turn — the hint means there's history to pull
- You want to check what you already know before asking them something you might have asked before
- Scheduling for them, messaging them, or answering a question about them benefits from the context

The contacts list shows each person's name, timezone, gender, and email inline; their notes + conversation history load through this call. Keep calls narrow — one person at a time.

WHEN YOU PRESENT what you know (owner asks "what do you know about X" / "data on X" / "tell me about X"): the point is the PERSON, not a calendar dump. Lead with WHO THEY ARE — role, how you relate, durable facts and preferences (e.g. "Yael — VP Marketing, heads-down on the launch; prefers mornings"). SUMMARIZE meeting/booking history at a relationship level ("ran a few interviews with you lately") rather than reciting one meeting's logistics (exact date/time/venue/attendees) — give those specifics only if the owner asks about that particular meeting. Depth about the relationship is welcome; a verbatim recap of one booking is not.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            person: {
              type: 'string',
              description: 'Person identifier — their display name or first name as shown in the PEOPLE NOTES catalog (a slack_id also works).',
            },
          },
          required: ['person'],
        },
      },
      {
        name: 'update_person_memory',
        description: `Write a durable OPERATIONAL FACT about a person into their markdown notes file — residence, workplace, working hours, communication style, what tooling they use.

Examples: "[Person] lives in [city]" · "Responds US Eastern mornings, offline after 5pm ET" · "Writes in Hebrew, always" · "Always does Teams, even for 1:1s".

The axis here is FACT vs INSTRUCTION, not "the owner vs a person". A fact is something true about them that you observed or were told. A STANDING INSTRUCTION from the owner about how to handle that person — "keep Dirk's meetings to 30 minutes", "always address Dr. Weiss as Dr. Weiss", "never book Yael before 10" — is the OWNER's preference, not their fact: it goes to update_my_preferences under the skill whose behavior it changes, with the person named in the line. Filed here it would only load if someone happened to call get_person_memory, so it would silently fail to steer the booking it was meant to steer.

NOT for: social topics / hobbies / family stories (→ note_about_person / note_about_self) or ephemeral state like mood-today / running-late (→ log_interaction).

Section header behavior: existing section's body gets REPLACED; new header gets APPENDED. First call for a person auto-creates their md file — don't write speculative content just to create one.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            person: {
              type: 'string',
              description: "Person identifier — slug, display name, or first name. For the owner use his first name or his slack id.",
            },
            section: {
              type: 'string',
              description: 'Section header for this fact. Prefer the standard ones: "Residence", "Workplace", "Working hours", "Communication style", "What we\'ve discussed". Case-insensitive match — don\'t create a duplicate header with different casing.',
            },
            text: {
              type: 'string',
              description: 'The fact, in plain markdown. One or two sentences usually. Be specific — "Anna lives in Nes Ziona" beats "lives south of Tel Aviv".',
            },
          },
          required: ['person', 'section', 'text'],
        },
      },
      {
        name: 'update_my_preferences',
        description: `Save or edit the OWNER's standing preferences for how Maelle should behave in a given AREA. These are free-text notes injected into that area's instructions — the owner's personal style, which overrides the defaults. The owner can put whatever he wants here.

Use ONLY after the owner confirms a STANDING preference (apply every time), e.g. "on Sundays don't add a missing lunch", "just delete duplicate recruiting-system invites", "call me Mr. Cohen when you confirm a booking". Offer to remember, then save on his yes.

ABOUT A SPECIFIC PERSON — this is the right tool. A standing instruction from the owner concerning someone ("keep Dirk's meetings to 30 minutes", "always address Dr. Weiss as Dr. Weiss", "never book Yael before 10", "Rita gets a call, not a thread") is HIS preference, not a fact about them. Save it here, naming the person inside the line, under the skill whose behavior it changes — meetings for booking style, general for how to address someone. That is what makes it fire at the moment it matters. FACTS about that person (where they live, their hours, what they use) still go to update_person_profile / update_person_memory.

SHAPE OF THE ASK: when he asks to change how you do something recurring, do NOT both pre-commit ("I'll do it next time") AND ask to make it standing — that's muddled (did it save, or are you waiting on him?). Acknowledge in one short line, then ask ONE clear question ("Want me to save that so every report comes this way?") and act only on his yes. Keep the ask uncrowded — don't re-list the whole structure inline, especially when the request was to reduce clutter.

NOT for: one-off instructions for today, FACTS about other people (→ update_person_memory / update_person_profile — but his standing instruction ABOUT a person belongs here, see above), or company knowledge (→ KB markdown).`,
        input_schema: {
          type: 'object' as const,
          properties: {
            skill: {
              type: 'string',
              // v3.3 — DERIVED from PREF_SKILLS (single source of truth) so the
              // tool's accepted values can't drift from the allowlist that
              // fileForSkill / formatSkillPreferencesBlock honor. That drift is
              // exactly what half-broke skill='news' (enum patched, but PREF_SKILLS
              // wasn't → fileForSkill returned null → saves failed at the allowlist).
              enum: [...PREF_SKILLS],
              description: "Which area the preference governs. 'calendar' = calendar health / hygiene; 'meetings' = booking & scheduling style; 'brief' = the morning briefing's STYLE (what to lead with, emphasize, skip, length) — NOT its news content; 'news' = the news skill's TOPICS, companies to track, and source steer — use 'news' for \"cover X\" / \"include company Y\" / \"stop covering Z\" EVEN when the owner says \"in my morning brief\" (the brief's news section is driven by 'news', not 'brief'); 'general' = voice, how to address him, cross-cutting. Pick the area whose tools/behavior the preference changes.",
            },
            mode: {
              type: 'string',
              enum: ['add', 'replace'],
              description: "add = append this as one new preference line (de-duplicated — a near-identical line is a no-op). replace = overwrite ALL preferences for this area with `text`. If a similar preference already exists and the owner is CHANGING it, use replace with the full new list — don't 'add' a near-duplicate.",
            },
            text: {
              type: 'string',
              description: "The preference in the owner's own words. mode=add: one line. mode=replace: the full new list, one preference per line.",
            },
          },
          required: ['skill', 'mode', 'text'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const userId = context.profile.user.slack_user_id;
    const isOwner = context.senderRole === 'owner';

    // ── Colleague hard-blocks + self-only guards ─────────────────────────────
    // Two layers:
    //   (a) ownerOnlyTools — owner-only, no colleague-self equivalent makes
    //       sense (catalog reads/writes, owner's KB, owner's coord finalize).
    //   (b) Self-only tools — allowed on the colleague path BUT only when
    //       the target is the calling colleague themselves. The point of
    //       people memory + travel + social engagement is to make Maelle
    //       smarter with each person; a colleague writing about THEMSELVES
    //       is the whole product. Writing about ANOTHER person (the owner
    //       or another colleague) on a colleague-path turn is the exact
    //       impersonation/gossip surface we DO block.
    // v2.5.2 — `update_person_profile` moved from (a) to (b); colleague-self
    // path also field-filters args to operational metadata only (timezone,
    // state, working_hours, currently_traveling, language, name_he). Fields
    // the owner curates (engagement_rank, engagement_level, role_summary,
    // reports_to, collaboration_notes, communication_style, response_speed)
    // are silently dropped on the colleague-self path with a log line.
    if (!isOwner) {
      const ownerOnlyTools = ['manage_preference', 'update_my_preferences', 'update_person_memory', 'get_person_memory'];
      if (ownerOnlyTools.includes(toolName)) {
        logger.warn('Colleague attempted owner-only tool', { tool: toolName, userId: context.userId });
        return { error: 'not_permitted', reason: 'This action can only be performed by the owner.' };
      }
      // note_about_person on colleague-path: ALWAYS rewrite the target to
      // be the requester. v2.9.2 — owner direction: only the owner writes
      // notes about other people. When a colleague says "Shayan is X", that
      // observation lands on YAEL's notes (the requester said it), not on
      // Shayan's. Closes the empty-reply bug where Sonnet tried writing a
      // note about Maelle herself when a colleague asked about her name,
      // the prior guard refused with not_permitted, and the response chain
      // died with no text reply.
      //
      // Behavior change: instead of refusing the call when target ≠
      // requester, silently rewrite colleague_slack_id to context.userId.
      // Sonnet's response chain continues uninterrupted, the note lands on
      // the right person, and any "Sonnet picked the wrong target" drift
      // resolves transparently.
      // IN-PLACE mutation: note_about_person's handler lives in SocialSkill,
      // a separate skill the registry dispatches to AFTER AssistantSkill
      // returns null. Reassigning the local `args` here would not propagate
      // to SocialSkill — only mutating the shared object reference does.
      if (toolName === 'note_about_person') {
        const targetId = args.colleague_slack_id as string | undefined;
        // Force-self when target is missing OR points away from requester.
        // Omitting the id used to bypass this guard — resolveSlackId(by name)
        // would then resolve to whoever the colleague named (incl. owner),
        // landing a write on the wrong row.
        if (targetId !== context.userId) {
          if (targetId !== undefined) {
            logger.info('note_about_person colleague-path — rewriting target to requester', {
              originalTarget: targetId, requesterId: context.userId,
            });
          }
          (args as Record<string, unknown>).colleague_slack_id = context.userId;
        }
      }
      // v2.9.3 — universal colleague-self rewrite (extends the v2.9.2
      // note_about_person fix to every person-targeting tool). When a
      // colleague calls log_interaction / confirm_gender /
      // update_person_profile with a target that isn't themselves,
      // silently rewrite the target to the requester instead of
      // refusing with `not_permitted`. The prior refusal pattern killed
      // Sonnet's response chain (the same class of bug that produced
      // the empty-reply when Yael asked Maelle's name pre-v2.9.2). Now
      // every colleague-side person-write is self-only by construction;
      // Sonnet can't drift, the data lands on the right row, the chain
      // continues. Owner direction: "everyone writes to himself."
      //
      // log_interaction uses `slack_id`; confirm_gender + update_person_profile
      // use `colleague_slack_id`. Same rewrite logic, different arg name.
      if (toolName === 'log_interaction') {
        const targetId = args.slack_id as string | undefined;
        // Force-self (see note_about_person above for the omit-target rationale).
        if (targetId !== context.userId) {
          if (targetId !== undefined) {
            logger.info('log_interaction colleague-path — rewriting target to requester', {
              originalTarget: targetId, requesterId: context.userId,
            });
          }
          (args as Record<string, unknown>).slack_id = context.userId;
        }
      }
      if (toolName === 'confirm_gender') {
        const targetId = args.colleague_slack_id as string | undefined;
        // Force-self (see note_about_person above for the omit-target rationale).
        if (targetId !== context.userId) {
          if (targetId !== undefined) {
            logger.info('confirm_gender colleague-path — rewriting target to requester', {
              originalTarget: targetId, requesterId: context.userId,
            });
          }
          (args as Record<string, unknown>).colleague_slack_id = context.userId;
        }
      }
      // v2.5.2 — update_person_profile: field allowlist still applies on
      // colleague-self path (engagement_rank, role_summary, etc. are
      // owner-curated and silently dropped). v2.9.3 — target check
      // changed from refuse to rewrite, same shape as the other tools.
      if (toolName === 'update_person_profile') {
        // Clone before mutation. update_person_profile is handled BY
        // AssistantSkill (this same file's switch below), so unlike
        // note_about_person (#2) we don't need the shared-ref propagation —
        // and we DO want isolation from the orchestrator's cached args
        // object. The field-drop loop below removes owner-curated fields;
        // mutating the caller's object would dirty the cache and cause
        // retries to see a partial args shape.
        args = { ...args };
        const targetId = args.colleague_slack_id as string | undefined;
        // Force-self (see note_about_person above for the omit-target rationale).
        if (targetId !== context.userId) {
          if (targetId !== undefined) {
            logger.info('update_person_profile colleague-path — rewriting target to requester', {
              originalTarget: targetId, requesterId: context.userId,
            });
          }
          args.colleague_slack_id = context.userId;
        }
        // Opt-in allowlist: a colleague calling update_person_profile (on their
        // own row, after the rewrite above) may only set operational metadata.
        // Owner-curated fields (engagement_rank, role_summary, reports_to,
        // collaboration_notes, communication_style, response_speed, etc.) are
        // silently dropped. When adding a new field to `update_person_profile`,
        // decide whether colleagues can self-set it; if yes, add it here.
        const COLLEAGUE_SELF_WRITABLE_FIELDS = new Set([
          'colleague_slack_id', 'colleague_name',
          'timezone', 'state', 'working_hours', 'working_hours_structured',
          'language_preference', 'name_he', 'currently_traveling',
        ]);
        const droppedFields: string[] = [];
        for (const k of Object.keys(args)) {
          if (!COLLEAGUE_SELF_WRITABLE_FIELDS.has(k)) {
            droppedFields.push(k);
            delete args[k];
          }
        }
        if (droppedFields.length > 0) {
          logger.info('update_person_profile (colleague-self) — dropped owner-curated fields', {
            requesterId: context.userId, droppedFields,
          });
        }
      }
    }

    switch (toolName) {
      case 'recall_interactions': {
        const name = (args as any).name as string;
        const events = getEventsByActor(userId, name);

        // v3.3.7 (#125c) — verbatim grounding. The event log holds capture-pass
        // SUMMARIES; answering "what did you tell Yael?" from a summary is how
        // Maelle confidently misdescribed a real exchange (read as lying).
        // Attach the actual last messages exchanged in that person's DM so the
        // answer is grounded in what was said.
        //
        // Scope gate: the OWNER may read any person's exchange (same exposure
        // as the shadow mirrors already in his DM). A non-owner caller only
        // ever gets their OWN conversation — the tool is owner-only today
        // (COLLEAGUE_ALLOWED_TOOLS), this is the defensive layer if that
        // ever changes.
        const recentExchange = await (async () => {
          try {
            const hits = searchPeopleMemory(name)
              .filter(p => p.slack_id && /^[UW][A-Z0-9]{6,}$/.test(p.slack_id));
            const person = hits[0];
            if (!person?.slack_id) return undefined;
            if (context.senderRole !== 'owner' && person.slack_id !== context.userId) {
              return undefined;  // never leak someone else's exchange to a colleague
            }
            const conn = getConnection(context.profile.user.slack_user_id, 'slack');
            if (!conn?.resolveDirectChannelId) return undefined;
            const channelId = await conn.resolveDirectChannelId(person.slack_id);
            if (!channelId) return undefined;
            const msgs = getRecentChannelMessages(channelId, 10);
            if (msgs.length === 0) return undefined;
            const tz = context.profile.user.timezone;
            const assistantName = context.profile.assistant?.name ?? 'Assistant';
            return msgs.map(m => {
              const tsNum = m.ts ? Number(m.ts) : NaN;
              const at = Number.isFinite(tsNum)
                ? DateTime.fromSeconds(tsNum).setZone(tz).toFormat('yyyy-MM-dd HH:mm')
                : undefined;
              return {
                ...(at ? { at } : {}),
                from: m.role === 'assistant' ? assistantName : person.name,
                text: m.content,
              };
            });
          } catch (err) {
            logger.warn('recall_interactions — verbatim exchange lookup failed (summaries only)', {
              err: String(err).slice(0, 200),
            });
            return undefined;
          }
        })();

        if (events.length === 0 && !recentExchange) {
          return {
            found: false,
            message: `No recorded interactions with ${name} in the event log.`,
          };
        }
        if (events.length === 0 && recentExchange) {
          return {
            found: true,
            count: 0,
            interactions: [],
            recent_exchange: recentExchange,
            _note: 'recent_exchange is the VERBATIM last messages in their DM — when describing what was said, quote/paraphrase from it, never reconstruct from memory.',
          };
        }

        // v2.3.6 (#69b) — render `created_at` (UTC in DB) into the owner's
        // local TZ before returning to Sonnet. Without this, Sonnet narrates
        // a UTC time string verbatim (e.g. "08:03" for 11:03 IL), leaking
        // a 3-hour drift into owner-facing replies. Same chokepoint pattern
        // as v2.3.4 parseGraphFreeBusySlot — convert at the data boundary,
        // not in the consumer's head.
        const ownerTz = context.profile.user.timezone;
        return {
          found: true,
          count: events.length,
          interactions: events.map(e => {
            // SQLite datetime() default format is 'YYYY-MM-DD HH:MM:SS' in UTC.
            // Parse as UTC, render in owner-local with explicit TZ tag so
            // Sonnet can't accidentally narrate the UTC wall-clock.
            const utcDt = DateTime.fromSQL(e.created_at, { zone: 'utc' });
            const localDt = utcDt.isValid ? utcDt.setZone(ownerTz) : null;
            const displayDate = localDt && localDt.isValid
              ? localDt.toFormat('yyyy-MM-dd HH:mm')
              : e.created_at;
            return {
              date: displayDate,
              date_iso: localDt && localDt.isValid ? localDt.toISO() : e.created_at,
              type: e.type,
              summary: e.title,
              detail: e.detail,
            };
          }),
          ...(recentExchange ? {
            recent_exchange: recentExchange,
            _note: 'recent_exchange is the VERBATIM last messages in their DM — when describing what was said, quote/paraphrase from it, never reconstruct from memory. The interactions list above is summarized.',
          } : {}),
        };
      }

      case 'manage_preference': {
        const action = String(args.action ?? '').toLowerCase();
        if (action === 'set') {
          const prefValue = args.value as string | null | undefined;
          if (prefValue == null || prefValue === '') {
            logger.warn('manage_preference set — empty value, skipped', { key: args.key });
            return { saved: false, reason: 'value was empty — nothing stored' };
          }
          if (!args.category || !args.key) {
            return { saved: false, error: 'missing_fields', message: 'set requires category, key, and value.' };
          }
          savePreference({
            userId,
            category: args.category as string,
            key: args.key as string,
            value: prefValue,
            source: 'user_taught',
          });
          logger.info('Preference saved', { userId, key: args.key, value: prefValue });
          return { saved: true, key: args.key };
        }
        if (action === 'forget') {
          if (!args.key) {
            return { deleted: false, error: 'missing_fields', message: 'forget requires key.' };
          }
          const deleted = deletePreference(userId, args.key as string);
          logger.info('Preference deleted', { userId, key: args.key, deleted });
          return { deleted, key: args.key };
        }
        if (action === 'recall') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getPreferencesFiltered } = require('../db') as typeof import('../db');
          const category = (args.category as string | undefined) || undefined;
          const key = (args.key as string | undefined) || undefined;
          const prefs = getPreferencesFiltered(userId, { category, key });
          logger.info('recall_preferences', { userId, category, key, count: prefs.length });
          return { preferences: prefs, count: prefs.length, filter: { category, key } };
        }
        return { error: 'bad_action', message: `manage_preference action must be one of 'set' | 'forget' | 'recall', got "${action}".` };
      }


      // v2.6.2 (renamed from PersonaSkill v2.2.3) — note_about_person /
      // note_about_self handlers live in SocialSkill (src/skills/social.ts).
      // Routed there when the social skill is active; otherwise the tools
      // aren't in the tool list.

      case 'log_interaction': {
        const name = args.colleague_name as string;
        // v3.2.0 — resolve identity through the person store (ONE route).
        // Internal: hallucination-guarded slack_id → person_id. Owner-path
        // external (no slack_id): find-or-create by name → person_id. This is
        // what lets an interaction be logged against a pure-email external.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePersonTarget } = require('../utils/resolvePersonTarget') as typeof import('../utils/resolvePersonTarget');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { appendPersonInteractionById } = require('../db') as typeof import('../db');
        const ownerDomain = context.profile.user.email.split('@')[1] ?? '';
        const target = resolvePersonTarget({ rawSlackId: args.colleague_slack_id as string | undefined, name, isOwner, ownerDomain });
        if (target?.hallucinated) {
          logger.warn('log_interaction — colleague_slack_id hallucinated', {
            rejected: (args.colleague_slack_id as string | undefined) ?? null, colleagueName: name, resolvedTo: target?.slackId ?? null,
          });
        }
        if (!target) {
          return { error: 'unknown_colleague', message: `No person resolved for "${name}". Call find_slack_user first, or include an email for an external contact.` };
        }
        appendPersonInteractionById(target.personId, {
          type: args.type as PersonInteraction['type'],
          summary: args.summary as string,
        });
        logger.info('Interaction logged', { personId: target.personId, name: target.name, type: args.type });
        return { logged: true, name: target.name };
      }

      case 'confirm_gender': {
        const name = (args.colleague_name as string | undefined) ?? '';
        // v3.2.0 — resolve identity through the person store (one route).
        // Owner-path supports a pure-email external; colleague-path is forced
        // to the requester's slack_id by the gate above, so it always resolves
        // internally. Provenance: owner-path → 'owner', colleague-self → 'person'.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePersonTarget } = require('../utils/resolvePersonTarget') as typeof import('../utils/resolvePersonTarget');
        const ownerDomain = context.profile.user.email.split('@')[1] ?? '';
        const target = resolvePersonTarget({ rawSlackId: args.colleague_slack_id as string | undefined, name, isOwner, ownerDomain });
        if (target?.hallucinated) {
          logger.warn('confirm_gender — colleague_slack_id hallucinated', {
            rejected: (args.colleague_slack_id as string | undefined) ?? null, colleagueName: name, resolvedTo: target?.slackId ?? null,
          });
        }
        if (!target) {
          return { confirmed: false, reason: 'unknown_colleague', message: `No person resolved for "${name}". Call find_slack_user first, or include an email for an external contact.` };
        }
        const gender  = args.gender as 'male' | 'female';
        const setBy = isOwner ? 'owner' : 'person';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { confirmPersonGenderById } = require('../db') as typeof import('../db');
        // ONE call: the store's confirmation writer owns both authority columns
        // (gender_set_by + the gender_confirmed mirror) — v4.2.x folded them, so
        // the old second "belt-and-suspenders" write is gone with the split.
        const outcome = confirmPersonGenderById(target.personId, gender, setBy);
        if (outcome === 'refused_lower_authority') {
          // A higher authority holds a DIFFERENT gender — surface so the LLM
          // doesn't claim it saved. This is the ONLY honest refusal: the store's
          // `already_set` outcome (below) used to arrive here as a bare `false`
          // too, so re-stating a gender already on file at that same authority was
          // reported as a refusal for something that was already true.
          logger.info('confirm_gender refused — a higher authority holds a different gender', { personId: target.personId, gender, setBy });
          return { confirmed: false, reason: 'higher_authority_already_set', name: target.name };
        }
        if (outcome === 'already_set') {
          logger.info('Gender already on file as stated — no write needed', { personId: target.personId, name: target.name, gender, setBy });
          return {
            confirmed: true,
            already_on_file: true,
            name: target.name,
            gender,
            _note: `${target.name}'s gender was already on file as ${gender} — nothing needed changing, and nothing was refused. Confirm it briefly and use the right gendered forms; don't report a problem and don't ask again.`,
          };
        }
        if (outcome !== 'applied') {
          // 'no_value' (gender wasn't male/female) / 'no_person' (no row) — neither
          // is a refusal, and neither is a save.
          logger.warn('confirm_gender — nothing written', { personId: target.personId, gender, setBy, outcome });
          return { confirmed: false, reason: outcome, name: target.name };
        }
        logger.info('Gender confirmed (human-locked)', { personId: target.personId, name: target.name, gender, setBy, confirmedBy: context.userId });
        return { confirmed: true, name: target.name, gender, set_by: setBy };
      }

      case 'get_person_memory': {
        const query = (args.person as string | undefined)?.trim();
        if (!query) return { error: 'empty_person' };

        // v3.x (Block 1 prompt reduction) — the WORKSPACE CONTACTS prompt block
        // no longer inlines every contact's ★ notes + ↳ interaction history for
        // all 25 contacts (it shows a "N notes on file" hint instead, to cut the
        // fresh-every-turn dynamic cost). So this tool — the one the hint points
        // at — must ALSO return that people_memory data, or the relational
        // context (comms style, social-engineering flags, past asks) would be
        // unreachable. Resolve the row by slack_id, else by name/email.
        const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;
        const row = SLACK_ID_RE.test(query)
          ? getPersonMemoryRow(query)
          : (searchPeopleMemory(query)[0] ?? searchPeopleMemory(query.replace(/-/g, ' '))[0] ?? null);
        // v3.2.0 — md keyed by person_id; legacy name-slug passed as fallback.
        const personId = row?.person_id ?? (await resolvePersonSlug(context.profile, query));
        const content = personId ? await readPersonMemory(context.profile, personId, row?.name ?? query) : null;
        let notes: PersonNote[] = [];
        let recentInteractions: Array<{ date: string; type: string; summary: string }> = [];
        let recentBookings: Array<{ date: string; summary: string }> = [];
        if (row) {
          try { notes = JSON.parse(row.notes || '[]'); } catch { notes = []; }
          // Booking snapshots used to be stripped here outright, which made
          // "we booked yesterday" unrecallable from the store (P6). They come
          // back with a freshness rule + an explicit as-booked frame instead —
          // see readInteractionLog / BOOKING_SNAPSHOT_FRAME in db/people.ts.
          const split = readInteractionLog(row.interaction_log);
          recentInteractions = split.relational
            .slice(-15)
            .map(i => ({ date: i.date.split('T')[0], type: i.type, summary: i.summary }));
          recentBookings = split.recentBookings
            .slice(-8)
            .map(i => ({ date: i.date.split('T')[0], summary: i.summary }));
        }

        // #132 — surface the stored identity (email / slack_id) so a person we've
        // booked before is reusable without re-asking. The address lived in the
        // row all along (Max Attias case) but this tool never returned it, so
        // Maelle said "no email on file" with the email one field away. Owner-only
        // tool, so this never exposes a contact's email to a colleague.
        const email = row?.email ?? null;
        const slackId = row?.slack_id ?? null;
        const hasMemory = content !== null || notes.length > 0 || recentInteractions.length > 0 || recentBookings.length > 0;

        if (!hasMemory && !email && !slackId) {
          return {
            found: false,
            person: row?.name ?? query,
            message: `No memory file yet for "${query}" — no durable facts recorded. Use update_person_memory when you learn one.`,
          };
        }
        logger.info('Person memory fetched', {
          person: row?.name ?? query, bytes: content?.length ?? 0, notes: notes.length,
          interactions: recentInteractions.length, hasEmail: !!email,
        });
        return {
          found: true,
          person: row?.name ?? query,
          email,
          slack_id: slackId,
          content: content ?? '',
          notes: notes.map(n => ({ date: n.date, note: n.note })),
          recent_interactions: recentInteractions,
          ...(recentBookings.length > 0
            ? {
                recent_bookings: recentBookings,
                recent_bookings_note: `These are ${BOOKING_SNAPSHOT_FRAME}. Safe to say "we booked X on <date>"; check the calendar before stating when it now sits.`,
              }
            : {}),
        };
      }

      case 'update_person_memory': {
        const query = (args.person as string | undefined)?.trim();
        const section = (args.section as string | undefined)?.trim();
        const text = args.text as string | undefined;
        if (!query) return { error: 'empty_person' };
        if (!section) return { error: 'empty_section' };
        if (!text || !text.trim()) return { error: 'empty_text' };

        // v3.2.0 — resolve-or-create the person (internal by slack_id, else by
        // name), then key the md file by person_id. This is also what lets an
        // email-only / name-only person get a memory file at all.
        const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;
        const ownerDomain = context.profile.user.email.split('@')[1] ?? '';
        const resolved = resolvePerson(
          SLACK_ID_RE.test(query) ? { slackId: query, ownerDomain } : { name: query, ownerDomain },
        );
        if (!resolved) {
          return { error: 'unresolved_person', message: `Couldn't resolve "${query}" to a person.` };
        }
        const personId = resolved.person_id;
        const displayName = resolved.row.name;

        const result = await writePersonSection({
          profile: context.profile,
          personId,
          displayName,
          section,
          text,
        });
        if (!result.ok) {
          logger.warn('update_person_memory failed', { personId, section, err: result.error });
          return { ok: false, error: result.error };
        }

        // v3.0.7 — stale-slot-results signal. When the md section name
        // suggests a slot-relevant update (work hours / timezone /
        // schedule / availability / workdays / travel), flag prior
        // find_available_slots results as stale. Sonnet sees the note in
        // the next iteration and re-runs the slot finder instead of
        // memo-filtering. Section name match is fuzzy because md
        // sections are owner-named free-text; any of these substrings
        // (case-insensitive) trigger.
        const SLOT_RELEVANT_SECTION_PATTERNS = [
          'hours', 'timezone', 'time zone', 'schedule', 'workdays',
          'availability', 'travel', 'working',
        ];
        const sectionLower = section.toLowerCase();
        const slotRelevant = SLOT_RELEVANT_SECTION_PATTERNS.some(p => sectionLower.includes(p));

        const base = { ok: true, person: displayName, section, created: result.created } as Record<string, unknown>;
        if (slotRelevant) {
          base._slot_results_now_stale = true;
          base._note = `You wrote to a slot-relevant section ("${section}") for ${displayName}. Any prior find_available_slots results involving them are now stale — re-run find_available_slots before proposing options to the owner. Don't mentally filter old slot candidates.`;
        }
        return base;
      }

      case 'update_my_preferences': {
        const skill = (args.skill as string | undefined)?.trim().toLowerCase();
        const mode = (args.mode as string | undefined)?.trim();
        const text = args.text as string | undefined;
        if (!skill) return { error: 'empty_skill' };
        if (mode !== 'add' && mode !== 'replace') return { error: 'invalid_mode', message: "mode must be 'add' or 'replace'." };
        if (!text || !text.trim()) return { error: 'empty_text' };

        const result = await writeSkillPreferences(context.profile, skill, mode, text);
        if (!result.ok) {
          logger.warn('update_my_preferences failed', { skill, mode, err: result.error });
          return { ok: false, error: result.error };
        }
        logger.info('update_my_preferences', { skill, mode, created: result.created, duplicate: result.duplicate });
        return {
          ok: true,
          skill,
          mode,
          created: result.created,
          ...(result.duplicate ? { duplicate: true, matched_line: result.matchedLine } : {}),
          _note: result.duplicate
            ? `Not added — you already have a matching ${skill} preference: "${result.matchedLine ?? ''}". If the owner is REFINING or changing it, call again with mode='replace' passing the full updated list (it backs up the old file first). If it's genuinely the same, you're done — just tell him it's already in place.`
            : `Saved to your ${skill} preferences. It's in force from your next ${skill}-related turn — no need to repeat it.`,
        };
      }

      case 'update_person_profile': {
        const name = args.colleague_name as string;
        // v3.2.0 — resolve identity through the person store (ONE route).
        // Internal: hallucination-guarded slack_id → person_id. Owner-path
        // external (no slack_id): find-or-create by name → person_id. The
        // slack-only side-effects further down (auto working-hours, engagement
        // rank, travel) are gated on a real slack_id — they don't apply to a
        // contact with no Slack account / calendar.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePersonTarget } = require('../utils/resolvePersonTarget') as typeof import('../utils/resolvePersonTarget');
        const ownerDomain = context.profile.user.email.split('@')[1] ?? '';
        const target = resolvePersonTarget({ rawSlackId: args.colleague_slack_id as string | undefined, name, isOwner, ownerDomain });
        if (target?.hallucinated) {
          logger.warn('update_person_profile — colleague_slack_id hallucinated', {
            rejected: (args.colleague_slack_id as string | undefined) ?? null, colleagueName: name, resolvedTo: target?.slackId ?? null,
          });
        }
        if (!target) {
          return { error: 'unknown_colleague', message: `No person resolved for "${name}". Call find_slack_user first, or include the person's email for an external contact.` };
        }
        const slackId = target.slackId;   // null for pure-email externals
        const timezone = args.timezone as string | undefined;
        const state   = args.state as string | undefined;
        const nameHe  = args.name_he as string | undefined;
        // P4 — provenance is derived from the AUTHENTICATED sender, never
        // assumed. The colleague branch above force-rewrites the target to the
        // requester's own row, so a colleague reaching here is a person stating
        // a fact about THEMSELVES ('person'), not the owner stating it. Writing
        // 'owner' on every path recorded a false source in the very column P4's
        // stated-beats-derived rule reads. Same one-expression shape as
        // confirm_gender.
        const setBy = isOwner ? 'owner' : 'person';

        // v3.0.2 — reject ambiguous TZ strings BEFORE writing. luxon resolves
        // "IST" to Asia/Kolkata (Indian Standard Time, +5:30) — silently wrong
        // for Israel-based contacts. Real IANA zones use Region/City form.
        // Returns an error Sonnet can read + retry against, instead of letting
        // a bad write land and surface later as cross-TZ slot mis-rendering.
        if (timezone && timezone.trim()) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { isStrictIana } = require('../utils/timezoneValidator') as
            typeof import('../utils/timezoneValidator');
          if (!isStrictIana(timezone)) {
            logger.warn('update_person_profile — rejected non-IANA timezone', {
              slackId, colleague_name: name, attempted: timezone,
            });
            return {
              error: 'invalid_timezone',
              message: `'${timezone}' is not a valid IANA timezone. Use a Region/City form like 'Asia/Jerusalem', 'America/New_York', 'Europe/London'. Never abbreviations like 'IST', 'PST', 'CST' — those are ambiguous (IST is Indian Standard Time, +5:30).`,
            };
          }
        }

        // v3.2.0 — EXTERNAL (owner-path, no slack_id): write the core profile
        // fields by person_id, then return. The slack-only features below
        // (auto working-hours, engagement_rank, travel) don't apply to a
        // contact with no Slack account / calendar.
        if (!slackId) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { setCoreFieldWithProvenanceById, updatePersonProfileById } = require('../db') as typeof import('../db');
          const coreWrites: Array<[string, CoreFieldWrite]> = [];
          if (timezone && timezone.trim()) {
            coreWrites.push(['timezone', setCoreFieldWithProvenanceById(target.personId, 'timezone', timezone.trim(), setBy)]);
            // v4.2.x — externals never got this refresh (only the slack_id branch
            // below did), so a known timezone with no working_hours_auto read as
            // "unknown" to getEffectiveWorkingHours and attendeeAvailability
            // silently dropped the person from the clip instead of using a
            // default window for their zone. Same fix as setPersonTimezoneByEmail.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { refreshAutoWorkingHoursById } = require('../utils/workingHoursDefault') as
              typeof import('../utils/workingHoursDefault');
            refreshAutoWorkingHoursById(target.personId);
          }
          if (state && state.trim()) coreWrites.push(['state', setCoreFieldWithProvenanceById(target.personId, 'state', state.trim(), setBy)]);
          if (nameHe && nameHe.trim()) coreWrites.push(['name_he', setCoreFieldWithProvenanceById(target.personId, 'name_he', nameHe.trim(), setBy)]);
          updatePersonProfileById(target.personId, {
            communication_style: args.communication_style as string | undefined,
            language_preference: args.language_preference as string | undefined,
            working_hours:       args.working_hours       as string | undefined,
            working_hours_structured: args.working_hours_structured as PersonProfile['working_hours_structured'],
            role_summary:        args.role_summary        as string | undefined,
            reports_to:          args.reports_to          as string | undefined,
            response_speed:      args.response_speed      as PersonProfile['response_speed'],
            collaboration_notes: args.collaboration_notes as string | undefined,
          });
          // v3.2.6 — owner-curated VIP flag (externals can be VIPs too).
          if (typeof args.vip === 'boolean') {
            const { setPersonVipById } = require('../db') as typeof import('../db');
            setPersonVipById(target.personId, args.vip);
          }
          logger.info('Person profile updated (external)', { personId: target.personId, name: target.name });
          const described = describeCoreWrites(coreWrites, context.profile.user.name.split(' ')[0]);
          return {
            updated: true, name: target.name, external: true,
            ...(described.not_saved ? { not_saved: described.not_saved } : {}),
            ...(described.already_set ? { already_set: described.already_set } : {}),
            ...(described.notes.length > 0 ? { _note: described.notes.join(' ') } : {}),
          };
        }

        // v2.2.2 (#46) — route every core field through the provenance helper, and
        // collect each write's outcome: what landed, what was already exactly that,
        // and what a higher authority refused. Ensure the row exists first — the
        // upsert only writes the name here, because a STATED timezone belongs to
        // the provenance write below (passing it both ways wrote the field twice).
        upsertPersonMemory({ slackId, name });
        const coreWrites: Array<[string, CoreFieldWrite]> = [];

        if (nameHe && nameHe.trim()) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
          coreWrites.push(['name_he', setCoreFieldWithProvenance(slackId, 'name_he', nameHe.trim(), setBy)]);
        }

        // v2.2.2 (#46) — STATE: free-text location, stamped with who stated it.
        // When state lands and timezone wasn't also passed in this same call,
        // try to derive timezone from the state and save with same provenance —
        // a zone inferred from a stated city has that same statement as its source.
        if (state && state.trim()) {
          const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
          coreWrites.push(['state', setCoreFieldWithProvenance(slackId, 'state', state.trim(), setBy)]);
          if (!timezone) {
            // Static-first lookup; Sonnet fallback if needed. Fire-and-forget.
            void (async () => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { inferTimezoneFromState } = require('../utils/locationTz') as typeof import('../utils/locationTz');
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
                const tz = await inferTimezoneFromState(state.trim());
                // v3.0.2 — same strict-IANA gate as the direct timezone arg.
                // inferTimezoneFromState has a Sonnet fallback that occasionally
                // hands back ambiguous abbreviations.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { isStrictIana } = require('../utils/timezoneValidator') as
                  typeof import('../utils/timezoneValidator');
                if (tz && isStrictIana(tz)) {
                  setCoreFieldWithProvenance(slackId, 'timezone', tz, setBy);
                  refreshAutoWorkingHours(slackId);
                } else if (tz) {
                  logger.warn('state→tz derivation produced non-IANA value — discarded', {
                    slackId, state, derived: tz,
                  });
                }
              } catch (err) {
                logger.debug('state→tz derivation failed', { slackId, state, err: String(err).slice(0, 200) });
              }
            })();
          }
        }

        // v2.2.2 (#46) — an explicitly passed timezone is an authoritative
        // statement by whoever sent the turn. This is the ONLY write of the field
        // on this path (the upsert above no longer takes it), so its outcome is
        // the one that gets reported.
        if (timezone && timezone.trim()) {
          const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
          coreWrites.push(['timezone', setCoreFieldWithProvenance(slackId, 'timezone', timezone.trim(), setBy)]);
          // Refresh the auto-derived working hours off whatever zone is now STORED
          // (the write may have been refused as lower-authority).
          refreshAutoWorkingHours(slackId);
        }

        updatePersonProfile(slackId, {
          communication_style: args.communication_style as string | undefined,
          language_preference: args.language_preference as string | undefined,
          working_hours:       args.working_hours       as string | undefined,
          working_hours_structured: args.working_hours_structured as PersonProfile['working_hours_structured'],
          role_summary:        args.role_summary        as string | undefined,
          reports_to:          args.reports_to          as string | undefined,
          response_speed:      args.response_speed      as PersonProfile['response_speed'],
          collaboration_notes: args.collaboration_notes as string | undefined,
        });

        // v2.2 — owner directive override for engagement_rank. Tool only
        // accepts this arg when owner explicitly tells Sonnet to set a rank
        // (prompt rule in the tool description). Audit-logged with
        // reason='owner_directive'.
        if (typeof args.engagement_rank === 'number') {
          const clamped = Math.max(0, Math.min(3, Math.round(args.engagement_rank))) as 0 | 1 | 2 | 3;
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { setEngagementRank } = require('../db') as typeof import('../db');
          setEngagementRank(slackId, clamped, 'owner_directive');
        }

        // v3.2.6 — owner-curated VIP flag. Owner-path only by construction
        // (colleague-self writes drop `vip` — it's not in the self-writable
        // allowlist), like engagement_rank.
        if (typeof args.vip === 'boolean') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { setPersonVip } = require('../db') as typeof import('../db');
          setPersonVip(slackId, args.vip);
        }

        // v2.2.4 — travel awareness. clear=true wipes; otherwise expects
        // location/from/until. The tool description tells Sonnet to set this
        // when colleague volunteers travel info OR owner reports it. Reads
        // (slot search, pronoun-of-time-of-day) prefer travel over default
        // tz/state when the window covers `now`.
        const travel = args.currently_traveling as
          | { location?: string; from?: string; until?: string; for_days?: number; for_weeks?: number; clear?: boolean }
          | undefined;
        if (travel && typeof travel === 'object') {
          const { setCurrentTravel, clearCurrentTravel } = require('../db') as typeof import('../db');
          if (travel.clear === true) {
            clearCurrentTravel(slackId);
          } else if (travel.location && travel.from) {
            // v2.5.2 — derive `until` from for_days / for_weeks when explicit
            // `until` not provided. Either form is accepted; explicit `until`
            // wins when both are passed.
            let untilIso = travel.until;
            if (!untilIso && (typeof travel.for_days === 'number' || typeof travel.for_weeks === 'number')) {
              const days = (typeof travel.for_days === 'number' && travel.for_days > 0) ? travel.for_days : 0;
              const weeks = (typeof travel.for_weeks === 'number' && travel.for_weeks > 0) ? travel.for_weeks : 0;
              const totalDays = days + (weeks * 7);
              if (totalDays > 0) {
                // Inclusive last day: from + totalDays - 1.
                const { DateTime } = require('luxon') as typeof import('luxon');
                const fromDt = DateTime.fromISO(travel.from);
                if (fromDt.isValid) {
                  untilIso = fromDt.plus({ days: totalDays - 1 }).toFormat('yyyy-MM-dd');
                }
              }
            }
            if (untilIso) {
              setCurrentTravel(slackId, {
                location: travel.location,
                from: travel.from,
                until: untilIso,
              });
            }
          }
        }

        const fieldsWritten = Object.keys(args).filter(k => k !== 'colleague_slack_id' && k !== 'colleague_name');
        logger.info('Person profile updated', { slackId, name, fields: fieldsWritten });

        // v3.0.7 — stale-slot-results signal. When the write touches a
        // field that affects find_available_slots' verdict for this person
        // (timezone / workdays / work hours), enrich the tool result with
        // a flag + note. The next Sonnet iteration sees the note in the
        // raw tool result content and re-runs find_available_slots instead
        // of mentally filtering its prior memory of slot options. Closes
        // the 2026-05-26 morning bug: owner said "Isaac works Mon-Fri",
        // Maelle wrote the profile, then narrated "Monday 11:00 is the
        // clean option" from her stale turn-1 memory without re-running
        // the tool to get an updated 3-option spread.
        const SLOT_RELEVANT_FIELDS = new Set([
          'timezone', 'working_hours', 'working_hours_structured',
          'workdays', 'work_hours', 'currently_traveling',
        ]);
        const slotRelevant = fieldsWritten.some(f => SLOT_RELEVANT_FIELDS.has(f));

        const base = { updated: true, name } as Record<string, unknown>;
        const notes: string[] = [];

        if (slotRelevant) {
          base._slot_results_now_stale = true;
          notes.push(`You updated slot-relevant fields for ${name}. Any prior find_available_slots results involving ${name} are now stale — the candidate set changes with the new constraint. Re-run find_available_slots before proposing options to the owner. Do not mentally filter old slot candidates; the tool's diagnostics (day_summary, attendee work-hours filter, etc.) need to re-evaluate.`);
        }

        // What each core-field write actually did. A field the OWNER already set
        // outranks a person's statement about themselves (SET_BY_RANK,
        // db/people.ts), so a colleague's correction can be refused — say so
        // rather than report a save that never landed. And a field that already
        // held exactly the stated value is neither: nothing needed doing, which is
        // the honesty confirm_gender owes too.
        const described = describeCoreWrites(coreWrites, context.profile.user.name.split(' ')[0]);
        if (described.not_saved) {
          base.not_saved = described.not_saved;
          logger.info('update_person_profile — fields refused, a higher authority outranks the writer', {
            requesterId: context.userId, isOwner, refused: described.not_saved,
          });
        }
        if (described.already_set) base.already_set = described.already_set;
        notes.push(...described.notes);

        if (notes.length > 0) base._note = notes.join(' ');
        return base;
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(_profile: UserProfile): string {
    // The actual learned content is injected in systemPrompt.ts directly
    // This skill just contributes the tool descriptions above
    return '';
  }
}
