import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import { savePreference, getPreferences, deletePreference, upsertPersonMemory, appendPersonNote, appendPersonInteraction, recordSocialMoment, updatePersonProfile, setPersonNameHe, confirmPersonGender, getEventsByActor, getPersonMemory as getPersonMemoryRow, type SocialTopicQuality, type PersonProfile, type PersonInteraction } from '../db';
import {
  readPersonMemory,
  writePersonSection,
  resolvePersonSlug,
  slugifyName,
  listPersonFiles,
} from '../memory/peopleMemory';
// v2.2 — socialEngagement module retired. Owner social signals are now
// tracked by the Social Engine on the orchestrator's post-turn pass; the
// per-turn "engagement upgrader" is no longer needed.
import { DateTime } from 'luxon';
import logger from '../utils/logger';

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
        name: 'learn_preference',
        description: `Save something you have learned — about the user, their preferences, or about specific people they work with.
Call this when:
- The user tells you something about how they work or what they prefer
- The user tells you something personal about a colleague (nickname, preferences, relationship context)
- You notice a clear pattern worth remembering
- Something funny or personal comes up in conversation that should be remembered

Examples:
- "prefers calls before noon local time"
- "Isaac Cohen goes by Ike informally and prefers afternoon calls"
- "Yael Aharon handles all interview scheduling — treat her meeting requests as high priority"
- "Person X and [owner name] have a running joke about always joining calls late"

Do NOT save one-off requests. Save things that should inform future interactions.`,
        input_schema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['scheduling', 'communication', 'people', 'general'],
              description: 'Category: scheduling=calendar habits, communication=how they like to communicate, people=info about contacts, general=anything else',
            },
            key: {
              type: 'string',
              description: 'Short unique identifier, lowercase with underscores. e.g. "prefers_morning_calls", "yael_handles_interviews"',
            },
            value: {
              type: 'string',
              description: "The fact in plain English. For people category, include the person name. Examples: '[Person] prefers afternoon calls and goes by [nickname] informally', '[Person] handles all interview coordination — treat their requests as high priority', '[Person] and [owner] have a running joke about always joining calls late'",
            },
          },
          required: ['category', 'key', 'value'],
        },
      },
      {
        name: 'forget_preference',
        description: 'Remove a previously learned preference that is no longer accurate.',
        input_schema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The key of the preference to remove',
            },
          },
          required: ['key'],
        },
      },
      {
        name: 'recall_preferences',
        description: 'Retrieve everything you have learned about the user. Call this at the start of a complex scheduling task to make sure you have full context.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      // v1.6.1 — message_colleague and find_slack_channel moved into
      // src/core/outreach.ts (OutreachCoreSkill). This file now only owns
      // memory concerns (preferences, people, interactions, gender).
      {
        name: 'recall_interactions',
        description: `Look up past interactions with a specific person — messages they sent, meetings coordinated, outreach done.
Call this when asked "did you talk to X?", "has Dina contacted you?", "what happened with Simon?", or any question about a specific person's recent activity.
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
      {
        name: 'note_about_person',
        description: `Record something you just learned about a person through natural conversation.

Call this when:
- A colleague or the owner shares something personal (hobby, family, upcoming event, feelings, language preference, how they like to be addressed, etc.)
- You asked something social and they answered
- You noticed a language preference (e.g. they always reply in Hebrew even when you write English)
- You learned how they prefer to be addressed (nickname, formal name, etc.)
- You noticed something worth remembering that will make future conversations more personal

Examples of good notes:
- "Mentioned she's training for a half marathon in May"
- "Has two kids, eldest just started university"
- "Big football fan — supports Real Madrid"
- "Always replies in Hebrew — prefers to communicate in Hebrew"
- "Goes by Ike, not Isaac"
- "Said the board meeting last week was intense — seemed relieved it went well"
- "Has a cat named Mochi"
- "Studying for an MBA part-time"

Do NOT call this for purely work-related facts (those go in learn_preference). This is for human, personal, relationship-building context.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID of the person',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the person',
            },
            note: {
              type: 'string',
              description: 'What you learned, in plain English. Be specific — vague notes are useless later.',
            },
            topic: {
              type: 'string',
              description: 'Broad enum category. Pair this with a specific subject (see below).',
              enum: [
                'family',       // spouse, kids, parents, relationships
                'health',       // fitness, illness, medical
                'sport',        // team sports, running, gym, watching sports
                'hobby',        // music, art, gaming, cooking, reading, photography
                'travel',       // trips, places visited, upcoming travel
                'mood',         // emotional state, vibe, energy level
                'food',         // dietary preferences, favourite restaurants, cuisine
                'culture',      // movies, shows, books, music they like
                'pets',         // animals they have or love
                'goals',        // personal ambitions, things they're working toward
                'weekend',      // what they do on weekends, recent activities
                'humor',        // running jokes, things that make them laugh
                'education',    // studying, degrees, learning something new
                'language',     // preferred language, how they communicate
                'local',        // neighbourhood, where they live, commute
                'news',         // current events they mentioned or care about
                'other',        // anything that doesn't fit the above
              ],
            },
            subject: {
              type: 'string',
              description: 'REQUIRED specific subject string — the actual thing you\'re asking/learning about. The 24h cooldown fires on (topic + subject), so be SPECIFIC: "clair obscur game" (not just "hobby"), "half marathon training", "son starting first grade", "trip to Kyoto", "tennis elbow recovery". Use 2–5 lowercased words. When the SAME subject comes up again, reuse the same subject string so the counter increments instead of creating a duplicate row.',
            },
            topic_quality: {
              type: 'string',
              description: 'How engaged was the person on this topic? neutral=gave a brief/one-word answer, engaged=opened up a bit and shared details, good=really connected and shared openly',
              enum: ['neutral', 'engaged', 'good'],
            },
            initiated_by: {
              type: 'string',
              description: 'Who started this social exchange? maelle=you brought it up, person=they volunteered it or started the personal chat',
              enum: ['maelle', 'person'],
            },
          },
          required: ['colleague_slack_id', 'colleague_name', 'note', 'topic'],
        },
      },
      {
        name: 'note_about_self',
        description: `Same as note_about_person but for the OWNER (yourself's principal). Convenience wrapper — you don't need to pass slack_id, it's the owner's by definition.

Call this when:
- The OWNER shares something personal in conversation (a hobby, family thing, sport, weekend plans, mood, what they were working on, etc.)
- You asked them a social question and they answered
- They volunteer something about themselves worth remembering for richer future chat

Examples:
- After "I was building you all day" → topic="hobby", subject="building Maelle", note="Spent the day developing Maelle — clearly enjoying the AI/dev work."
- After "Just got back from skiing in Italy" → topic="travel", subject="ski trip italy", note="Just back from skiing in Italy — sounded relaxed."
- After "My daughter started first grade today" → topic="family", subject="daughter first grade", note="Daughter started first grade today."

Owner-only. Do NOT use this for colleagues (use note_about_person for them).`,
        input_schema: {
          type: 'object',
          properties: {
            note: {
              type: 'string',
              description: 'What you learned, in plain English. Be specific — vague notes are useless later.',
            },
            topic: {
              type: 'string',
              enum: [
                'family', 'health', 'sport', 'hobby', 'travel', 'mood',
                'food', 'culture', 'pets', 'goals', 'weekend', 'humor', 'education',
                'language', 'local', 'news', 'other',
              ],
              description: 'Broad enum category. Pair with a specific subject below.',
            },
            subject: {
              type: 'string',
              description: 'REQUIRED specific subject string. The 24h cooldown fires on (topic + subject), so be SPECIFIC: "building Maelle" (not just "hobby"), "ski trip italy", "daughter first grade", "marathon training". Use 2–5 lowercased words. When the SAME subject comes up again, reuse the exact string so the counter increments.',
            },
            topic_quality: {
              type: 'string',
              enum: ['neutral', 'engaged', 'good'],
              description: 'How engaged was the owner on this topic? neutral=brief mention, engaged=opened up a bit, good=really shared openly. Default neutral.',
            },
            initiated_by: {
              type: 'string',
              enum: ['maelle', 'person'],
              description: 'Who started the social moment? maelle=you asked them, person=they volunteered.',
            },
          },
          required: ['note', 'topic', 'subject'],
        },
      },
      {
        name: 'update_person_profile',
        description: `Update the structured profile for a person — call this when you've observed enough to reliably assess a dimension.

You don't need explicit statements. Infer from behavior:
- engagement_level: observe how they respond over multiple interactions. Always short and never reciprocates → "minimal". Proactively chats and asks questions back → "interactive".
- communication_style: describe their message pattern. "Brief, direct, never asks questions back" or "Detailed, conversational, often elaborates".
- language_preference: if they consistently reply in a different language from the one you used — save it here.
- timezone: save as soon as you have a signal. If the person mentions a meeting in ET/PST/GMT/etc., or their email/calendar shows a US/EU/Asia location, save the IANA zone here (e.g. "America/New_York", "America/Los_Angeles", "Europe/London", "Australia/Sydney"). Don't overwrite a known timezone unless the new signal is clearly stronger.
- working_hours: infer from their timezone and when they actually respond. "Israel 9am–6pm" or "Responds in US Eastern mornings".
- role_summary: piece together from calendar meetings you've seen, topics they mention, side context. "EMEA sales lead, focused on Q3 targets."
- reports_to: if you learn who their manager is — save it.
- response_speed: how long they typically take to reply. "immediate", "fast" (under an hour), "hours", "day", "slow", "unreliable".
- collaboration_notes: people they always appear with in meetings, who they coordinate with. "Often in calls with David and Yael. Runs Monday team sync."

Only update a field when you have real evidence. Omit fields you don't know yet.
Call this after interactions — not during them. It's a background update.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID of the person',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the person',
            },
            engagement_level: {
              type: 'string',
              enum: ['avoidant', 'minimal', 'neutral', 'friendly', 'interactive'],
              description: 'avoidant=ignores/one-word always, minimal=rarely engages, neutral=normal, friendly=warm, interactive=proactively chats',
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
              description: 'IANA timezone of the person. Save when the owner volunteers it OR a strong signal lands (calendar invite metadata, explicit mention of ET/PST/GMT). e.g. "America/New_York", "Europe/London", "Asia/Jerusalem". When the owner tells you a CITY/COUNTRY use the `state` field instead — Maelle will derive the timezone from it.',
            },
            state: {
              type: 'string',
              description: 'Free-text location for the person — city, region, or country ("Boston", "New York", "Israel", "London"). Save when the owner volunteers it ("Yael lives in Israel") or the person tells you. State is more useful than timezone alone (Boston ≠ NYC even though both are ET). When state lands, Maelle automatically derives + saves a matching IANA timezone.',
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
              description: 'Numeric social engagement rank 0–3. 0=don\'t initiate social with them (opt-out), 1=minimal, 2=neutral (default for new), 3=loves to chat. Set ONLY when the owner explicitly directs you ("rank Yael at 3", "never ping Ysrael" → 0). Don\'t auto-set — the system auto-adjusts based on ping responses.',
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
- A meeting was booked involving this person ("Booked 45min between Idan and Maayan for Thu 10 Apr 14:00")
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
              description: 'Slack user ID of the person',
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
              description: 'Slack user ID of the person whose gender is being confirmed.',
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
        description: `Load the full markdown notes you have on a person — residence, workplace, working hours, communication style, etc. The owner and colleagues each have (or can have) a file.

Call this when:
- A person relevant to the current turn appears in the PEOPLE NOTES catalog (see system prompt) and you need the details
- You want to check what you already know before asking them something you might have asked before
- Scheduling for them, messaging them, or answering a question about them benefits from the context

Keep calls narrow — one person at a time. If the person isn't in the catalog, there's no file; use update_person_memory to start one when you learn the first real fact.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            person: {
              type: 'string',
              description: 'Person identifier — their slug from the PEOPLE NOTES catalog ("amazia-cohen"), their display name ("Amazia Cohen"), or first name ("Amazia"). Slug is most reliable.',
            },
          },
          required: ['person'],
        },
      },
      {
        name: 'update_person_memory',
        description: `Write a durable fact about a person into their markdown notes file. This is for OPERATIONAL facts that help you be a better assistant — not for social topics.

Use for facts like:
- Where they live (residence): "Idan lives in Nes Ziona."
- Where they work (workplace): "Reflectiz office in Tel Aviv, goes in Mon/Wed/Thu."
- Working hours: "Responds US Eastern mornings, offline after 5pm ET for school pickup."
- Communication style: "Prefers brief replies. Never uses greetings."
- How to address them: "Goes by Ike, not Isaac."
- Preferred meeting mode: "Always does Teams, even for 1:1s."

Do NOT use for:
- Social topics / hobbies / family stories — those go to note_about_person or note_about_self. The Social Engine owns that.
- Ephemeral state (mood today, running late) — that's a log_interaction entry.

Sections: pick a h2 header that describes the fact — "Residence", "Workplace", "Working hours", "Communication style", "What we've discussed", or a new one that fits. If the section already exists in the file, its body will be REPLACED. If it doesn't, the section is APPENDED.

First call for a person auto-creates their md file. Empty-until-real-fact — don't write empty or speculative content just to create a file.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            person: {
              type: 'string',
              description: 'Person identifier — slug, display name, or first name. For the owner use his first name (e.g. "Idan") or his slack id.',
            },
            section: {
              type: 'string',
              description: 'Section header for this fact. Prefer the standard ones: "Residence", "Workplace", "Working hours", "Communication style", "What we\'ve discussed". Case-insensitive match — don\'t create a duplicate header with different casing.',
            },
            text: {
              type: 'string',
              description: 'The fact, in plain markdown. One or two sentences usually. Be specific — "Idan lives in Nes Ziona" beats "lives south of Tel Aviv".',
            },
          },
          required: ['person', 'section', 'text'],
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

    // ── Colleague hard-blocks ─────────────────────────────────────────────────
    // These operations are owner-only regardless of what the prompt says.
    if (!isOwner) {
      const ownerOnlyTools = ['learn_preference', 'forget_preference', 'recall_preferences', 'update_person_profile', 'update_person_memory', 'get_person_memory', 'finalize_coord_meeting'];
      if (ownerOnlyTools.includes(toolName)) {
        logger.warn('Colleague attempted owner-only tool', { tool: toolName, userId: context.userId });
        return { error: 'not_permitted', reason: 'This action can only be performed by the owner.' };
      }
      // note_about_person: colleague can only add a note about themselves
      if (toolName === 'note_about_person') {
        const targetId = args.slack_id as string | undefined;
        if (targetId && targetId !== context.userId) {
          logger.warn('Colleague tried to write note about another person', { targetId, requesterId: context.userId });
          return { error: 'not_permitted', reason: 'You can only add notes about yourself, not other people.' };
        }
      }
      // log_interaction: colleague can only log interactions involving themselves
      if (toolName === 'log_interaction') {
        const targetId = args.slack_id as string | undefined;
        if (targetId && targetId !== context.userId) {
          logger.warn('Colleague tried to log interaction for another person', { targetId, requesterId: context.userId });
          return { error: 'not_permitted', reason: 'You can only log your own interactions.' };
        }
      }
      // confirm_gender: colleague can only confirm their OWN gender
      if (toolName === 'confirm_gender') {
        const targetId = args.colleague_slack_id as string | undefined;
        if (targetId && targetId !== context.userId) {
          logger.warn('Colleague tried to confirm another person\'s gender', { targetId, requesterId: context.userId });
          return { error: 'not_permitted', reason: 'You can only confirm your own gender, not someone else\'s.' };
        }
      }
    }

    switch (toolName) {
      case 'recall_interactions': {
        const name = (args as any).name as string;
        const events = getEventsByActor(userId, name);

        if (events.length === 0) {
          return {
            found: false,
            message: `No recorded interactions with ${name} in the event log.`,
          };
        }

        return {
          found: true,
          count: events.length,
          interactions: events.map(e => ({
            date: e.created_at,
            type: e.type,
            summary: e.title,
            detail: e.detail,
          })),
        };
      }

      case 'learn_preference': {
        const prefValue = args.value as string | null | undefined;
        if (prefValue == null || prefValue === '') {
          logger.warn('learn_preference called with empty value — skipped', { key: args.key });
          return { saved: false, reason: 'value was empty — nothing stored' };
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

      case 'forget_preference': {
        const deleted = deletePreference(userId, args.key as string);
        logger.info('Preference deleted', { userId, key: args.key, deleted });
        return { deleted, key: args.key };
      }

      case 'recall_preferences': {
        const prefs = getPreferences(userId);
        return { preferences: prefs, count: prefs.length };
      }


      case 'note_about_person': {
        const slackId     = args.colleague_slack_id as string;
        const name        = args.colleague_name as string;
        const note        = args.note as string;
        const topic       = args.topic as string;
        const subject     = (args.subject as string | undefined)?.trim() || undefined;
        const quality     = (args.topic_quality as SocialTopicQuality | undefined) ?? 'neutral';
        const initiatedBy = (args.initiated_by as 'maelle' | 'person' | undefined) ?? 'maelle';

        // Make sure the person exists in people_memory before writing
        upsertPersonMemory({ slackId, name });

        // Append to personal notes (who they are)
        appendPersonNote(slackId, note);

        // Also log to activity timeline (what happened)
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });

        // v2.2 — topic/quality/subject arguments are accepted for tool-schema
        // back-compat but the legacy topic-tracking in people_memory is
        // retired. The call below only updates last_social_at + last_initiated_at
        // (cooldown gate for colleague rapport). Topic memory for the owner
        // lives in the Social Engine now.
        recordSocialMoment(slackId, topic, quality, initiatedBy, subject);

        logger.info('Social note saved', { slackId, name, topic, subject, quality, initiatedBy });
        return { saved: true, name, topic, subject, quality };
      }

      case 'note_about_self': {
        // Owner-only by semantics — this writes to the OWNER's people_memory row.
        if (context.senderRole !== 'owner') {
          logger.warn('Colleague tried to call note_about_self — blocked', { userId: context.userId });
          return { error: 'not_permitted', reason: 'Only the owner can note things about themselves.' };
        }
        const slackId     = context.profile.user.slack_user_id;
        const name        = context.profile.user.name;
        const note        = args.note as string;
        const topic       = args.topic as string;
        const subject     = (args.subject as string | undefined)?.trim() || undefined;
        const quality     = (args.topic_quality as SocialTopicQuality | undefined) ?? 'neutral';
        const initiatedBy = (args.initiated_by as 'maelle' | 'person' | undefined) ?? 'person';

        // Ensure the owner row exists (seedOwnerSelf at startup should have, but
        // upsert is idempotent and safe).
        upsertPersonMemory({
          slackId,
          name,
          email:    context.profile.user.email,
          timezone: context.profile.user.timezone,
        });

        // Personal notes (who they are)
        appendPersonNote(slackId, note);

        // Activity timeline (what happened)
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });

        // v2.2 — legacy topic quality tracking retired. recordSocialMoment
        // still updates last_social_at + last_initiated_at for the 24h gate.
        // Owner topic memory is now owned by the Social Engine, which fires
        // automatically on every owner turn — no explicit tool call needed.
        recordSocialMoment(slackId, topic, quality, initiatedBy, subject);

        logger.info('Owner self-note saved', { slackId, topic, subject, quality, initiatedBy });
        return { saved: true, scope: 'owner', topic, subject, quality };
      }

      case 'log_interaction': {
        const slackId = args.colleague_slack_id as string;
        const name    = args.colleague_name as string;

        upsertPersonMemory({ slackId, name });
        appendPersonInteraction(slackId, {
          type: args.type as PersonInteraction['type'],
          summary: args.summary as string,
        });

        logger.info('Interaction logged', { slackId, name, type: args.type, summary: args.summary });
        return { logged: true, name };
      }

      case 'confirm_gender': {
        const slackId = args.colleague_slack_id as string;
        const name    = (args.colleague_name as string | undefined) ?? slackId;
        const gender  = args.gender as 'male' | 'female';
        // Make sure the row exists (cheap no-op if it does)
        upsertPersonMemory({ slackId, name });

        // v2.2.2 (#46) — provenance: owner-path call → 'owner' (highest authority,
        // can overwrite person-set values, anti-spoofing). Colleague-path call
        // is restricted by the gate above to colleague_slack_id === context.userId
        // (self-confirm only) — that's 'person' authority.
        const setBy = isOwner ? 'owner' : 'person';
        const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
        const wrote = setCoreFieldWithProvenance(slackId, 'gender', gender, setBy);
        if (!wrote) {
          // Higher-rank value already locked — surface so the LLM doesn't claim it saved.
          logger.info('confirm_gender refused — higher-rank provenance already set', { slackId, gender, setBy });
          return { confirmed: false, reason: 'higher_authority_already_set', name };
        }
        // Keep legacy confirmPersonGender side-effect (gender_confirmed=1) — readers
        // that haven't migrated still see the lock. setCoreFieldWithProvenance also
        // sets gender_confirmed when by != 'auto', so this is belt-and-suspenders.
        confirmPersonGender(slackId, gender);
        logger.info('Gender confirmed (human-locked)', { slackId, name, gender, setBy, confirmedBy: context.userId });
        return { confirmed: true, name, gender, set_by: setBy };
      }

      case 'get_person_memory': {
        const query = (args.person as string | undefined)?.trim();
        if (!query) return { error: 'empty_person' };
        const slug = (await resolvePersonSlug(context.profile, query)) ?? slugifyName(query);
        const content = await readPersonMemory(context.profile, slug);
        if (content === null) {
          return {
            found: false,
            slug,
            message: `No memory file yet for "${query}" — no durable facts recorded. Use update_person_memory when you learn one.`,
          };
        }
        logger.info('Person memory fetched', { slug, bytes: content.length });
        return { found: true, slug, content };
      }

      case 'update_person_memory': {
        const query = (args.person as string | undefined)?.trim();
        const section = (args.section as string | undefined)?.trim();
        const text = args.text as string | undefined;
        if (!query) return { error: 'empty_person' };
        if (!section) return { error: 'empty_section' };
        if (!text || !text.trim()) return { error: 'empty_text' };

        // Resolve to an existing slug if possible; otherwise create by slug of
        // the supplied name. Display name prefers the people_memory row for
        // colleagues, falls back to the supplied query.
        let slug = await resolvePersonSlug(context.profile, query);
        let displayName: string | undefined;

        if (!slug) {
          // New file — try to enrich display name from people_memory if the
          // query looks like a slack id.
          const row = getPersonMemoryRow(query);
          if (row) {
            displayName = row.name;
            slug = slugifyName(row.name);
          } else {
            displayName = query;
            slug = slugifyName(query);
          }
        } else {
          // Existing file — use the listed display name
          const existing = (await listPersonFiles(context.profile)).find(f => f.slug === slug);
          displayName = existing?.displayName ?? query;
        }

        const result = await writePersonSection({
          profile: context.profile,
          slug,
          displayName: displayName ?? query,
          section,
          text,
        });
        if (!result.ok) {
          logger.warn('update_person_memory failed', { slug, section, err: result.error });
          return { ok: false, error: result.error };
        }
        return { ok: true, slug, section, created: result.created };
      }

      case 'update_person_profile': {
        const slackId = args.colleague_slack_id as string;
        const name    = args.colleague_name as string;
        const timezone = args.timezone as string | undefined;
        const state   = args.state as string | undefined;
        const nameHe  = args.name_he as string | undefined;

        // v2.2.2 (#46) — owner-path tool. Anything the owner sets here is
        // owner-stated by definition; route through the provenance helper.
        // Ensure the row exists first; upsertPersonMemory tracks tz_set_by='owner'
        // when we pass timezone alongside.
        upsertPersonMemory({ slackId, name, timezone, timezoneSetBy: 'owner' });

        if (nameHe && nameHe.trim()) {
          setPersonNameHe(slackId, nameHe.trim());
        }

        // v2.2.2 (#46) — STATE: free-text location. Owner-stated → set_by='owner'.
        // When state lands and timezone wasn't also passed in this same call,
        // try to derive timezone from the state and save with same provenance.
        if (state && state.trim()) {
          const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
          setCoreFieldWithProvenance(slackId, 'state', state.trim(), 'owner');
          if (!timezone) {
            // Static-first lookup; Sonnet fallback if needed. Fire-and-forget.
            void (async () => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { inferTimezoneFromState } = require('../utils/locationTz') as typeof import('../utils/locationTz');
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
                const tz = await inferTimezoneFromState(state.trim());
                if (tz) {
                  setCoreFieldWithProvenance(slackId, 'timezone', tz, 'owner');
                  refreshAutoWorkingHours(slackId);
                }
              } catch (err) {
                logger.debug('state→tz derivation failed', { slackId, state, err: String(err).slice(0, 200) });
              }
            })();
          }
        }

        // v2.2.2 (#46) — when owner passes timezone explicitly, lock it as owner-set.
        // upsertPersonMemory only writes via COALESCE so an existing value isn't
        // touched there. Use the provenance helper for an authoritative overwrite.
        if (timezone && timezone.trim()) {
          const { setCoreFieldWithProvenance } = require('../db') as typeof import('../db');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
          setCoreFieldWithProvenance(slackId, 'timezone', timezone.trim(), 'owner');
          refreshAutoWorkingHours(slackId);
        }

        updatePersonProfile(slackId, {
          engagement_level:    args.engagement_level    as PersonProfile['engagement_level'],
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

        logger.info('Person profile updated', { slackId, name, fields: Object.keys(args).filter(k => k !== 'colleague_slack_id' && k !== 'colleague_name') });
        return { updated: true, name };
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
