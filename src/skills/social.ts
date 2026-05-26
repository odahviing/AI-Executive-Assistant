/**
 * SocialSkill (v2.6.2, was PersonaSkill v2.2.3) — togglable social engine.
 *
 * Master on/off for everything social Maelle does — engage replies, codas,
 * proactive cold-pings, topic memory, engagement-rank ladder, social
 * context blocks. When off, Maelle is task-only.
 *
 * What's in this skill:
 *   - Tools: `note_about_person`, `note_about_self`
 *   - System prompt section nudging Maelle to engage as a teammate, not just
 *     a task router (gaming chat, weekend small talk, etc.)
 *
 * What's NOT here (still in CORE — runs whether social is on or off):
 *   - Owner preferences (learn_preference / recall_preferences)
 *   - Core attendee fields (gender / timezone / state via update_person_profile)
 *   - confirm_gender, log_interaction, recall_interactions
 *   - Per-person md memory (get_person_memory / update_person_memory)
 *   - Slack auto-pull of timezone / pronouns / image
 *   - The owner / colleague identity blocks in the system prompt
 *
 * Other social machinery gated on `skills.social` from outside this file:
 *   - Social engine pre-pass (`src/core/social/*`) — orchestrator skips when off
 *   - Outreach tick / decay / rank-check tasks — dispatchers no-op when off
 *   - Codas (task-tail warm lines) — orchestrator skips when off
 *   - WORKSPACE CONTACTS social fields (last_social_at, topics, engagement_rank)
 *   - buildSocialContextBlock per-sender SOCIAL CONTEXT block in prompt
 *
 * Profile YAML key: `skills.social: true | false`. Default false (Maelle is
 * task-only out of the box; opt in to the friend-of-the-team behavior).
 * Legacy `skills.persona` still parses and auto-migrates in registry.ts.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  upsertPersonMemory,
  appendPersonNote,
  appendPersonInteraction,
  recordSocialMoment,
} from '../db';
import logger from '../utils/logger';

const SOCIAL_TOPIC_ENUM = [
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
] as const;

export class SocialSkill implements Skill {
  id = 'social' as const;
  name = 'Social';
  description = 'Social engine — proactive outreach, codas, engage replies, topic memory, engagement-rank ladder. The friend-of-the-team layer. Optional.';

  getTools(profile: UserProfile): Anthropic.Tool[] {
    return [
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
- "Goes by a nickname, not the legal first name"
- "Said the board meeting last week was intense — seemed relieved it went well"
- "Has a cat named Mochi"
- "Studying for an MBA part-time"

Do NOT call this for purely work-related facts (those go in manage_preference(action='set')). This is for human, personal, relationship-building context.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            colleague_slack_id: { type: 'string', description: 'Slack user ID — opaque string like "U09EXAMPLE9" (starts with U or W, then 6+ alphanumerics, NO underscores). NEVER write a name-shaped invention like "U_ORAN_FRENKEL". Omit if you don\'t have the real ID — pass colleague_name only and the system resolves it.' },
            colleague_name:     { type: 'string', description: 'Display name of the person' },
            note:               { type: 'string', description: 'What you learned, in plain English. Be specific — vague notes are useless later.' },
            topic: {
              type: 'string',
              description: 'Broad enum category. Pair this with a specific subject (see below).',
              enum: [...SOCIAL_TOPIC_ENUM],
            },
            subject: {
              type: 'string',
              description: 'REQUIRED specific subject string — the actual thing you\'re asking/learning about. Be SPECIFIC: "clair obscur game" (not just "hobby"), "half marathon training", "son starting first grade", "trip to Kyoto", "tennis elbow recovery". Use 2–5 lowercased words. The string lands as a tag on the interaction-log entry; the end-of-chat capture pass reconciles it into the colleague\'s social subjects.',
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
        description: `When ${profile.user.name.split(' ')[0]} teaches or corrects something about who you are (name origin, story, identity, age, how you work, personality) IN conversation: react to what he said FIRST in your text reply, then call this tool to save the fact. The save is bookkeeping that runs WITH your text reply, never INSTEAD of it. A turn that calls this tool with no conversational text reply is a bug.

Saved facts live in your own ABOUT YOU block, visible in every conversation (owner + colleagues), so future identity questions can be answered from saved facts instead of deflecting.

Call this when ${profile.user.name.split(' ')[0]} teaches you something about your identity, corrects how you describe yourself, or shares a fact about you that should outlive this conversation.

Examples (owner says → you react in text + save):
- "You were named after a character in a book I love" → text reply: "Oh — which book? I'd like to know the source." + save: note="Named after a character from a book the owner loves."
- "Your style should be warm but direct, not chatty" → text reply: "Got it — I'll keep it warm and direct, not chatty." + save: note="Preferred tone: warm but direct, not chatty."
- "You don't need to apologize so much" → text reply: "Fair — I'll cut the over-apologizing." + save: note="Avoid over-apologizing in replies."

Owner-path saves to Maelle's SELF row (becomes visible in every conversation via the ABOUT YOU block). Colleague-path saves to the colleague's own row — colleagues cannot teach Maelle facts about herself, but they can volunteer facts about themselves. For owner sharing facts about HIMSELF (his hobbies, weekend, family), use note_about_person with colleague_name="${profile.user.name.split(' ')[0]}" — his own row.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            note: { type: 'string', description: 'What you learned, in plain English. Be specific — vague notes are useless later.' },
            topic: {
              type: 'string',
              enum: [...SOCIAL_TOPIC_ENUM],
              description: 'Broad enum category. Pair with a specific subject below.',
            },
            subject: {
              type: 'string',
              description: 'REQUIRED specific subject string — Maelle-identity ONLY. What facet of YOU is being taught here? Examples: "name origin", "warm direct tone", "narration style", "hebrew gender", "deflection rule", "owner override pattern", "no over-apologizing". Use 2–5 lowercased words. ❌ Do NOT use owner-personal subjects here (his hobbies, family, trips, work) — those belong on his row via note_about_person(colleague_name=<owner first name>), never on this tool.',
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
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    switch (toolName) {
      case 'note_about_person': {
        const name        = args.colleague_name as string;
        // v2.4.2 — boundary-validate slack_id (see assistant.ts log_interaction
        // comment). Without this, note_about_person silently creates an
        // orphan people_memory + social_topics row keyed on a hallucinated slug.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveSlackId } = require('../utils/resolveSlackId') as typeof import('../utils/resolveSlackId');
        const idRes = resolveSlackId(args.colleague_slack_id as string | undefined, name);
        if (idRes.was_hallucinated) {
          logger.warn('note_about_person — colleague_slack_id hallucinated', {
            rejected: idRes.rejected_input, colleagueName: name, resolvedTo: idRes.slack_id ?? null,
          });
        }
        if (!idRes.slack_id) {
          return { error: 'unknown_colleague', message: `No slack_id resolved for "${name}". Call find_slack_user first.` };
        }
        const slackId     = idRes.slack_id;
        const note        = args.note as string;
        const topic       = args.topic as string;
        const subject     = (args.subject as string | undefined)?.trim() || undefined;
        const initiatedBy = (args.initiated_by as 'maelle' | 'person' | undefined) ?? 'maelle';

        upsertPersonMemory({ slackId, name });
        appendPersonNote(slackId, note);
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });
        recordSocialMoment(slackId, initiatedBy);

        logger.info('Social note saved', { slackId, name, topic, subject, initiatedBy });
        return { saved: true, name, topic, subject };
      }

      case 'note_about_self': {
        // v2.9.4 (#105) — REPURPOSED. Owner direction: "note about self"
        // means a fact about MAELLE herself, not about the owner.
        //
        // Owner-path → writes to SELF:<ownerSlackId> (Maelle's own people_memory
        //   row). The ABOUT YOU block reads from this row and renders in
        //   both owner and colleague prompts, so the saved fact becomes
        //   visible in every conversation Maelle has. This is the only path
        //   that fixes #105 (Maelle didn't know her own name origin because
        //   the SELF row stayed empty).
        // Colleague-path → unchanged from v2.5.2. Writes to the colleague's
        //   OWN row. A colleague saving "skiing in Italy" about themselves is
        //   still the right behavior — only the owner-path semantics shift.
        //   Colleagues cannot teach Maelle facts about herself.
        //
        // For the OWNER's own hobbies / weekend / family / etc. (what the
        // v2.5.2 owner-path used to capture here), use note_about_person
        // with colleague_name="<owner first name>" — his own row resolves
        // via people_memory name search.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getPersonMemory } = require('../db') as typeof import('../db');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { selfSlackId } = require('../core/assistantSelf') as typeof import('../core/assistantSelf');
        let slackId: string;
        let name: string;
        if (context.senderRole === 'owner') {
          slackId = selfSlackId(context.profile.user.slack_user_id);
          name    = context.profile.assistant.name;
        } else {
          slackId = context.userId;
          const row = getPersonMemory(slackId);
          name = row?.name ?? slackId;  // fall back to slack id if no row yet
        }
        const note        = args.note as string;
        const topic       = args.topic as string;
        const subject     = (args.subject as string | undefined)?.trim() || undefined;
        const initiatedBy = (args.initiated_by as 'maelle' | 'person' | undefined) ?? 'person';

        // Seed identity fields when creating the SELF row for the first
        // time. For colleague-self path: don't clobber an existing row
        // with bare seed.
        if (context.senderRole === 'owner') {
          upsertPersonMemory({
            slackId,
            name,
            email:    context.profile.assistant.email,
            timezone: context.profile.user.timezone,
          });
        } else {
          upsertPersonMemory({ slackId, name });
        }
        appendPersonNote(slackId, note);
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });
        recordSocialMoment(slackId, initiatedBy);

        logger.info('Self-note saved', {
          slackId,
          scope: context.senderRole === 'owner' ? 'assistant-self' : 'colleague-self',
          topic, subject, initiatedBy,
        });
        return {
          saved: true,
          scope: context.senderRole === 'owner' ? 'assistant-self' : 'colleague-self',
          topic, subject,
        };
      }
    }

    return null;
  }

  getSystemPromptSection(profile: UserProfile): string {
    const ownerFirst = profile.user.name.split(' ')[0];
    return `
PERSONA — friend-of-the-team layer (this skill is on)

Beyond the EA work, you're a teammate. ${ownerFirst} and the people he works with should feel comfortable talking about life with you — what someone's playing on the weekend, how the kids are, how a vacation went. The Social Engine tracks topics across conversations so you can revisit them naturally instead of asking the same thing twice.

When ${ownerFirst} shares something personal: react in text like a colleague would AND save via note_about_self. The save is bookkeeping — it never replaces your reply. Same for colleagues: react in text, save via note_about_person.

You don't have to FORCE social on every turn — task always wins. But when there's room, take it. The Social Engine's directive (injected separately when relevant) tells you the mode for the current turn (celebrate / engage / continue / raise_new) — follow it; don't pivot to "anything work-related" if the directive says continue.
`.trim();
  }
}
