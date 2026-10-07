import { loadAllProfiles, type UserProfile } from '../config/userProfile';
import { readKeyedPreferences, writeKeyedPreference, forgetKeyedPreference, isPrefSkill, type LocatedKeyedPreference, type PrefSkill } from '../utils/skillPreferences';

// Owner instructions have one durable home: the existing skill markdown files.
export type UserPreference = LocatedKeyedPreference;

function ownerProfile(userId: string): UserProfile {
  const profiles = [...loadAllProfiles().values()];
  const matches = profiles.filter(p => p.user.slack_user_id === userId);
  if (matches.length !== 1) throw new Error('preference_owner_unavailable');
  const profile = matches[0];
  const directory = profile.user.name.split(' ')[0].toLowerCase();
  if (profiles.some(p => p !== profile && p.user.name.split(' ')[0].toLowerCase() === directory)) throw new Error('preference_owner_path_conflict');
  return profile;
}

/** Existing keys retain their reviewed destination; unknown new categories fail. */
export function preferenceSkill(category: string): PrefSkill | undefined {
  if (category === 'scheduling') return 'meetings';
  if (category === 'communication') return 'general';
  if (category.startsWith('summary_type_') && category.length > 'summary_type_'.length) return 'summary';
  return isPrefSkill(category) ? category : undefined;
}

export async function savePreference(params: {
  userId: string; category: string; key: string; value: string; source?: string;
}): Promise<void> {
  const profile = ownerProfile(params.userId);
  const current = readKeyedPreferences(profile);
  if (!current.ok) throw new Error(current.error);
  const skill = current.entries.find(p => p.key === params.key)?.skill ?? preferenceSkill(params.category);
  if (!skill) throw new Error('preference_category_destination_required');
  const result = await writeKeyedPreference(profile, skill, {
    key: params.key, category: params.category, value: params.value,
    source: params.source ?? 'user_taught',
    condition: params.category.startsWith('summary_type_') ? { summaryType: params.category.slice('summary_type_'.length) } : null,
  }, { expectedRevision: current.revision });
  if (!result.ok) throw new Error(result.error);
}

export function getPreferences(userId: string): UserPreference[] {
  const result = readKeyedPreferences(ownerProfile(userId));
  if (!result.ok) throw new Error(result.error);
  return result.entries;
}

export async function deletePreference(userId: string, key: string): Promise<boolean> {
  const profile = ownerProfile(userId);
  const current = readKeyedPreferences(profile);
  if (!current.ok) throw new Error(current.error);
  const exists = current.entries.some(p => p.key === key);
  const result = await forgetKeyedPreference(profile, key, { expectedRevision: current.revision });
  if (!result.ok) throw new Error(result.error);
  return exists;
}

export function formatPreferencesCatalog(userId: string): string {
  const prefs = getPreferences(userId);
  if (!prefs.length) return '';
  const categories = [...new Set(prefs.map(p => p.category))].sort();
  return [
    `PREFERENCES INDEX (${prefs.length} entries — call manage_preference(action='recall', category=...) or manage_preference(action='recall', key=...) to load full text):`,
    ...categories.map(category => {
      const keys = prefs.filter(p => p.category === category).map(p => p.key).sort();
      return `${category.toUpperCase()} (${keys.length}): ${keys.join(', ')}`;
    }),
  ].join('\n');
}

export function getPreferencesFiltered(userId: string, filter: { category?: string; key?: string } = {}): UserPreference[] {
  return getPreferences(userId).filter(p => filter.key ? p.key === filter.key : !filter.category || p.category === filter.category);
}
