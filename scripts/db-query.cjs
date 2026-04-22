#!/usr/bin/env node
/**
 * Read-only SQLite query helper for Maelle.
 *
 * Opens data/maelle.db in READONLY mode (writes will throw) and runs whatever
 * you pass as args. Built so it can be safely allowlisted in
 * .claude/settings.json as `Bash(node scripts/db-query.cjs:*)` — no matter
 * what SQL or JS-ish string is passed, the DB handle is readonly so it can't
 * mutate the db.
 *
 * Usage:
 *   node scripts/db-query.cjs "<SELECT ...>"                  # rows as JSON
 *   node scripts/db-query.cjs --tables                        # list all tables
 *   node scripts/db-query.cjs --schema <table>                # PRAGMA table_info
 *   node scripts/db-query.cjs --pretty "<SELECT ...>"         # pretty JSON
 *   node scripts/db-query.cjs --limit 5 "<SELECT ...>"        # append LIMIT if missing
 *
 * Exits non-zero on error. Never writes. Rejects anything that isn't a
 * SELECT / PRAGMA / WITH ... SELECT / EXPLAIN.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');

function die(msg, code = 1) {
  process.stderr.write(`db-query: ${msg}\n`);
  process.exit(code);
}

function isReadOnlySql(sql) {
  // Strip comments + leading whitespace, then check the first keyword.
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^\s*([A-Za-z]+)/);
  if (!first) return false;
  const kw = first[1].toUpperCase();
  return kw === 'SELECT' || kw === 'PRAGMA' || kw === 'WITH' || kw === 'EXPLAIN';
}

function openDb() {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    die(`cannot open ${DB_PATH}: ${e.message}`);
  }
}

function printRows(rows, pretty) {
  if (pretty) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else {
    for (const r of rows) process.stdout.write(JSON.stringify(r) + '\n');
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(
      [
        'Usage:',
        '  node scripts/db-query.cjs "<SELECT ...>"',
        '  node scripts/db-query.cjs --tables',
        '  node scripts/db-query.cjs --schema <table>',
        '  node scripts/db-query.cjs --pretty "<SELECT ...>"',
        '  node scripts/db-query.cjs --limit N "<SELECT ...>"',
        '',
        'Read-only. Opens data/maelle.db with readonly=true.',
      ].join('\n') + '\n'
    );
    process.exit(0);
  }

  let pretty = false;
  let limit = null;
  let mode = 'sql';
  let sql = null;
  let schemaTable = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pretty') pretty = true;
    else if (a === '--limit') {
      limit = parseInt(args[++i], 10);
      if (!Number.isFinite(limit) || limit <= 0) die('--limit needs a positive integer');
    } else if (a === '--tables') {
      mode = 'tables';
    } else if (a === '--schema') {
      mode = 'schema';
      schemaTable = args[++i];
      if (!schemaTable) die('--schema needs a table name');
    } else if (a.startsWith('--')) {
      die(`unknown flag: ${a}`);
    } else if (sql === null) {
      sql = a;
    } else {
      die(`unexpected extra arg: ${a}`);
    }
  }

  const db = openDb();

  try {
    if (mode === 'tables') {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
      printRows(rows, pretty);
      return;
    }
    if (mode === 'schema') {
      // better-sqlite3 requires param binding for PRAGMA table_info in some versions;
      // use the function form, which accepts a bound name.
      const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(schemaTable)})`).all();
      printRows(rows, pretty);
      return;
    }

    if (!sql) die('no SQL provided');
    if (!isReadOnlySql(sql)) {
      die('only SELECT / PRAGMA / WITH / EXPLAIN are allowed');
    }

    let finalSql = sql;
    if (limit !== null && !/\blimit\s+\d/i.test(finalSql)) {
      finalSql = finalSql.replace(/;?\s*$/, '') + ` LIMIT ${limit}`;
    }

    const stmt = db.prepare(finalSql);
    // `.all()` works for SELECT; for PRAGMA/EXPLAIN it also returns rows.
    // If the statement returns no columns (unlikely for readonly), fall back to .run().
    let rows;
    try {
      rows = stmt.all();
    } catch (e) {
      if (/does not return data/i.test(e.message)) {
        stmt.run();
        rows = [];
      } else {
        throw e;
      }
    }
    printRows(rows, pretty);
  } catch (e) {
    die(e.message);
  } finally {
    db.close();
  }
}

main();
