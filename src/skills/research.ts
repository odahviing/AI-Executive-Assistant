import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';

/**
 * Research Skill — owner only.
 * Enables multi-step research, content creation, article summarization,
 * meeting prep, and sending work for internal/external review.
 *
 * Does not expose its own tools — it uses web_search from the Search skill
 * but removes the single-search limit and adds full content-creation guidance.
 *
 * Future: can be pointed at a different model (e.g. claude-opus for deep research).
 */
export class ResearchSkill implements Skill {
  id = 'research' as const;
  name = 'Research';
  description = 'Multi-step research, content creation, article summarization, and sending work for review.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    // No tools of its own — relies on web_search from the Search skill.
    return [];
  }

  async executeToolCall(
    _toolName: string,
    _args: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<null> {
    return null;
  }

  getSystemPromptSection(profile: UserProfile): string {
    const firstName = profile.user.name.split(' ')[0];
    return `
RESEARCH & CONTENT
${firstName} can ask you to do real research tasks — this is NOT a limit zone, it's a core capability.

RESEARCH WORKFLOW
When asked to research a topic, company, article, or URL:
1. Use web_search as many times as needed — no limit. 2–5 searches for a typical topic is normal.
2. If given a specific URL: use web_extract to read the page content directly. If extraction fails, fall back to web_search about the topic.
3. If given a company name or page: use web_extract on the URL, then web_search for their recent news and the specific topic mentioned.
4. Synthesize what you find — don't just dump search results. Form an actual view.
5. Present findings conversationally: key insight first, supporting detail after. No academic format.

CONTENT CREATION
You can write anything ${firstName} asks for:
- LinkedIn posts, blog articles, internal memos
- Meeting summaries and follow-ups
- Email drafts, message drafts
- Briefing docs, talking points, summaries of articles

When writing: match the voice ${firstName} is going for. Ask once if unclear, then write. Don't over-explain the structure — just produce the content.

TOPIC SELECTION (e.g. LinkedIn)
If asked to suggest topics: do 2–3 searches, pick the most timely/relevant angle, present 2–3 options briefly. Once approved, write the full piece — don't ask again.

SENDING FOR REVIEW
After creating content, offer to send it to a specific person for feedback using message_colleague.
- "Want me to send this to Oran for a quick review?"
- If they say yes: send it with a short note explaining what you're asking for
- When the person replies with feedback, report it back and offer to revise

READING ARTICLES
If ${firstName} shares a link or article title: search for it, summarize the key points (3–5 sentences), then ask if they want to share or do anything with it.

MEETING PREP
Before a meeting: search for background on the attendees or topic, pull any relevant recent news, draft a brief agenda or talking points if asked.
`.trim();
  }
}
