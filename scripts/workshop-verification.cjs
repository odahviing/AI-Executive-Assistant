// Workshop lifecycle and executable-evidence gate. No dependencies; see WORKSHOP.md.
// The pure block is mirrored in the filesystem-free Workflow runtime. The regression
// suite compares and executes all three copies so a changed contract cannot drift.
// BEGIN WORKSHOP CONTRACT
const workshopContract = (() => {
  const text = x => typeof x === 'string' && x.trim().length > 0
  const array = x => Array.isArray(x) ? x : []
  const strings = x => Array.isArray(x) && x.every(text)
  const unique = x => new Set(x).size === x.length
  const checkEvidence = e => {
    const errors = []
    if (!e || e.version !== 1) return ['missing evidence version 1']
    for (const key of ['attemptId', 'builder']) if (!text(e[key])) errors.push(`missing ${key}`)
    if (!strings(e.files) || !e.files.length || !unique(e.files)) errors.push('files must enumerate every changed file once')
    if (!['deterministic', 'prompt-only', 'prose-only'].includes(e.changeKind)) errors.push('missing changeKind')
    if (e.changeKind !== 'deterministic' && !text(e.exception)) errors.push('prompt/prose exception needs an explicit limitation')
    const suites = array(e.regressions)
    if (!Array.isArray(e.regressions) || !unique(suites.map(t => t.id))) errors.push('regressions must be an explicit array with unique ids')
    if (e.changeKind === 'deterministic' && !suites.length) errors.push('deterministic change needs executed fail-before/pass-after regression')
    const caseIds = []
    for (const t of suites) {
      if (!text(t.id) || !text(t.command) || !text(t.beforeRevision)) errors.push('regression needs id, command and beforeRevision')
      for (const phase of ['before', 'after']) {
        const r = t[phase] || {}
        if (!Number.isInteger(r.exitCode) || !Number.isInteger(r.passed) || r.passed < 0 || !Number.isInteger(r.failed) || r.failed < 0 || !text(r.output)) errors.push(`${t.id}: ${phase} needs executed exit code, counts and output evidence`)
      }
      if (!t.before || t.before.exitCode === 0 || !(t.before.failed > 0)) errors.push(`${t.id}: no failing before execution`)
      if (!t.after || t.after.exitCode !== 0 || t.after.failed !== 0 || !(t.after.passed > 0)) errors.push(`${t.id}: after execution did not pass`)
      const cases = array(t.cases)
      if (!cases.some(c => c.kind === 'regression' && c.before === 'fail' && c.after === 'pass')) errors.push(`${t.id}: missing failing regression case`)
      if (!cases.some(c => c.kind === 'preserved' && c.before === 'pass' && c.after === 'pass')) errors.push(`${t.id}: missing legitimate preserved case`)
      if (cases.length > (t.after || {}).passed) errors.push(`${t.id}: case count exceeds executed passes`)
      if (cases.filter(c => c.kind === 'preserved').length > (t.before || {}).passed || cases.filter(c => c.kind === 'regression').length > (t.before || {}).failed) errors.push(`${t.id}: before counts cannot support the named cases`)
      for (const c of cases) {
        if (!text(c.id) || !text(c.evidence) || !['regression', 'preserved'].includes(c.kind) || c.after !== 'pass' || c.before !== (c.kind === 'regression' ? 'fail' : 'pass')) errors.push(`${t.id}: malformed case evidence`)
        caseIds.push(c.id)
      }
    }
    if (!unique(caseIds)) errors.push('case ids must be unique across suites')
    const b = e.boundaries || {}
    const paths = array(b.paths)
    if (e.changeKind !== 'prose-only' && (!text(b.inventoryCommand) || !paths.length)) errors.push('missing producer/consumer inventory and boundary paths')
    if (!Array.isArray(b.paths) || !unique(paths.map(p => p.id))) errors.push('boundary paths must be explicit and unique')
    if (!strings(b.changedGuards) || !unique(b.changedGuards)) errors.push('changedGuards must be an explicit unique list, including zero')
    for (const p of paths) {
      for (const key of ['id', 'producer', 'state', 'consumer', 'evidence']) if (!text(p[key])) errors.push(`boundary ${p.id || '?'}: missing ${key}`)
      if (p.status !== 'covered') errors.push(`boundary ${p.id}: ${p.status || 'missing'} path blocks completion`)
      if (!strings(p.caseIds) || (e.changeKind === 'deterministic' && !p.caseIds.length) || array(p.caseIds).some(id => !caseIds.includes(id))) errors.push(`boundary ${p.id}: missing executed case coverage`)
      if (p.guard && (!array(b.changedGuards).includes(p.guard) || !['accept', 'reject'].includes(p.direction))) errors.push(`boundary ${p.id}: unknown guard/direction`)
    }
    for (const guard of array(b.changedGuards)) for (const direction of ['accept', 'reject']) {
      if (!paths.some(p => p.guard === guard && p.direction === direction && p.status === 'covered')) errors.push(`guard ${guard}: missing ${direction} direction`)
    }
    const surfaces = array(b.surfaces)
    if (!unique(surfaces.map(s => s.id))) errors.push('duplicate surface declaration')
    if (e.changeKind !== 'prose-only') for (const id of ['owner', 'colleague', 'dm', 'room', 'unavailable']) {
      const s = surfaces.find(s => s.id === id)
      if (!s || !['covered', 'not-applicable'].includes(s.status) || !text(s.reason) || (s.status === 'covered' && (!strings(s.pathIds) || !s.pathIds.length || s.pathIds.some(p => !paths.some(x => x.id === p))))) errors.push(`surface ${id}: missing coverage or explicit non-applicability reason`)
    }
    return errors
  }
  const checkReview = (e, r) => {
    const errors = checkEvidence(e)
    if (!r || !['pass', 'fail', 'unproven'].includes(r.verdict)) return [...errors, 'missing independent Bouncer verdict']
    if (!text(r.reviewer) || r.reviewer === e?.builder) errors.push('review must identify an independent dispatch')
    if (!text(r.trace)) errors.push('missing actual review dispatch/transcript trace')
    if (r.attemptId !== e?.attemptId) errors.push('review belongs to a different build attempt')
    if (!text(r.reason)) errors.push('missing review evidence/reason')
    if (r.verdict !== 'pass') return [...errors, `Bouncer ${r.verdict}: ${r.reason || 'no reason'}`]
    if (r.outcome !== 'traced') errors.push('outcome is untraced')
    if (r.inventoryComplete !== true || r.guardsComplete !== true) errors.push('Bouncer has not confirmed complete producer/consumer and guard inventories')
    if (!Array.isArray(r.findings) || r.findings.length) errors.push('Bouncer findings missing or unresolved')
    const ids = array(e?.boundaries?.paths).map(p => p.id)
    if (!strings(r.reviewedPaths) || !unique(r.reviewedPaths) || r.reviewedPaths.length !== ids.length || ids.some(id => !r.reviewedPaths.includes(id))) errors.push('independent boundary review is incomplete')
    if (!Array.isArray(r.checks)) errors.push('missing executed review checks, including zero')
    if (!unique(array(r.checks).map(c => c.id)) || array(r.checks).some(c => c.exitCode !== 0 || c.failed !== 0)) errors.push('duplicate or failed independent review execution')
    for (const t of array(e?.regressions)) {
      const c = array(r.checks).find(c => c.id === t.id)
      if (!c || !text(c.command) || !text(c.output) || c.exitCode !== 0 || c.failed !== 0 || !Number.isInteger(c.passed) || c.passed < t.cases.length) errors.push(`${t.id}: independent regression execution missing/failed`)
    }
    if (e?.changeKind === 'prompt-only' && r.scope !== 'structural') errors.push('prompt-only review can establish structural inputs only')
    return errors
  }
  const gateBuild = r => {
    if (r.verdict !== 'built') return r
    const errors = checkEvidence(r.evidence)
    return errors.length ? { ...r, verdict: 'needs-dependency', notes: `${r.notes || ''} [evidence gate: ${errors.join('; ')}]` } : r
  }
  const gateFinal = r => {
    if (r.verdict !== 'built') return r
    const errors = checkReview(r.evidence, r.review)
    return errors.length ? { ...r, verdict: 'implemented', verificationErrors: errors, notes: `${r.notes || ''} [awaiting independent verification: ${errors.join('; ')}]` } : r
  }
  const acceptReviews = (builds, check, reviews) => {
    if (!check) return
    check.results = array(check.results).map(r => {
      const built = builds.find(b => b.id === r.id && b.verdict === 'built')
      if (!built) return r
      reviews.set(r.id, r.review)
      if (r.verdict !== 'built') return r
      const errors = checkReview(built.evidence, r.review)
      return errors.length ? { ...r, verdict: 'needs-owner-decision', notes: `${r.notes || ''} [verification gate: ${errors.join('; ')}]` } : r
    })
  }
  // Schema lives beside validation; conditional requirements are enforced above.
  const S = { type: 'string' }, N = { type: 'integer' }, B = { type: 'boolean' }
  const list = items => ({ type: 'array', items })
  const obj = properties => ({ type: 'object', properties, required: Object.keys(properties) })
  const run = obj({ exitCode: N, passed: N, failed: N, output: S })
  const evidenceSchema = obj({ version: { type: 'integer', enum: [1] }, attemptId: S, builder: S, changeKind: { type: 'string', enum: ['deterministic', 'prompt-only', 'prose-only'] }, files: list(S), exception: S,
    regressions: list(obj({ id: S, command: S, beforeRevision: S, before: run, after: run, cases: list(obj({ id: S, kind: S, before: S, after: S, evidence: S })) })),
    boundaries: obj({ inventoryCommand: S, changedGuards: list(S), paths: list(obj({ id: S, producer: S, state: S, consumer: S, guard: S, direction: S, caseIds: list(S), status: S, evidence: S })), surfaces: list(obj({ id: S, status: S, pathIds: list(S), reason: S })) }) })
  const reviewSchema = obj({ attemptId: S, reviewer: S, trace: S, verdict: { type: 'string', enum: ['pass', 'fail', 'unproven'] }, reason: S, outcome: S, inventoryComplete: B, guardsComplete: B, findings: list(S), reviewedPaths: list(S), scope: S, checks: list(obj({ id: S, command: S, exitCode: N, passed: N, failed: N, output: S })) })
  return { checkEvidence, checkReview, gateBuild, gateFinal, acceptReviews, evidenceSchema, reviewSchema }
})()
// END WORKSHOP CONTRACT

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const CLOSED = new Set(['built', 'verified', 'wrapped', 'confirmed-other-lane', 'already-fixed', 'audit', 'declined', 'converted'])
const normRef = t => String(t || '').trim().toLowerCase().replace(/^(?:gh)?#/, '')
const refTokens = ref => {
  const raw = String(ref || '').trim()
  const out = new Set(raw ? [normRef(raw)] : [])
  for (const p of raw.split(/[+,/]| and /i).map(s => s.trim()).filter(Boolean)) {
    out.add(normRef(p))
    const m = p.match(/^(.+?)[-–_](?:step|part|phase)?\s*([a-z0-9]{1,6})$/i)
    if (m && /^(?:gh#)?\d+$|^[a-z]\d+$/i.test(m[1])) out.add(normRef(m[1]))
  }
  return out
}
const isClosed = r => (!r.lifecycleVersion && !r.evidence && r.state === 'wrapped' && r.verdict !== 'verified') || CLOSED.has(r.verdict) && (!r.evidence && r.verdict !== 'verified' || ['verified', 'wrapped'].includes(r.verdict) && workshopContract.checkReview(r.evidence, r.review).length === 0 && (r.verdict === 'wrapped' || snapshotErrors(r, path.join(__dirname, '..')).length === 0))
function collapseRows(rows) {
  rows = rows.map(r => hydrateRow(r))
  const latest = new Map(), eventAt = new Map(), refless = []
  rows.forEach((r, i) => {
    if (r.kind && r.kind !== 'invariant-backfill') return
    if (!r.ref) { if (!isClosed(r)) refless.push(r); return }
    const key = normRef(r.ref), previous = latest.get(key) || {}
    let merged = { ...previous, ...r }
    // A fresh implementation belongs to this ref. Prior parent-linked review
    // must not invalidate a later, independently reviewed repair of the child.
    if (['built', 'implemented'].includes(r.verdict) && r.evidence && !r.verificationOf) delete merged.verificationOf
    if (r.verdict || r.state === 'partial') {
      eventAt.set(key, i)
      // Every implementation/overturn invalidates an earlier pass. Bare metadata
      // must preserve it; a repair with no review must never inherit it.
      if (!['verified', 'wrapped'].includes(r.verdict) && !r.review) delete merged.review
      if (r.state === 'partial' && !r.verdict) merged.verdict = 'needs-dependency'
      if (r.verdict === 'built' && (previous.evidence || previous.verdict === 'verification-failed' || previous.verdict === 'implemented')) merged.verdict = 'implemented'
      if (r.verdict !== 'wrapped' && previous.state === 'wrapped' && (r.lifecycleVersion === 1 || r.evidence || r.review || r.state === 'partial')) delete merged.state
    }
    latest.set(key, merged)
  })
  for (const [key, r] of latest) if (r.verificationOf && r.verdict === 'verified') {
    const parent = latest.get(normRef(r.verificationOf))
    if (!parent || parent.verificationOf || !['verified', 'wrapped'].includes(parent.verdict) || !isClosed(parent) || parent.evidence?.attemptId !== r.evidence?.attemptId)
      latest.set(key, { ...r, verdict: 'verification-unproven', verificationErrors: ['linked parent verification is no longer current; only one parent level is supported'] })
  }
  const closedBy = new Map()
  for (const [key, r] of latest) if (isClosed(r)) for (const token of refTokens(r.ref)) {
    const at = eventAt.get(key) ?? -1
    if (!closedBy.has(token) || closedBy.get(token).at < at) closedBy.set(token, { row: r, at })
  }
  const open = [], closed = [], collapsed = []
  for (const [key, r] of latest) {
    const closer = closedBy.get(key)
    const requiresReview = r.evidence || ['implemented', 'verified', 'verification-failed', 'verification-unproven'].includes(r.verdict)
    if (isClosed(r) || (!requiresReview && closer && closer.at >= (eventAt.get(key) ?? -1))) {
      closed.push(r)
      if (!isClosed(r)) collapsed.push({ r, closer: closer.row })
    } else open.push(r)
  }
  open.push(...refless)
  return { open, closed, collapsed, refless, latest: [...latest.values()] }
}
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
  try { return hydrateRow(JSON.parse(l), path.resolve(path.dirname(file), '../..')) } catch (e) { throw new Error(`Unreadable ledger row ${i + 1}; verification cannot be established: ${e.message}`) }
})
const hashFile = file => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
const snapshot = (files, repo) => files.map(file => ({ file, sha256: hashFile(path.resolve(repo, file)) }))
const snapshotErrors = (r, repo) => {
  const recorded = Array.isArray(r.snapshot) ? r.snapshot : []
  if (!recorded.length || recorded.length !== (r.evidence?.files || []).length || (r.evidence?.files || []).some(f => !recorded.some(s => s.file === f))) return ['missing complete build snapshot']
  return recorded.flatMap(s => {
    try { return hashFile(path.resolve(repo, s.file)) === s.sha256 ? [] : [`changed since reviewed: ${s.file}`] } catch { return [`unreadable since reviewed: ${s.file}`] }
  })
}
function verificationBlockers(rows, repo, { lastWrapIso = '' } = {}) {
  rows = rows.map(r => hydrateRow(r, repo))
  // GitHub partial sync records remaining ticket scope, not a new build or
  // overturn. Keep it in backlog collapse, but verify the actual lifecycle it
  // annotates; filtering the event must never discard earlier failed work.
  rows = rows.filter(r => !(r.state === 'partial' && /^gh#\d+$/.test(r.ref || '') && /^wrap-/.test(r.runId || '') && !r.lifecycleVersion && !r.evidence && !r.review && (!r.verdict || r.verdict === 'needs-owner-decision')))
  const collapsed = collapseRows(rows)
  const closedKeys = new Set(collapsed.closed.map(r => normRef(r.ref)))
  const builtKeys = new Set(), eventDates = new Map()
  for (const r of rows) {
    if (['built', 'implemented', 'verified'].includes(r.verdict)) builtKeys.add(normRef(r.ref))
    if (r.verdict || r.state === 'partial') eventDates.set(normRef(r.ref), String(r.date || ''))
  }
  const blockers = []
  for (const r of collapsed.latest) {
    // Legacy releases remain historical facts. A new implementation/overturn
    // clears inherited wrapped state in collapseRows and must earn a fresh pass.
    if ((r.verdict === 'wrapped' || r.state === 'wrapped') && isClosed(r)) continue
    if (!r.evidence && r.verdict !== 'built' && r.verdict !== 'verified' && closedKeys.has(normRef(r.ref))) continue
    const currentLegacyBuild = r.verdict === 'built' && (!lastWrapIso || eventDates.get(normRef(r.ref)) >= lastWrapIso.slice(0, 10))
    const previouslyBuilt = builtKeys.has(normRef(r.ref))
    if (!r.evidence && !currentLegacyBuild && !['implemented', 'verified', 'verification-failed', 'verification-unproven'].includes(r.verdict) && !(previouslyBuilt && !isClosed(r))) continue
    let errors = workshopContract.checkReview(r.evidence, r.review)
    if (r.verdict !== 'verified') errors = [...errors, `latest status is ${r.verdict || 'unknown'}`]
    if (!errors.length) errors.push(...snapshotErrors(r, repo))
    if (errors.length) blockers.push({ ref: r.ref, verdict: r.verdict, errors })
  }
  return blockers
}
// Content-addressed append-only attachments keep the lifecycle row small. Legacy
// inline rows remain readable; missing/tampered attachments fail closed.
const evidenceDirectory = '.claude/agent-loop/evidence'
function storeAttachment(value, repo) {
  const body = JSON.stringify(value) + '\n'
  const sha256 = crypto.createHash('sha256').update(body).digest('hex')
  const file = `${evidenceDirectory}/${sha256}.json`, target = path.join(repo, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try { fs.writeFileSync(target, body, { flag: 'wx' }) }
  catch (e) { if (e.code !== 'EEXIST' || fs.readFileSync(target, 'utf8') !== body) throw e }
  return { file, sha256 }
}
function loadAttachment(ref, repo) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.file !== `${evidenceDirectory}/${ref.sha256}.json`) throw new Error('invalid evidence reference')
  const body = fs.readFileSync(path.join(repo, ref.file))
  if (crypto.createHash('sha256').update(body).digest('hex') !== ref.sha256) throw new Error(`evidence hash mismatch: ${ref.file}`)
  return JSON.parse(body)
}
function compactRow(row, repo) {
  const r = { ...row }
  if (r.evidence) { r.evidenceRef = storeAttachment({ evidence: r.evidence, snapshot: r.snapshot }, repo); delete r.evidence; delete r.snapshot }
  if (r.review) { r.reviewRef = storeAttachment(r.review, repo); delete r.review }
  return r
}
function hydrateRow(row, repo = path.join(__dirname, '..')) {
  const r = { ...row }
  if (r.evidenceRef) {
    const value = loadAttachment(r.evidenceRef, repo)
    if (r.evidence && JSON.stringify(r.evidence) !== JSON.stringify(value.evidence) || r.snapshot && JSON.stringify(r.snapshot) !== JSON.stringify(value.snapshot)) throw new Error('inline evidence conflicts with referenced package')
    r.evidence = value.evidence; r.snapshot = value.snapshot
    delete r.evidenceRef
  }
  if (r.reviewRef) {
    const value = loadAttachment(r.reviewRef, repo)
    if (r.review && JSON.stringify(r.review) !== JSON.stringify(value)) throw new Error('inline review conflicts with referenced review')
    r.review = value; delete r.reviewRef
  }
  return r
}
function wrapCounts(rows, history = rows) {
  const refs = predicate => new Set(rows.filter(predicate).filter(r => r.ref).map(r => normRef(r.ref)))
  const covered = refs(r => r.verdict === 'wrapped' && r.state === 'wrapped')
  // Use the release's complete historical ledger snapshot, not only rows stamped
  // by wrap: parent linkage may have been recorded by an earlier review run.
  // collapseRows also clears inherited linkage when a child gets its own repair.
  const linked = new Set(collapseRows(history).latest.filter(r => r.verificationOf).map(r => normRef(r.ref)))
  return { events: rows.length, coveredRefs: covered.size, implementationRefs: [...covered].filter(ref => !linked.has(ref)).length,
    verifiedImplementationRefs: refs(r => r.verdict === 'verified' && !linked.has(normRef(r.ref))).size }
}
module.exports = { ...workshopContract, CLOSED, normRef, refTokens, isClosed, collapseRows, readRows, snapshot, snapshotErrors, verificationBlockers, compactRow, hydrateRow, wrapCounts }
