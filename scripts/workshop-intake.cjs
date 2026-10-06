// Owner intake is ledger history; the report and lane batches are projections.
// No model calls, fuzzy merging, dispatch or product investigation happens here.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const v = require('./workshop-verification.cjs')
const MARKER = '<!-- workshop-ledger-report-v1 -->'
const LANES = new Set(['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'librarian', 'slackmaster', 'diplomat', 'handyman'])
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
const fail = message => { throw new Error(message) }
const same = (a, b) => v.normRef(a) === v.normRef(b)
const paths = repo => ({ ledger: path.join(repo, '.claude/agent-loop/ledger.jsonl'), report: path.join(repo, '.claude/agent-loop/report.md'), state: path.join(repo, '.claude/agent-loop/state.json') })
const readState = repo => fs.existsSync(paths(repo).state) ? JSON.parse(fs.readFileSync(paths(repo).state, 'utf8')) : {}
const read = repo => fs.existsSync(paths(repo).ledger) ? v.readRows(paths(repo).ledger) : []
const current = (rows, ref) => v.collapseRows(rows).latest.find(r => same(r.ref, ref))
const ownerState = (rows, ref) => v.ownerStates(rows).get(v.normRef(ref)) || {}
const latestDisposition = (rows, ref) => rows.findLast(r => same(r.ref, ref) && (r.verdict || r.state === 'deferred' || r.state === 'partial')) || {}
const dispositionToken = (rows, ref) => { const index = rows.findLastIndex(r => same(r.ref, ref) && (r.verdict || r.state === 'deferred' || r.state === 'partial')); return hash(JSON.stringify({ index, event: rows[index] })) }
const isHeld = (rows, row) => {
  const authority = ownerState(rows, row.ref)
  if (authority.hold) return true
  const event = latestDisposition(rows, row.ref)
  if (row.intake && !authority.hold) return false
  return event.verdict === 'deferred' || event.state === 'deferred' || event.intake?.status === 'held' || (!row.intake && row.verdict !== 'captured')
}
function assertAdoption(rows, repo) {
  if (rows.some(r => r.capture || r.intake) || !fs.existsSync(paths(repo).report) || !fs.statSync(paths(repo).report).isFile()) return
  const report = fs.readFileSync(paths(repo).report, 'utf8')
  if (!report.startsWith(MARKER) && report.split(/\r?\n/).some(l => /^\s*\|/.test(l))) fail('legacy report has a table: reconcile every row/ruling into the ledger, preserve the legacy report as an artifact, then move it aside before adopting the projection; no capture was appended')
}

function capture(input, rows, repo, date) {
  if (!input || !text(input.id) || !text(input.ref) || !text(input.finding) || !['bug', 'suggestion'].includes(input.type)) fail('capture needs id, ref, finding and type bug|suggestion')
  if (!/^[a-z0-9][a-z0-9#_.:-]*$/i.test(input.ref)) fail('capture ref must be one stable slug or ticket identity, never a bundled ref')
  if (!Array.isArray(input.attachments) || input.attachments.some(a => !text(a))) fail('attachments must list retained paths/URLs, including []')
  const fingerprint = hash(JSON.stringify(input))
  const prior = rows.find(r => r.capture?.id === input.id)
  if (prior) {
    if (prior.capture.fingerprint !== fingerprint) fail('capture id already used with different content; retain the original and use a new id')
    return null // retry after a report failure must not append the event twice
  }
  const existing = current(rows, input.ref)
  if (existing && !text(input.sameItemEvidence)) fail('existing ref needs sameItemEvidence; similarity is not proof of the same item')
  if (existing && !v.collapseRows(rows).open.some(r => same(r.ref, input.ref))) fail('closed ref: record a distinct recurrence ref; evidence alone cannot reopen a verified fix or override a decline')
  // One immutable event per example retains its words, screenshots and history.
  // Metadata-only duplicates do not replace finding, review, hold or authorization.
  const attachments = input.attachments.map(original => {
    if (/^https?:\/\//i.test(original)) return { original, url: original }
    const data = fs.readFileSync(path.resolve(repo, original)), sha256 = hash(data)
    const file = `.claude/agent-loop/evidence/intake-${sha256}${path.extname(original).toLowerCase()}`
    const target = path.join(repo, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) { if (hash(fs.readFileSync(target)) !== sha256) fail('retained attachment hash mismatch') }
    else fs.writeFileSync(target, data, { flag: 'wx' })
    return { original, file, sha256 }
  })
  const row = { date, lifecycleVersion: 1, ref: existing?.ref || input.ref, source: 'owner', capture: { ...input, attachments, fingerprint } }
  if (!existing) Object.assign(row, { finding: input.finding, verdict: 'captured', intake: { type: input.type, status: 'captured' } })
  return row
}

function assess(input, rows, repo, date) {
  if (!input || !text(input.ref) || !['captured', 'ready', 'decision', 'held'].includes(input.status) || !text(input.reason)) fail('assessment needs ref, status captured|ready|decision|held and reason')
  const row = current(rows, input.ref)
  if (!row || !v.collapseRows(rows).open.some(r => same(r.ref, input.ref)) && !(input.ownerRuled && row.verdict === 'verified' && row.state !== 'wrapped')) fail('assessment must name an open ref')
  const authority = ownerState(rows, row.ref), implemented = Boolean(row.evidence)
  if (authority.terminal) fail('terminal work needs a distinct recurrence identity, not renewed intake permission')
  if (implemented && !input.ownerRuled && !input.releaseHold && !(input.status === 'decision' && row.verdict === 'needs-owner-decision')) fail('implementation/review lifecycle cannot be reset by an intake assessment; answer its current question or release its current hold explicitly')
  if (!['bug', 'suggestion'].includes(input.type || row.intake?.type)) fail('assessment needs type bug|suggestion')
  if (input.status === 'ready' || input.status === 'decision') {
    if (!LANES.has(input.lane)) fail('assessment needs an owning product lane')
    const file = `.claude/agents/${input.lane}.md`
    if (input.charter?.file !== file || !text(input.charter?.rule) || input.charter.sha256 !== hash(fs.readFileSync(path.join(repo, file)))) fail('assessment needs current owning charter file, sha256 and relevant rule citation')
  }
  if (input.status === 'ready' && !text(input.authorization)) fail('ready needs explicit owner authorization; recommend build is not authorization')
  if (input.status === 'ready' && !input.ownerRuled && row.verdict === 'needs-dependency' && input.dispositionToken !== dispositionToken(rows, row.ref)) fail('dependency reassessment needs the current dispositionToken and a reason citing the resolved dependency; retain the existing authorization')
  if (input.status === 'decision' && (!text(input.question) || !text(input.uncovered) || !text(input.recommend))) fail('decision needs a concrete question, uncovered charter/product choice and recommendation')
  // Earlier holds are never undone by capture or a generic run. An explicit
  // per-ref owner instruction is required to release a held/backlog item.
  if (isHeld(rows, row) && input.status !== 'held' && (!text(input.releaseHold) || input.releaseHoldFor !== (authority.hold?.token || dispositionToken(rows, row.ref)))) fail('existing backlog/hold requires the owner per-ref releaseHold instruction and releaseHoldFor matching its current disposition token')
  let ownerRuling
  if (input.ownerRuled) {
    const answer = input.ownerRuled, fingerprint = hash(JSON.stringify(input))
    if (input.status !== 'ready' || !authority.question || answer.questionToken !== authority.question.token || answer.askedBecause !== authority.question.askedBecause || !text(answer.hisRuling)) fail('ownerRuled must answer the exact current questionToken and askedBecause with the owner words')
    if (implemented && input.attemptId !== row.evidence.attemptId) fail('answer must name the current implementation attemptId')
    if (authority.answer?.fingerprint === fingerprint) return null
    if ((answer.supersedes || null) !== (authority.answer?.token || null)) fail('revised answer must supersede the current rulingToken; stale answers cannot overwrite newer owner words')
    ownerRuling = { ...answer, fingerprint, ...(implemented ? { attemptId: input.attemptId } : {}) }
  }
  if (input.status === 'ready' && authority.question && !authority.answer && !ownerRuling) fail('ready cannot answer a product question; record ownerRuled against the current questionToken')
  // Authorization metadata changes neither the implementation nor its review.
  if (ownerRuling || implemented && input.releaseHold) return { date, lifecycleVersion: 1, ref: row.ref, source: 'owner', ...(input.releaseHold ? { state: 'open' } : {}), ...(ownerRuling ? { ownerRuling } : {}), intake: { ...row.intake, ...input, status: 'ready' }, note: input.reason }
  return { date, lifecycleVersion: 1, ref: row.ref, source: 'owner', verdict: input.status === 'decision' ? 'needs-owner-decision' : input.status === 'held' ? 'deferred' : 'captured', state: input.status === 'held' ? 'deferred' : 'open', ...(input.lane ? { lane: input.lane } : {}), ...(input.recommend ? { recommend: input.recommend } : {}), intake: { ...input, type: input.type || row.intake.type }, note: input.reason }
}

function view(rows, repo, state = readState(repo)) {
  for (const r of rows) for (const a of r.capture?.attachments || []) {
    if (a.file && (!fs.existsSync(path.join(repo, a.file)) || hash(fs.readFileSync(path.join(repo, a.file))) !== a.sha256)) fail(`missing or changed retained capture attachment: ${a.file}`)
  }
  const collapsed = v.collapseRows(rows)
  const reviewNeeded = new Set(v.verificationBlockers(rows, repo, state).map(r => v.normRef(r.ref)))
  const inFlight = new Set((state.inFlight || []).map(r => v.normRef(r.ref)))
  const items = collapsed.open.map(row => {
    const authority = ownerState(rows, row.ref)
    const event = latestDisposition(rows, row.ref)
    const assessmentCurrent = Boolean(event.intake)
    let status = 'held'
    if (isHeld(rows, row) || authority.terminal) status = 'held'
    else if (authority.question && !authority.answer || row.verdict === 'needs-owner-decision' && (assessmentCurrent && row.intake?.status === 'decision' || row.intake && !authority.answer)) status = 'decision'
    else if (row.verdict === 'needs-dependency') status = 'blocked'
    else if (reviewNeeded.has(v.normRef(row.ref))) status = 'review'
    else if (row.intake) status = authority.answer ? 'ready' : row.intake.status
    if (status === 'ready') {
      const c = row.intake.charter
      if (!c || !fs.existsSync(path.join(repo, c.file)) || hash(fs.readFileSync(path.join(repo, c.file))) !== c.sha256) status = 'captured'
    }
    if (inFlight.has(v.normRef(row.ref))) status = 'in-flight'
    return { ...row, status, assessmentCurrent, dispositionToken: authority.hold?.token || dispositionToken(rows, row.ref), questionToken: authority.question?.token || null, rulingToken: authority.answer?.token || null, ownerQuestion: authority.question?.askedBecause || null, currentReason: authority.hold?.reason || (authority.question && !authority.answer ? authority.question.askedBecause : null) || event.note || event.intake?.reason || event.recommend || row.note || '', examples: rows.filter(r => same(r.ref, row.ref) && r.capture).map(r => r.capture) }
  })
  const closed = collapsed.closed.map(row => { const authority = ownerState(rows, row.ref); return { ...row, questionToken: authority.question?.token || null, rulingToken: authority.answer?.token || null, ownerQuestion: authority.question?.askedBecause || null } })
  const verified = closed.filter(r => r.verdict === 'verified' && r.state !== 'wrapped')
  return { items, verified, closed, counts: Object.fromEntries(['captured', 'ready', 'decision', 'held', 'blocked', 'review', 'in-flight'].map(s => [s, items.filter(r => r.status === s).length])) }
}
const cell = value => String(value || '').replace(/\r?\n/g, ' ').replace(/\|/g, '&#124;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const brief = value => { const s = String(value || '').replace(/\s+/g, ' '); return s.length > 240 ? s.slice(0, 237) + '…' : s }
function render(rows, repo, state = readState(repo)) {
  const board = view(rows, repo, state), c = board.counts
  const lines = [MARKER, `**${c.decision} product decisions await you** — ${board.items.length} open items; ${c.captured} captured, ${c.ready} ready for an authorized lane batch, ${c.held} held, ${c.blocked} dependency blocked, ${c.review} awaiting review/repair, ${c['in-flight']} in flight.`, '', `**Independently verified, awaiting wrap (${board.verified.length}):** ${board.verified.map(r => cell(r.ref)).join(' · ') || 'none'}`, '']
  const names = { captured: 'Captured — pending batch assessment', ready: 'Ready for lane', decision: 'Needs a product decision', held: 'Held — recorded rulings / existing backlog', blocked: 'Blocked — dependency or execution evidence required', review: 'Awaiting independent review or repair', 'in-flight': 'In flight' }
  for (const [status, title] of Object.entries(names)) {
    const items = board.items.filter(r => r.status === status)
    if (!items.length) continue
    lines.push(`### ${title} (${items.length})`, '', '| Lane · ref | What happened | Your options | Risk |', '|---|---|---|---|')
    for (const r of items) {
      const options = status === 'decision' ? r.assessmentCurrent ? `${r.intake.question} Recommend: ${r.intake.recommend}` : `${r.currentReason || r.finding} — Manager must retain the lane's actual product question and recommendation before dispatch.` : status === 'held' ? `Held: ${r.currentReason || 'Needs explicit authorization before scheduling'}` : status === 'blocked' ? `Blocked: ${r.currentReason || 'Dependency outcome requires verification'}; existing owner authorization is retained.` : status === 'ready' ? 'Included when the authorized batch runs' : status === 'captured' ? 'Collected; assess against the owning charter when you say run' : status === 'in-flight' ? 'Lane is working' : 'Not verified; review or repair required'
      lines.push(`| ${cell(r.lane || 'unassigned')} · ${cell(r.ref)} | ${cell(r.intake?.type || 'backlog')}: ${cell(brief(r.finding))}${r.examples.length ? ` (${r.examples.length} retained example${r.examples.length === 1 ? '' : 's'})` : ''} | ${cell(status === 'held' ? brief(options) : options)} | ${cell(r.intake?.risk || 'Not assessed')} |`)
    }
    lines.push('')
  }
  const architectFile = path.join(repo, '.claude/agent-loop/architect-ledger.jsonl')
  if (fs.existsSync(architectFile)) {
    const { isClosed, currentVerdict, hydrate } = require('./architect-file.cjs'), latest = new Map()
    for (const line of fs.readFileSync(architectFile, 'utf8').split(/\r?\n/).filter(Boolean)) { const r = hydrate(JSON.parse(line), repo); latest.set(r.id, { ...latest.get(r.id), ...r }) }
    const open = [...latest.values()].filter(r => !isClosed(r, repo)).map(r => ({ ...r, verdict: currentVerdict(r, repo) }))
    if (open.length) {
      lines.push(`### Framework work (${open.length} open)`, '')
      for (const r of open) lines.push(`- ${cell(r.id)} — ${cell(r.verdict)}: ${cell(r.finding)}${r.implementation ? ` — ${cell(r.implementation.attemptId)}` : ''}${r.review ? ` — ${cell(r.review.reason)}` : r.implementation ? ' — awaiting independent review' : ''}`)
      lines.push('')
    }
  }
  return lines.join('\n') + '\n'
}
function reconcile(repo, write = false) {
  const rows = read(repo), expected = render(rows, repo), file = paths(repo).report
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : ''
  if (write && actual !== expected) {
    const temp = `${file}.${process.pid}.tmp`
    try { fs.writeFileSync(temp, expected); fs.renameSync(temp, file) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  const board = view(rows, repo)
  return { current: write || actual === expected, ...board.counts, open: board.items.length, verified: board.verified.length }
}
function plan(rows, repo, requested, state = readState(repo)) {
  if (['running', 'stopped'].includes(state.lastRun?.status)) fail('run is not idle; current owner-run state must be resolved before creating admission')
  if (!requested || !Array.isArray(requested.refs) || (!requested.refs.length && requested.allowFresh !== true) || new Set(requested.refs.map(v.normRef)).size !== requested.refs.length || !text(requested.authorization)) fail('batch plan needs unique refs and the owner run authorization; empty refs require an explicitly authorized fresh-source run')
  const board = view(rows, repo, state), batches = {}, blocked = []
  const resumes = Array.isArray(requested.resume) ? requested.resume : []
  if (resumes.some(r => !text(r.ref) || !text(r.attemptId) || !requested.refs.some(ref => same(ref, r.ref))) || new Set(resumes.map(r => v.normRef(r.ref))).size !== resumes.length) fail('resume must name unique selected refs and their exact current attemptId')
  for (const ref of requested.refs) {
    const row = board.items.find(r => same(r.ref, ref)) || board.verified.find(r => same(r.ref, ref))
    const resume = resumes.find(r => same(r.ref, ref))
    const authority = ownerState(rows, ref)
    const charter = row?.intake?.charter
    const continuation = Boolean(resume && row && ['implemented', 'verification-failed', 'verification-unproven', 'verified', 'needs-dependency'].includes(row.verdict) && !isHeld(rows, row) && (!authority.question || authority.answer) && row.intake?.authorization && charter && fs.existsSync(path.join(repo, charter.file)) && hash(fs.readFileSync(path.join(repo, charter.file))) === charter.sha256 && row.evidence?.attemptId === resume.attemptId && !v.checkEvidence(row.evidence).length && !v.snapshotErrors(row, repo).length)
    if (authority.terminal || !row || (resume ? !continuation : row.status !== 'ready')) { blocked.push({ ref, status: authority.terminal || row?.status || row?.verdict || 'closed-or-absent', reason: resume ? 'resume needs the current unchanged attempt, charter and existing authorization; later decisions/holds cannot be bypassed' : 'not ready' }); continue }
    ;(batches[row.lane] ||= []).push({ ref: row.ref, finding: row.finding, type: row.intake.type, charter: row.intake.charter, assessment: row.intake.reason, authorization: row.intake.authorization, examples: row.examples || [], ...(authority.answer ? { ownerRuled: { askedBecause: authority.question.askedBecause, hisRuling: authority.answer.hisRuling }, rulingToken: authority.answer.token } : {}), ...(continuation ? { continuation: { attemptId: row.evidence.attemptId, verdict: row.verdict, review: row.review || null } } : {}) })
  }
  const included = Object.values(batches).flat()
  const intakeAdmission = { version: 1, authorization: requested.authorization, allowFresh: requested.allowFresh === true, entries: [...board.items, ...board.closed].map(r => { const item = included.find(i => same(i.ref, r.ref)); return { ref: r.ref, lane: r.lane || '', status: item?.continuation ? 'continuation' : r.status || r.verdict, selected: Boolean(item), ...(item?.ownerRuled ? { ownerRuled: item.ownerRuled, rulingToken: item.rulingToken } : {}), ...(item?.continuation || {}) } }) }
  return { authorization: requested.authorization, requested: requested.refs.length, included: included.length, blocked, batches: Object.entries(batches).map(([lane, items]) => ({ lane, items })), intakeAdmission, review: 'Independent Bouncer required on each exact implemented attempt; existing lifecycle and release gates apply.' }
}
module.exports = { MARKER, capture, assess, view, render, reconcile, plan, paths, read, readState, assertAdoption }
