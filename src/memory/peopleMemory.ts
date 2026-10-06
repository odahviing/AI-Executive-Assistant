/** Canonical person memory views. Durable content lives only in people_memory.
 * Legacy markdown must be reconciled with scripts/reconcile-person-memory.cjs
 * before deployment; it is never a second live fact writer or reader. */
import type { UserProfile } from '../config/userProfile';
import type { PersonMemory, PersonProfile, PersonNote } from '../db/people';
import { readdirSync, existsSync } from 'fs';
import path from 'path';

export type PersonMemoryAudience = { kind: 'owner' } | { kind: 'self'; senderId: string };
const MAX_CONTEXT = 32 * 1024;

/** A merge cannot discard an unreconciled legacy file. After migration there
 * are no files to fold: row notes/history merge through the existing DB rule. */
export function mergePersonMdFiles(survivorId: string, loserId: string, _survivorName?: string): boolean {
  if (!survivorId || !loserId || survivorId === loserId || /[\\/\0]|\.\./.test(survivorId + loserId)) return false;
  const root = path.resolve(process.cwd(), 'config/users');
  try {
    return readdirSync(root).filter(n => n.endsWith('_people')).every(n =>
      !existsSync(path.join(root, n, `${loserId}.md`)) && !existsSync(path.join(root, n, `${survivorId}.md`)));
  } catch { return false; }
}

function render(row: PersonMemory, audience: PersonMemoryAudience): string | null {
  if (audience.kind === 'self' && (!audience.senderId || row.slack_id !== audience.senderId)) return null;
  const db = require('../db') as typeof import('../db');
  const profile = JSON.parse(row.profile_json || '{}') as PersonProfile;
  const owner = audience.kind === 'owner';
  const lines = [`# ${row.name}`, '', '## Current record'];
  if (row.timezone) lines.push(`Timezone: ${row.timezone}`);
  if (row.state) lines.push(`Location: ${row.state}`);
  const { describeEffectiveWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
  const hours = describeEffectiveWorkingHours(row);
  if (hours) lines.push(`Scheduling hours: ${JSON.stringify(hours)}`);
  const travel = db.getTravelRecordById(row.person_id);
  if (travel) lines.push(`Travel recorded: ${travel.location}, ${travel.from} through ${travel.until} (inclusive).`);
  for (const key of ['communication_style', 'response_speed', 'role_summary', 'reports_to', 'collaboration_notes'] as const) {
    const provenance = profile._set_by?.[key];
    if (profile[key] && (owner || provenance === 'person' || provenance === 'auto')) lines.push(`${key}: ${profile[key]}`);
  }
  const notes = JSON.parse(row.notes || '[]') as PersonNote[];
  const visibleNotes = notes.filter(n => owner || n.set_by === 'person');
  if (visibleNotes.length) lines.push('', '## Notes', ...visibleNotes.map(n => `- [${n.date || 'date unknown'}] ${n.note}`));
  const history = db.readInteractionLog(row.interaction_log);
  const visibleHistory = owner ? history.relational : history.relational.filter(i => !['social_chat', 'social_ping'].includes(i.type));
  if (visibleHistory.length) lines.push('', '## History', ...visibleHistory.slice(-30).map(i => `- [${i.date}] ${i.summary}`));
  if (history.recentBookings.length) lines.push('', `## Recent booking snapshots (${db.BOOKING_SNAPSHOT_FRAME})`, ...history.recentBookings.slice(-8).map(i => `- [${i.date}] ${i.summary}`));
  const content = lines.join('\n');
  return content.length <= MAX_CONTEXT ? content : `${content.slice(0, MAX_CONTEXT / 2)}\n[Middle omitted from this view; retained in the canonical record.]\n${content.slice(-MAX_CONTEXT / 2)}`;
}

/** Caller must supply authenticated audience. Missing audience returns no data. */
export function readPersonMemorySync(_profile: UserProfile, personId: string, _legacyName?: string, audience?: PersonMemoryAudience): string | null {
  if (!audience) return null;
  const { getPersonById } = require('../db') as typeof import('../db');
  const row = getPersonById(personId);
  return row ? render(row, audience) : null;
}

export async function readPersonMemory(profile: UserProfile, personId: string, legacyName?: string, audience?: PersonMemoryAudience): Promise<string | null> {
  return readPersonMemorySync(profile, personId, legacyName, audience);
}

/** Owner-only catalog: identities come from the canonical store, never files. */
export function formatPeopleCatalogSync(_profile: UserProfile): string {
  const { getDb } = require('../db/client') as typeof import('../db/client');
  const rows = getDb().prepare('SELECT person_id,name FROM people_memory ORDER BY name,person_id').all() as Array<{person_id: string; name: string}>;
  if (!rows.length) return '';
  return ['PEOPLE MEMORY (canonical person records; use get_person_memory with the person ID):', ...rows.map(r => `- ${r.name} [${r.person_id}]`)].join('\n');
}
