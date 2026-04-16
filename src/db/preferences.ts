import { getDb } from './client';

// ── User preferences ─────────────────────────────────────────────────────────

export interface UserPreference {
  id: string;
  user_id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export function savePreference(params: {
  userId: string;
  category: string;
  key: string;
  value: string;
  source?: string;
}): void {
  const db = getDb();
  const id = `pref_${params.userId}_${params.key}`.replace(/[^a-zA-Z0-9_]/g, '_');
  db.prepare(`
    INSERT INTO user_preferences (id, user_id, category, key, value, source)
    VALUES (@id, @user_id, @category, @key, @value, @source)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = @value,
      category = @category,
      source = @source,
      updated_at = datetime('now')
  `).run({
    id,
    user_id: params.userId,
    category: params.category,
    key: params.key,
    value: params.value,
    source: params.source ?? 'user_taught',
  });
}

export function getPreferences(userId: string): UserPreference[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM user_preferences WHERE user_id = ? ORDER BY category, key`
  ).all(userId) as UserPreference[];
}

export function deletePreference(userId: string, key: string): boolean {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM user_preferences WHERE user_id = ? AND key = ?`
  ).run(userId, key);
  return result.changes > 0;
}

/**
 * Format preferences as a compact block for injection into the system prompt.
 * Returns empty string if no preferences exist yet.
 */
export function formatPreferencesForPrompt(userId: string): string {
  const prefs = getPreferences(userId);
  if (prefs.length === 0) return '';

  const byCategory = prefs.reduce((acc, p) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(`- ${p.value}`);
    return acc;
  }, {} as Record<string, string[]>);

  const lines = Object.entries(byCategory)
    .map(([cat, items]) => `${cat.toUpperCase()}:\n${items.join('\n')}`)
    .join('\n\n');

  return `WHAT YOU KNOW ABOUT ${userId.toUpperCase()} (learned over time):\n${lines}`;
}
