// Bounded legacy-file reconciliation. Explicit reviewed identities only, no NLP
// matching and no runtime fallback. Caller provides a consistent backup first.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function personFiles(app) {
  const users = path.join(app, 'config/users');
  return fs.readdirSync(users).filter(n => n.endsWith('_people')).flatMap(dir =>
    fs.readdirSync(path.join(users, dir)).filter(n => n.endsWith('.md') && n !== 'README.md').map(n => `config/users/${dir}/${n}`)).sort();
}
function loadSource(app, entry) {
  const full = path.resolve(app, entry.path);
  const root = path.resolve(app, 'config/users') + path.sep;
  if (!full.startsWith(root) || !entry.path.endsWith('.md')) throw new Error('source path escapes user configuration');
  const bytes = fs.readFileSync(full);
  if (hash(bytes) !== entry.sha256) throw new Error(`source changed: ${entry.path}`);
  return bytes.toString('utf8');
}
function additions(row, entry, source) {
  const history = JSON.parse(row.interaction_log || '[]');
  const existing = JSON.parse(row.notes || '[]');
  const prefix = `Historical memory from ${entry.path} (sha256 ${entry.sha256}; author unknown; not a current scheduling instruction)`;
  // Parse Markdown syntax and ISO dates only. Do not classify natural language.
  const notes = [];
  let title = 'Original heading';
  for (const [index, line] of source.split('\n').entries()) {
      if (/^##\s+/.test(line)) title = line.replace(/^##\s+/, '').trim();
      const dated = /^- \[(\d{4}-\d{2}-\d{2})\] (.*)$/.exec(line);
      if (dated && title === "What we've discussed" && history.some(i => i.date.slice(0, 10) === dated[1] && i.summary === dated[2])) continue;
      // Unknown date stays unknown. Preserve each original line verbatim,
      // including embedded dates; never stamp migration time as event time.
      // The line number preserves repeated identical lines and whitespace;
      // headings and blank lines are evidence too, never silently discarded.
      const note = { date: dated?.[1] || '', note: `${prefix}; original line ${index + 1}\n${line}` };
      if (!existing.some(n => n.date === note.date && n.note === note.note) && !notes.some(n => n.date === note.date && n.note === note.note)) notes.push(note);
  }
  return notes;
}
function plan(db, app, manifest) {
  const files = personFiles(app);
  if (manifest.length !== files.length || new Set(manifest.map(e => e.path)).size !== manifest.length || files.some(f => !manifest.some(e => e.path === f))) throw new Error('manifest must cover every legacy file exactly once');
  return manifest.map(entry => {
    if (!entry.personId || !entry.identityEvidence) throw new Error(`identity unresolved: ${entry.path}`);
    const row = db.prepare('SELECT * FROM people_memory WHERE person_id=?').get(entry.personId);
    if (!row) throw new Error(`canonical person missing: ${entry.path}`);
    if (entry.rowHash !== hash(JSON.stringify(row))) {
      // A completed import may be retried after interruption, but no unrelated
      // row change is accepted under an old reviewed manifest.
      const original = entry.rowSnapshot;
      if (!original || hash(JSON.stringify(original)) !== entry.rowHash) throw new Error(`canonical row changed: ${entry.path}`);
      const expectedNotes = JSON.parse(original.notes || '[]');
      for (const sibling of manifest.filter(e => e.personId === entry.personId)) {
        for (const note of additions(original, sibling, loadSource(app, sibling))) {
          if (!expectedNotes.some(n => n.date === note.date && n.note === note.note)) expectedNotes.push(note);
        }
      }
      const expected = { ...original, notes: JSON.stringify(expectedNotes) };
      if (hash(JSON.stringify(expected)) !== hash(JSON.stringify(row))) throw new Error(`canonical row changed: ${entry.path}`);
    }
    const source = loadSource(app, entry);
    return { ...entry, notes: additions(row, entry, source) };
  });
}
function reconcile(db, app, manifest) {
  // Revalidate inside the write lock; no source row loses its dated history,
  // existing notes, authority or last_seen. Repeats deduplicate exact imports.
  return db.transaction(() => {
    const planned = plan(db, app, manifest);
    const counts = [];
    for (const entry of planned) {
      const row = db.prepare('SELECT notes FROM people_memory WHERE person_id=?').get(entry.personId);
      const notes = JSON.parse(row.notes || '[]');
      for (const note of entry.notes) if (!notes.some(n => n.date === note.date && n.note === note.note)) notes.push(note);
      db.prepare('UPDATE people_memory SET notes=? WHERE person_id=?').run(JSON.stringify(notes), entry.personId);
      counts.push({ path: entry.path, personId: entry.personId, preservedLines: entry.notes.length });
    }
    return counts;
  }).immediate();
}
// Retirement is a separate maintenance step only AFTER the committed DB has
// been re-read and every import verified. Original files are copied with exact
// hashes into the external backup before unlink; interrupted retirement is
// resumable. No source is removed on an import error.
function retire(db, app, manifest, backupDir) {
  const backup = path.resolve(backupDir);
  if (backup === path.resolve(app) || backup.startsWith(path.resolve(app) + path.sep)) throw new Error('archive must be outside app');
  for (const entry of manifest) {
    const sourcePath = path.resolve(app, entry.path);
    const archived = path.join(backup, entry.path);
    if (!fs.existsSync(sourcePath)) {
      if (!fs.existsSync(archived) || hash(fs.readFileSync(archived)) !== entry.sha256) throw new Error('missing original and archive');
      const row = db.prepare('SELECT * FROM people_memory WHERE person_id=?').get(entry.personId);
      if (!row || additions(row, entry, fs.readFileSync(archived, 'utf8')).length) throw new Error(`unverified archived import: ${entry.path}`);
      continue;
    }
    const source = loadSource(app, entry);
    const row = db.prepare('SELECT * FROM people_memory WHERE person_id=?').get(entry.personId);
    if (!row || additions(row, entry, source).length) throw new Error(`unverified import: ${entry.path}`);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    if (!fs.existsSync(archived)) fs.copyFileSync(sourcePath, archived, fs.constants.COPYFILE_EXCL);
    if (hash(fs.readFileSync(archived)) !== entry.sha256 || hash(fs.readFileSync(sourcePath)) !== entry.sha256) throw new Error('archive/source changed');
    fs.unlinkSync(sourcePath);
  }
}
module.exports = { hash, additions, plan, reconcile, retire, personFiles };
