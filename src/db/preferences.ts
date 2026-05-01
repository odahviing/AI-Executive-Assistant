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
 * Compact catalog of what the user has taught — category + key list per row,
 * full text fetched on demand via recall_preferences(category|key). Mirrors
 * the v2.2.1 people-memory pattern: cheap injection, on-demand loading. Closes
 * the v2.3.8-era prompt bloat where 110 prefs (~7,600 tokens) shipped to every
 * turn even though most weren't relevant.
 *
 * Returns empty string when no preferences exist (so the prompt block is
 * skipped entirely on a fresh profile).
 */
export function formatPreferencesCatalog(userId: string): string {
  const prefs = getPreferences(userId);
  if (prefs.length === 0) return '';

  const byCategory = new Map<string, string[]>();
  for (const p of prefs) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(p.key);
  }
  // Stable ordering — categories alphabetical, keys alphabetical within each.
  const categories = [...byCategory.keys()].sort();
  const lines = categories.map(cat => {
    const keys = byCategory.get(cat)!.sort();
    return `${cat.toUpperCase()} (${keys.length}): ${keys.join(', ')}`;
  });

  return [
    `PREFERENCES INDEX (${prefs.length} entries — call recall_preferences(category=...) or recall_preferences(key=...) to load full text):`,
    ...lines,
  ].join('\n');
}

/**
 * Filtered fetch for the recall_preferences tool. Returns all prefs when both
 * args omitted (back-compat with v1.x callers). category filter narrows by
 * category; key filter returns at most one row by exact key match.
 */
export function getPreferencesFiltered(
  userId: string,
  filter: { category?: string; key?: string } = {},
): UserPreference[] {
  const db = getDb();
  if (filter.key) {
    return db.prepare(
      `SELECT * FROM user_preferences WHERE user_id = ? AND key = ?`,
    ).all(userId, filter.key) as UserPreference[];
  }
  if (filter.category) {
    return db.prepare(
      `SELECT * FROM user_preferences WHERE user_id = ? AND category = ? ORDER BY key`,
    ).all(userId, filter.category) as UserPreference[];
  }
  return getPreferences(userId);
}
