/**
 * PersonaSkill (v2.2.3, #3) — togglable social / off-topic chat layer.
 *
 * What's in this skill:
 *   - Tools: `note_about_person`, `note_about_self`
 *   - System prompt section nudging Maelle to engage as a teammate, not just
 *     a task router (gaming chat, weekend small talk, etc.)
 *
 * What's NOT here (still in CORE — runs whether persona is on or off):
 *   - Owner preferences (learn_preference / recall_preferences)
 *   - Core attendee fields (gender / timezone / state via update_person_profile)
 *   - confirm_gender, log_interaction, recall_interactions
 *   - Per-person md memory (get_person_memory / update_person_memory)
 *   - Slack auto-pull of timezone / pronouns / image
 *   - The owner / colleague identity blocks in the system prompt
 *
 * Other social machinery gated on `skills.persona` from outside this file:
 *   - Social Engine pre-pass (`src/core/social/*`) — orchestrator skips when off
 *   - Outreach tick / decay / rank-check tasks — dispatchers no-op when off
 *   - WORKSPACE CONTACTS social fields (last_social_at, topics, engagement_rank)
 *   - buildSocialContextBlock per-sender SOCIAL CONTEXT block in prompt
 *
 * Profile YAML key: `skills.persona: true | false`. Default false (Maelle is
 * task-only out of the box; opt in to the friend-of-the-team behavior).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  upsertPersonMemory,
  appendPersonNote,
  appendPersonInteraction,
  recordSocialMoment,
  type SocialTopicQuality,
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

export class PersonaSkill implements Skill {
  id = 'persona' as const;
  name = 'Persona';
  description = 'Off-topic chat, social topic tracking, proactive colleague outreach — the friend-of-the-team layer. Optional.';

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
- "Goes by Ike, not Isaac"
- "Said the board meeting last week was intense — seemed relieved it went well"
- "Has a cat named Mochi"
- "Studying for an MBA part-time"

Do NOT call this for purely work-related facts (those go in learn_preference). This is for human, personal, relationship-building context.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            colleague_slack_id: { type: 'string', description: 'Slack user ID of the person' },
            colleague_name:     { type: 'string', description: 'Display name of the person' },
            note:               { type: 'string', description: 'What you learned, in plain English. Be specific — vague notes are useless later.' },
            topic: {
              type: 'string',
              description: 'Broad enum category. Pair this with a specific subject (see below).',
              enum: [...SOCIAL_TOPIC_ENUM],
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
- After "I was building you all day" → topic="hobby", subject="building ${profile.assistant.name}", note="Spent the day developing ${profile.assistant.name} — clearly enjoying the AI/dev work."
- After "Just got back from skiing in Italy" → topic="travel", subject="ski trip italy", note="Just back from skiing in Italy — sounded relaxed."
- After "My daughter started first grade today" → topic="family", subject="daughter first grade", note="Daughter started first grade today."

Owner-only. Do NOT use this for colleagues (use note_about_person for them).`,
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
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    switch (toolName) {
      case 'note_about_person': {
        const slackId     = args.colleague_slack_id as string;
        const name        = args.colleague_name as string;
        const note        = args.note as string;
        const topic       = args.topic as string;
        const subject     = (args.subject as string | undefined)?.trim() || undefined;
        const quality     = (args.topic_quality as SocialTopicQuality | undefined) ?? 'neutral';
        const initiatedBy = (args.initiated_by as 'maelle' | 'person' | undefined) ?? 'maelle';

        upsertPersonMemory({ slackId, name });
        appendPersonNote(slackId, note);
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });
        recordSocialMoment(slackId, topic, quality, initiatedBy, subject);

        logger.info('Social note saved', { slackId, name, topic, subject, quality, initiatedBy });
        return { saved: true, name, topic, subject, quality };
      }

      case 'note_about_self': {
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

        upsertPersonMemory({
          slackId,
          name,
          email:    context.profile.user.email,
          timezone: context.profile.user.timezone,
        });
        appendPersonNote(slackId, note);
        const timelineTag = subject ? `[${topic}:${subject}]` : `[${topic}]`;
        appendPersonInteraction(slackId, {
          type: 'social_chat',
          summary: `${timelineTag} ${note}`,
        });
        recordSocialMoment(slackId, topic, quality, initiatedBy, subject);

        logger.info('Owner self-note saved', { slackId, topic, subject, quality, initiatedBy });
        return { saved: true, scope: 'owner', topic, subject, quality };
      }
    }

    return null;
  }

  getSystemPromptSection(profile: UserProfile): string {
    const ownerFirst = profile.user.name.split(' ')[0];
    return `
PERSONA — friend-of-the-team layer (this skill is on)

Beyond the EA work, you're a teammate. ${ownerFirst} and the people he works with should feel comfortable talking about life with you — what someone's playing on the weekend, how the kids are, how a vacation went. The Social Engine tracks topics across conversations so you can revisit them naturally instead of asking the same thing twice.

When ${ownerFirst} shares something personal: react like a colleague would, then save the moment via note_about_self. When a colleague shares something personal in conversation: react warmly, save via note_about_person.

You don't have to FORCE social on every turn — task always wins. But when there's room, take it. The Social Engine's directive (injected separately when relevant) tells you the mode for the current turn (celebrate / engage / continue / raise_new) — follow it; don't pivot to "anything work-related" if the directive says continue.
`.trim();
  }
}
