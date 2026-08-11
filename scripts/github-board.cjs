#!/usr/bin/env node
// Regenerates the "Backlog" artifact page from the current state of GitHub issues.
// Usage: node scripts/github-board.cjs <output-html-path>
// Prints a JSON summary to stdout: { artifactUrl, opened, closed, relabeled, fixedLabels, warnings, itemCount }
// Enforces one label rule on GitHub itself: a blocked item's tier label gets removed
// if drift left one on it — everything else stays read-only, propose-only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..', '.claude', 'skills', 'github-board');
const TEMPLATE_PATH = path.join(SKILL_DIR, 'template.html');
const STATE_PATH = path.join(SKILL_DIR, 'state.json');

const TYPE_LABELS = ['Feature', 'Improvement', 'Framework'];
const TIER_LABELS = ['Next', 'Roadmap', 'Idea'];
const TAG_LABELS = ['Skill', 'Transport', 'Paid API'];
const TAG_CSS = {
  Skill: { bg: '--tag-skill-bg', fg: '--tag-skill', text: 'SKILL' },
  Transport: { bg: '--tag-transport-bg', fg: '--tag-transport', text: 'TRANSPORT' },
  'Paid API': { bg: '--tag-paid-bg', fg: '--tag-paid', text: 'PAID API' },
};

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { artifactUrl: null, snapshot: {} };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function fetchOpenIssues() {
  const raw = gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,labels']);
  return JSON.parse(raw);
}

function fetchBlockedBy() {
  const query = `
    query {
      repository(owner: "odahviing", name: "AI-Executive-Assistant") {
        issues(states: OPEN, first: 100) {
          nodes { number blockedBy(first: 5) { nodes { number state } } }
        }
      }
    }`;
  const raw = gh(['api', 'graphql', '-f', `query=${query}`]);
  const nodes = JSON.parse(raw).data.repository.issues.nodes;
  const map = {};
  for (const n of nodes) {
    const openBlockers = n.blockedBy.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number);
    if (openBlockers.length) map[n.number] = openBlockers;
  }
  return map;
}

function classify(issue, blockedByMap) {
  const names = issue.labels.map((l) => l.name);
  const isBug = names.includes('Bug');
  const type = TYPE_LABELS.find((t) => names.includes(t)) || null;
  const tier = TIER_LABELS.find((t) => names.includes(t)) || null;
  const tags = TAG_LABELS.filter((t) => names.includes(t));
  const blockers = blockedByMap[issue.number] || [];
  return { number: issue.number, title: issue.title, type, tier, tags, blockers, isBug };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tagChipsHtml(tags) {
  if (!tags.length) return '';
  const chips = tags
    .map((t) => {
      const c = TAG_CSS[t];
      return `<span class="chip" style="background:var(${c.bg}); color:var(${c.fg})">${c.text}</span>`;
    })
    .join('');
  return `<div class="card-tags">${chips}</div>`;
}

const REPO_URL = 'https://github.com/odahviing/AI-Executive-Assistant';

function cardHtml(item, isChild) {
  const typeClass = item.type ? item.type.toLowerCase() : '';
  const blockedNote = isChild ? `<span class="blocked-note">&#8618; blocked by #${item.blockers[0]}</span>` : '';
  return `<a class="card ${typeClass}" href="${REPO_URL}/issues/${item.number}" target="_blank" rel="noopener"><div class="card-top"><span class="card-id">#${item.number}</span><span class="card-title">${esc(
    item.title
  )}</span></div>${tagChipsHtml(item.tags)}${blockedNote}</a>`;
}

function buildColumn(tierName, hint, topLevel, childrenByParent) {
  const cards = topLevel
    .map((item) => {
      const kids = childrenByParent[item.number];
      if (!kids || !kids.length) return cardHtml(item, false);
      const kidsHtml = kids.map((k) => cardHtml(k, true)).join('\n          ');
      return `<div class="parent-block">\n            ${cardHtml(item, false)}\n            <div class="children">\n          ${kidsHtml}\n            </div>\n          </div>`;
    })
    .join('\n          ');
  return `<div class="col">
        <div class="col-head"><h3>${tierName}</h3><span class="col-count">${topLevel.length}</span></div>
        <p class="col-hint">${hint}</p>
        <div class="stack">
          ${cards}
        </div>
      </div>`;
}

function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('Usage: node scripts/github-board.cjs <output-html-path>');
    process.exit(1);
  }

  const state = loadState();
  const rawIssues = fetchOpenIssues();
  const blockedByMap = fetchBlockedBy();
  const classified = rawIssues.map((i) => classify(i, blockedByMap)).filter((c) => !c.isBug);
  // Bug-labeled issues belong to the separate bug-triage pipeline, never this board —
  // excluded outright, not warned about. A Bug ticket with no Feature/Improvement/Framework
  // label is expected, not a classification gap.

  const warnings = [];
  const fixedLabels = [];
  const byNumber = {};
  classified.forEach((c) => (byNumber[c.number] = c));

  // Resolve blockers to parents actually present in the open set
  const childrenByParent = {};
  const childNumbers = new Set();
  for (const item of classified) {
    if (!item.blockers.length) continue;
    const parent = item.blockers.find((b) => byNumber[b]);
    if (!parent) {
      warnings.push(`#${item.number} is blocked by #${item.blockers[0]}, which isn't in the open set (orphaned block) — rendered as unblocked.`);
      continue;
    }
    childNumbers.add(item.number);
    (childrenByParent[parent] = childrenByParent[parent] || []).push(item);
    // Enforcement, not just a warning: a blocked item's tier is inherited from its
    // parent's position, never its own — this rule only holds going forward if
    // drift from another chat/session actually gets corrected here, not just
    // rendered around.
    if (item.tier) {
      gh(['issue', 'edit', String(item.number), '--remove-label', item.tier]);
      fixedLabels.push(`#${item.number} — removed stale "${item.tier}" label (blocked by #${parent})`);
      item.tier = null;
    }
  }

  const columns = { Next: [], Roadmap: [], Idea: [] };
  const unclassified = [];
  for (const item of classified) {
    if (childNumbers.has(item.number)) continue; // rendered nested, not top-level
    if (!item.type) warnings.push(`#${item.number} "${item.title}" has no Feature/Improvement/Framework label.`);
    if (!item.tier) {
      unclassified.push(item);
      continue;
    }
    columns[item.tier].push(item);
  }
  for (const col of Object.values(columns)) col.sort((a, b) => a.number - b.number);
  if (unclassified.length) {
    warnings.push(`${unclassified.length} unblocked issue(s) have no Next/Roadmap/Idea tier and were left off the board: ${unclassified.map((i) => '#' + i.number).join(', ')}.`);
  }

  const boardHtml = `<div class="board">

      ${buildColumn('Next', 'Building soon.', columns.Next, childrenByParent)}

      ${buildColumn('Roadmap', 'Real, probably doing eventually.', columns.Roadmap, childrenByParent)}

      ${buildColumn('Idea', 'Not committed, may never happen.', columns.Idea, childrenByParent)}

    </div>`;

  // Diff against last snapshot
  const prevSnapshot = state.snapshot || {};
  const currNumbers = new Set(classified.map((c) => c.number));
  const opened = classified.filter((c) => !prevSnapshot[c.number]).map((c) => `#${c.number} ${c.title}`);
  const closed = Object.keys(prevSnapshot)
    .filter((n) => !currNumbers.has(Number(n)))
    .map((n) => `#${n} ${prevSnapshot[n].title}`);
  const relabeled = classified
    .filter((c) => prevSnapshot[c.number] && (prevSnapshot[c.number].type !== c.type || prevSnapshot[c.number].tier !== c.tier))
    .map((c) => `#${c.number} ${c.title} (${prevSnapshot[c.number].type}/${prevSnapshot[c.number].tier} -> ${c.type}/${c.tier})`);

  const itemCount = classified.length - unclassified.filter((u) => false).length; // total open issues considered
  const renderedCount = classified.length - unclassified.length;

  let footerNote = '<p>No changes since the last refresh.</p>';
  const bits = [];
  if (opened.length) bits.push(`opened: ${opened.join(', ')}`);
  if (closed.length) bits.push(`closed: ${closed.join(', ')}`);
  if (relabeled.length) bits.push(`relabeled: ${relabeled.join(', ')}`);
  if (bits.length) footerNote = `<p>Since last refresh &mdash; ${esc(bits.join(' &middot; '))}</p>`;
  footerNote += `\n    <p>Tag inheritance: a blocked child doesn't repeat its parent's Transport/Skill tag &mdash; the tree already carries it.</p>`;

  let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  html = html.replace('<!--ITEM_COUNT-->', String(renderedCount));
  html = html.replace('<!--BOARD-->', boardHtml);
  html = html.replace('<!--FOOTER_NOTE-->', footerNote);
  fs.writeFileSync(outPath, html);

  const newSnapshot = {};
  classified.forEach((c) => (newSnapshot[c.number] = { title: c.title, type: c.type, tier: c.tier }));
  saveState({ artifactUrl: state.artifactUrl || null, snapshot: newSnapshot });

  console.log(
    JSON.stringify(
      {
        artifactUrl: state.artifactUrl || null,
        outPath,
        itemCount: renderedCount,
        opened,
        closed,
        relabeled,
        fixedLabels,
        warnings,
      },
      null,
      2
    )
  );
}

main();
