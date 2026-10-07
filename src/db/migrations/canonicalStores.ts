import type Database from 'better-sqlite3';
import type { UserProfile } from '../../config/userProfile';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { materializeLegacyWorkingHours } from '../../utils/workingHoursDefault';
import { PREF_SKILLS, isPrefSkill, readKeyedPreferences, writeKeyedPreference, type KeyedPreference, type PrefSkill } from '../../utils/skillPreferences';

interface PersonRow { person_id: string; timezone: string | null; profile_json: string | null; working_hours_auto: string | null }
interface PreferenceRow { id: string; user_id: string; category: string; key: string; value: string; source: string; created_at: string; updated_at: string }
interface OwnerPlan {
  ownerId: string; directory: string; sourceHash: string; canonicalRevision: string;
  rows: { key: string; sourceHash: string; destination: PrefSkill | 'routine'; proseReviewed: true; routineHash?: string }[];
}
/** A reviewed plan contains hashes and explicit destinations, never exported values.
 * Install only after owner mapping approval and independent migration review. */
export interface CanonicalStoresPlan { version: 1; hoursHash: string; owners: OwnerPlan[] }
interface Backup {
  plan: CanonicalStoresPlan; people: PersonRow[]; targets: PersonRow[]; preferences: PreferenceRow[];
  files: { file: string; text: string | null }[]; overridesHash: string;
}
export const canonicalMigrationHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value,
  (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v) ?? '<undefined>').digest('hex');
function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function people(db: Database.Database): PersonRow[] {
  return db.prepare('SELECT person_id,timezone,profile_json,working_hours_auto FROM people_memory ORDER BY person_id').all() as PersonRow[];
}
function preferences(db: Database.Database): PreferenceRow[] {
  return tableExists(db, 'user_preferences') ? db.prepare('SELECT * FROM user_preferences ORDER BY user_id,key').all() as PreferenceRow[] : [];
}
function overridesHash(db: Database.Database): string {
  return canonicalMigrationHash(tableExists(db, 'owner_schedule_overrides') ? db.prepare('SELECT * FROM owner_schedule_overrides ORDER BY owner_slack_id,date').all() : []);
}
function parsedProfile(row: PersonRow): Record<string, unknown> {
  const value = JSON.parse(row.profile_json ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration_malformed_profile');
  return value;
}
function targetPerson(row: PersonRow): PersonRow {
  const profile = parsedProfile(row);
  const week = materializeLegacyWorkingHours(profile.working_hours_structured,
    row.working_hours_auto === null ? undefined : JSON.parse(row.working_hours_auto), row.timezone);
  if (week === null) return { ...row, working_hours_auto: null };
  if (canonicalMigrationHash(profile.working_hours_structured) === canonicalMigrationHash(week) && row.working_hours_auto === null) return row;
  return { ...row, profile_json: JSON.stringify({ ...profile, working_hours_structured: week }), working_hours_auto: null };
}
function ownerProfile(profiles: UserProfile[], owner: OwnerPlan): UserProfile {
  const matches = profiles.filter(p => p.user.slack_user_id === owner.ownerId);
  if (matches.length !== 1) throw new Error('migration_owner_identity_conflict');
  const name = matches[0].user.name.split(' ')[0].toLowerCase();
  if (profiles.filter(p => p.user.name.split(' ')[0].toLowerCase() === name).length !== 1) throw new Error('migration_owner_alias_conflict');
  const directory = path.resolve('config', 'users', `${name}_prefs`);
  if (directory !== path.resolve(owner.directory)) throw new Error('migration_owner_directory_conflict');
  return matches[0];
}
function entry(row: PreferenceRow): KeyedPreference {
  if (![row.key,row.category,row.source,row.value].every(v => typeof v === 'string' && v.length > 0)) throw new Error('migration_malformed_preference');
  return { key: row.key, category: row.category, source: row.source, value: row.value,
    condition: row.category.startsWith('summary_type_') ? { summaryType: row.category.slice('summary_type_'.length) } : null };
}
function routine(db: Database.Database, row: PreferenceRow, mapping: OwnerPlan['rows'][number]): void {
  const value = db.prepare('SELECT * FROM routines WHERE id=? AND owner_user_id=? AND is_system=1 AND prompt=?')
    .get(`system_briefing_${row.user_id}`, row.user_id, '__system_briefing__') as { schedule_time: string } | undefined;
  if (row.key !== 'briefing_time' || !value || canonicalMigrationHash(value) !== mapping.routineHash || value.schedule_time !== row.value) {
    throw new Error('migration_briefing_routine_comparison_required');
  }
}
function durableDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  durableDirectory(path.dirname(file));
}
function saveBackup(file: string, value: Backup): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  durableDirectory(path.dirname(file));
}
function fileState(file: string): string | null { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
function checkSource(db: Database.Database, backup: Backup): void {
  const current = people(db), prefs = preferences(db);
  const before = canonicalMigrationHash(current) === canonicalMigrationHash(backup.people)
    && canonicalMigrationHash(prefs) === canonicalMigrationHash(backup.preferences);
  const after = canonicalMigrationHash(current) === canonicalMigrationHash(backup.targets) && prefs.length === 0;
  if (!before && !after) throw new Error('migration_source_revision_conflict');
  if (overridesHash(db) !== backup.overridesHash) throw new Error('migration_dated_override_revision_conflict');
}
/** An interrupted import may append only the exact reviewed keyed blocks.
 * Original file bytes must remain an unchanged prefix, including unique prose.
 * Existing keys are never updated by importOnly, so no legitimate retry needs
 * to rewrite that prefix. No unexpected new key or prose is accepted on retry. */
function checkReplayFiles(backup: Backup): void {
  for (const prior of backup.files) {
    const current = fileState(prior.file);
    if (current === prior.text) continue;
    if (current === null || !current.startsWith(prior.text ?? '')) throw new Error('migration_destination_revision_conflict');
    let suffix = current.slice((prior.text ?? '').length);
    const seen = new Set<string>();
    while (suffix.trim()) {
      const block = /^\s*```maelle-preference-v1\r?\n([^\r\n]+)\r?\n```(?:\r?\n)?/.exec(suffix);
      if (!block) throw new Error('migration_destination_revision_conflict');
      const value = JSON.parse(block[1]) as KeyedPreference;
      const owner = backup.plan.owners.find(o => path.resolve(o.directory) === path.dirname(prior.file));
      const row = backup.preferences.find(r => r.user_id === owner?.ownerId && r.key === value.key);
      const mapping = owner?.rows.find(r => r.key === value.key);
      if (!row || !mapping || `${mapping.destination}.md` !== path.basename(prior.file)
        || seen.has(value.key) || canonicalMigrationHash(value) !== canonicalMigrationHash(entry(row))) throw new Error('migration_destination_revision_conflict');
      seen.add(value.key); suffix = suffix.slice(block[0].length);
    }
  }
}
function validateBackup(backup: Backup, plan: CanonicalStoresPlan): void {
  const expectedPaths = plan.owners.flatMap(o => PREF_SKILLS.map(s => path.resolve(o.directory, `${s}.md`))).sort();
  if (canonicalMigrationHash(backup.plan) !== canonicalMigrationHash(plan)
    || canonicalMigrationHash(backup.people) !== plan.hoursHash
    || canonicalMigrationHash(backup.people.map(targetPerson)) !== canonicalMigrationHash(backup.targets)
    || canonicalMigrationHash(backup.files.map(f => f.file).sort()) !== canonicalMigrationHash(expectedPaths)) throw new Error('migration_backup_integrity_conflict');
  for (const owner of plan.owners) {
    const rows = backup.preferences.filter(r => r.user_id === owner.ownerId);
    // The canonical API's owner-wide revision is the hash of these exact
    // allowlisted per-file existence/content revisions; bind backup bytes to
    // the reviewed revision instead of trusting a replay journal's file text.
    const revision = createHash('sha256').update(PREF_SKILLS.map(skill => {
      const file = backup.files.find(f => f.file === path.resolve(owner.directory, `${skill}.md`))!;
      return `${skill}:${file.text !== null}:${createHash('sha256').update(file.text ?? '').digest('hex')}`;
    }).join('\n')).digest('hex');
    if (revision !== owner.canonicalRevision) throw new Error('migration_backup_file_revision_conflict');
    if (canonicalMigrationHash(rows) !== owner.sourceHash || rows.length !== owner.rows.length
      || rows.some(row => owner.rows.find(r => r.key === row.key)?.sourceHash !== canonicalMigrationHash(row))) throw new Error('migration_backup_integrity_conflict');
  }
}
function fullTransaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) throw new Error('migration_nested_transaction');
  const previous = db.pragma('synchronous', { simple: true }) as number;
  try { db.pragma('synchronous=FULL'); return db.transaction(fn).immediate(); }
  finally { db.pragma(`synchronous=${previous}`); }
}

/** Read-only activation guard. New runtime cannot ignore legacy state or start
 * channels while a failed/partial migration still needs attention. */
export function assertCanonicalStoresReady(db: Database.Database): void {
  if (preferences(db).length) throw new Error('canonical_preference_migration_required');
  for (const row of people(db)) {
    if (canonicalMigrationHash(row) !== canonicalMigrationHash(targetPerson(row))) throw new Error('canonical_week_migration_required');
  }
}

/** Offline/startup only: channels must not yet be started. File imports are
 * restartable and source rows remain until all durable target equalities pass.
 * The immutable private backup is the replay journal; it is never overwritten. */
export async function migrateCanonicalStores(db: Database.Database, profiles: UserProfile[], plan: CanonicalStoresPlan, backupFile: string, dryRun = false): Promise<void> {
  if (fs.existsSync(`${backupFile}.reversing`)) throw new Error('migration_reversal_in_progress');
  if (plan.version !== 1 || new Set(plan.owners.map(o => o.ownerId)).size !== plan.owners.length) throw new Error('migration_invalid_plan');
  let backup: Backup;
  if (fs.existsSync(backupFile)) {
    backup = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as Backup;
    validateBackup(backup, plan);
    if (!dryRun) durableFile(backupFile);
  } else {
    const sourcePeople = people(db), sourcePreferences = preferences(db);
    if (canonicalMigrationHash(sourcePeople) !== plan.hoursHash) throw new Error('migration_hours_revision_conflict');
    if (sourcePreferences.some(r => !plan.owners.some(o => o.ownerId === r.user_id))) throw new Error('migration_unmapped_owner');
    const files: Backup['files'] = [];
    for (const owner of plan.owners) {
      const profile = ownerProfile(profiles, owner), rows = sourcePreferences.filter(r => r.user_id === owner.ownerId);
      if (canonicalMigrationHash(rows) !== owner.sourceHash || new Set(owner.rows.map(r => r.key)).size !== owner.rows.length || rows.length !== owner.rows.length) throw new Error('migration_source_revision_conflict');
      const current = readKeyedPreferences(profile);
      if (!current.ok || current.revision !== owner.canonicalRevision) throw new Error('migration_canonical_revision_conflict');
      for (const row of rows) {
        const mapping = owner.rows.find(r => r.key === row.key);
        if (!mapping || mapping.sourceHash !== canonicalMigrationHash(row) || mapping.proseReviewed !== true) throw new Error('migration_key_mapping_required');
        entry(row);
        if (mapping.destination === 'routine') routine(db, row, mapping);
        else {
          if (row.key === 'briefing_time' || !isPrefSkill(mapping.destination)) throw new Error('migration_invalid_destination');
          const existing = current.entries.find(e => e.key === row.key);
          if (existing && canonicalMigrationHash(existing) !== canonicalMigrationHash({ ...entry(row), skill: mapping.destination })) throw new Error('migration_key_conflict');
          for (const skill of PREF_SKILLS) {
            const file = path.join(owner.directory, `${skill}.md`);
            const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            // This regex parses a structured fenced JSON marker, not natural language.
            const prose = text.replace(/```maelle-preference-v1\r?\n[\s\S]*?\r?\n```/g, '');
            if (prose.includes(row.value)) throw new Error('migration_unmarked_prose_conflict');
          }
        }
      }
      for (const skill of PREF_SKILLS) {
        const file = path.resolve(owner.directory, `${skill}.md`);
        files.push({ file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
      }
    }
    backup = { plan, people: sourcePeople, targets: sourcePeople.map(targetPerson), preferences: sourcePreferences, files, overridesHash: overridesHash(db) };
    if (!dryRun) saveBackup(backupFile, backup);
  }
  validateBackup(backup, plan);
  checkSource(db, backup);
  checkReplayFiles(backup);
  if (dryRun) return;
  // Identity must still agree on retry, including after a file-only partial import.
  for (const owner of plan.owners) {
    const profile = ownerProfile(profiles, owner);
    for (const row of backup.preferences.filter(r => r.user_id === owner.ownerId)) {
      checkSource(db, backup);
      checkReplayFiles(backup);
      const mapping = owner.rows.find(r => r.key === row.key)!;
      if (mapping.destination === 'routine') { routine(db, row, mapping); continue; }
      const current = readKeyedPreferences(profile);
      if (!current.ok) throw new Error(current.error);
      const result = await writeKeyedPreference(profile, mapping.destination, entry(row), { expectedRevision: current.revision, importOnly: true });
      if (!result.ok) throw new Error(result.error);
      durableFile(path.resolve(owner.directory, `${mapping.destination}.md`));
      durableDirectory(path.dirname(path.resolve(owner.directory)));
    }
  }
  const postimagesFile = `${backupFile}.postimages`;
  const postimages = backup.files.map(f => ({ file: f.file, text: fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : null }));
  if (fs.existsSync(postimagesFile)) {
    if (canonicalMigrationHash(JSON.parse(fs.readFileSync(postimagesFile, 'utf8'))) !== canonicalMigrationHash(postimages)) throw new Error('migration_postimage_conflict');
    durableFile(postimagesFile);
  } else {
    const fd = fs.openSync(postimagesFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(postimages)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    durableDirectory(path.dirname(postimagesFile));
  }
  fullTransaction(db, () => {
    checkSource(db, backup);
    checkReplayFiles(backup);
    const currentPeople = people(db);
    for (const owner of plan.owners) {
      const current = readKeyedPreferences(ownerProfile(profiles, owner));
      if (!current.ok) throw new Error(current.error);
      for (const row of backup.preferences.filter(r => r.user_id === owner.ownerId)) {
        const mapping = owner.rows.find(r => r.key === row.key)!;
        if (mapping.destination === 'routine') routine(db, row, mapping);
        else if (canonicalMigrationHash(current.entries.find(e => e.key === row.key)) !== canonicalMigrationHash({ ...entry(row), skill: mapping.destination })) throw new Error('migration_durable_equality_failed');
      }
    }
    const update = db.prepare('UPDATE people_memory SET profile_json=?,working_hours_auto=? WHERE person_id=? AND timezone IS ? AND profile_json IS ? AND working_hours_auto IS ?');
    for (let i = 0; i < backup.people.length; i++) {
      const from = backup.people[i], to = backup.targets[i];
      if (canonicalMigrationHash(currentPeople[i]) === canonicalMigrationHash(to)) continue;
      if (update.run(to.profile_json, to.working_hours_auto, from.person_id, from.timezone, from.profile_json, from.working_hours_auto).changes !== 1) throw new Error('migration_person_cas_failed');
    }
    if (canonicalMigrationHash(people(db)) !== canonicalMigrationHash(backup.targets)) throw new Error('migration_week_equality_failed');
    if (tableExists(db, 'user_preferences')) db.prepare('DELETE FROM user_preferences').run();
    assertCanonicalStoresReady(db);
  });
}

/** A missing or failed reviewed plan is fatal before any transport activates.
 * No implicit import, fallback reader, or source deletion happens without it. */
export async function activateCanonicalStores(db: Database.Database, profiles: UserProfile[], stateDirectory: string): Promise<void> {
  if (fs.existsSync(path.join(stateDirectory, 'canonical-stores-backup.json.reversing'))) throw new Error('migration_reversal_in_progress');
  try { assertCanonicalStoresReady(db); return; } catch { /* inspected again by the exact reviewed migration */ }
  const planFile = path.join(stateDirectory, 'canonical-stores-plan.json');
  if (!fs.existsSync(planFile)) throw new Error('canonical_migration_reviewed_plan_required');
  await migrateCanonicalStores(db, profiles, JSON.parse(fs.readFileSync(planFile, 'utf8')), path.join(stateDirectory, 'canonical-stores-backup.json'));
  assertCanonicalStoresReady(db);
}

/** Offline reversal only. Requires the complete durable postimage, refuses
 * newer edits, and restores DB sources before files. The durable marker keeps
 * new-runtime activation blocked across any partial reversal or restart. A
 * reviewed operator can then restart the old binary with its original data.
 * If import stopped before postimages, first safely resume it; never guess. */
export function reverseCanonicalStores(db: Database.Database, profiles: UserProfile[], backupFile: string): void {
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as Backup;
  validateBackup(backup, backup.plan);
  for (const owner of backup.plan.owners) ownerProfile(profiles, owner);
  const postimages = JSON.parse(fs.readFileSync(`${backupFile}.postimages`, 'utf8')) as Backup['files'];
  if (canonicalMigrationHash(postimages.map(f => f.file).sort()) !== canonicalMigrationHash(backup.files.map(f => f.file).sort())) throw new Error('migration_postimage_conflict');
  checkSource(db, backup);
  for (const prior of backup.files) {
    const current = fileState(prior.file), after = postimages.find(f => f.file === prior.file)!;
    if (current !== prior.text && current !== after.text) throw new Error('migration_reversal_newer_file');
  }
  const marker = `${backupFile}.reversing`;
  if (!fs.existsSync(marker)) {
    const fd = fs.openSync(marker, 'wx', 0o600);
    try { fs.writeFileSync(fd, canonicalMigrationHash(backup.plan)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  durableFile(marker);
  fullTransaction(db, () => {
    checkSource(db, backup);
    for (const row of backup.people) db.prepare('UPDATE people_memory SET profile_json=?,working_hours_auto=? WHERE person_id=?')
      .run(row.profile_json, row.working_hours_auto, row.person_id);
    if (backup.preferences.length) {
      if (!tableExists(db, 'user_preferences')) throw new Error('migration_reversal_source_table_missing');
      const insert = db.prepare(`INSERT OR IGNORE INTO user_preferences(id,user_id,category,key,value,source,created_at,updated_at)
        VALUES(@id,@user_id,@category,@key,@value,@source,@created_at,@updated_at)`);
      for (const row of backup.preferences) insert.run(row);
    }
    if (canonicalMigrationHash(people(db)) !== canonicalMigrationHash(backup.people)
      || canonicalMigrationHash(preferences(db)) !== canonicalMigrationHash(backup.preferences)) throw new Error('migration_reversal_equality_failed');
  });
  for (const prior of backup.files) {
    if (fileState(prior.file) === prior.text) continue;
    if (prior.text === null) fs.unlinkSync(prior.file);
    else {
      const temp = `${prior.file}.migration-restore`;
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, prior.text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, prior.file);
    }
    durableDirectory(path.dirname(prior.file));
  }
}
