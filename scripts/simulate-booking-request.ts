// scripts/simulate-booking-request.ts
//
// Offline test for normalizeBookingRequest. Each scenario builds a synthetic
// args + context and asserts the invariants Phase A guarantees:
//
//   - owner is always in participants (with isOwner=true)
//   - duration is snapped to profile.meetings.allowed_durations
//   - sensitivity from colleague-path is dropped when colleague not in attendees
//   - relaxed is gated by senderRole / owner-in-MPIM / deferred-replay
//   - context bundle is populated
//
// Run: npx tsx scripts/simulate-booking-request.ts
//
// Exits 1 if any scenario fails, 0 otherwise. Used as a sanity check after
// touching bookingRequest.ts.

import * as fs from 'fs';
import * as path from 'path';

// Bootstrap: load env + set cwd to project root before importing project modules.
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);
try {
  const envText = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (_) { /* .env optional */ }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadAllProfiles } = require('../src/config/userProfile') as typeof import('../src/config/userProfile');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeBookingRequest } = require('../src/skills/meetings/bookingRequest') as typeof import('../src/skills/meetings/bookingRequest');
type BookingRequest = import('../src/skills/meetings/bookingRequest').BookingRequest;
type SkillContext = import('../src/skills/types').SkillContext;

const profile = [...loadAllProfiles().values()].find(p => p.user.slack_user_id === 'U0F28CK6H')
  ?? [...loadAllProfiles().values()][0];
if (!profile) { console.error('no profile loaded'); process.exit(1); }

const ownerSlackId = profile.user.slack_user_id;
const ownerEmail = profile.user.email;

let failed = 0;
let passed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function makeCtx(overrides: Partial<SkillContext>): SkillContext {
  return {
    profile,
    threadTs: 'sim-thread',
    channelId: 'sim-channel',
    userId: ownerSlackId,
    senderRole: 'owner',
    channel: 'slack',
    isMpim: false,
    isOwnerInGroup: false,
    ...overrides,
  };
}

function logReq(label: string, req: BookingRequest) {
  console.log(`    [${label}] intent=${req.intent}, init=${req.initiator}, relaxed=${req.relaxed} (${req.relaxedReason}), durationMin=${req.durationMin}, sens=${req.sensitivity ?? '∅'}, attendees=[${req.participants.map(p => `${p.email}${p.isOwner ? '*' : ''}`).join(', ')}]`);
}

(async () => {
  console.log('=== bookingRequest normalizer — offline scenarios ===\n');

  // ── 1. Owner-path create with non-owner attendee ──
  console.log('1. Owner-path create with [Michal]:');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'Michal Schwartz', email: 'michal.s@reflectiz.com', slack_id: 'U09DGGUMKMM' }],
      start: '2026-05-20T11:30:00',
      end: '2026-05-20T12:10:00',
      subject: 'Sales Commissions',
      is_online: true,
      category: 'Meeting',
    }, makeCtx({ senderRole: 'owner' }));
    logReq('owner+michal', req);
    ok('owner injected', req.participants.some(p => p.isOwner && p.email === ownerEmail));
    ok('michal kept', req.participants.some(p => p.email === 'michal.s@reflectiz.com' && !p.isOwner));
    ok('participants length = 2', req.participants.length === 2);
    ok('duration snapped (40 was already in allowed)', req.durationMin === 40);
    ok('intent=new_booking', req.intent === 'new_booking');
    ok('initiator=owner', req.initiator === 'owner');
  }

  // ── 2. Owner-path create with empty attendees (solo block) ──
  console.log('\n2. Owner-path create with no attendees (solo block):');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [],
      start: '2026-05-20T14:00:00',
      end: '2026-05-20T15:00:00',
      subject: 'Focus block',
    }, makeCtx({ senderRole: 'owner' }));
    logReq('solo', req);
    ok('owner injected as only participant', req.participants.length === 1 && req.participants[0].isOwner);
    ok('duration snapped 60 → 55', req.durationMin === 55);
  }

  // ── 3. Duration snap — 20 min → 25 min ──
  console.log('\n3. Duration snap — 20 min request:');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'Maayan', email: 'maayan.s@reflectiz.com' }],
      start: '2026-05-20T12:15:00',
      end: '2026-05-20T12:35:00',
      subject: 'Collateral Feedback',
    }, makeCtx({ senderRole: 'colleague', userId: 'U097Y7G8W8N' }));
    logReq('20→25', req);
    ok('snapped to 25 min', req.durationMin === 25);
    // endIso is recomputed via Date.toISOString (UTC) — exact wall-clock
    // depends on local TZ. Verify the duration delta instead.
    const startMs = Date.parse(req.slotStartIso!);
    const endMs = Date.parse(req.slotEndIso!);
    ok('endIso = start + 25min', Math.round((endMs - startMs) / 60000) === 25);
  }

  // ── 4. Sensitivity gate — colleague IN attendees ──
  console.log('\n4. Sensitivity from colleague who IS on the meeting (Yael interview):');
  {
    // The membership check uses the colleague's REAL email from people_memory
    // (intentionally — Sonnet could pass a wrong email by mistake). Use the
    // real Yael email here so the colleague-on-attendees check matches.
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'Yael Aharon', email: 'yael.a@reflectiz.com', slack_id: 'U02K5PN5K4Y' }],
      start: '2026-05-20T14:30:00',
      end: '2026-05-20T15:10:00',
      subject: 'Interview',
      sensitivity: 'private',
    }, makeCtx({ senderRole: 'colleague', userId: 'U02K5PN5K4Y' }));
    logReq('yael-private', req);
    ok('sensitivity kept (yael on attendee list)', req.sensitivity === 'private');
  }

  // ── 5. Sensitivity gate — colleague NOT in attendees ──
  console.log("\n5. Sensitivity from colleague who is NOT on the meeting:");
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'SomeoneElse', email: 'someone@reflectiz.com' }],
      start: '2026-05-20T14:30:00',
      end: '2026-05-20T15:10:00',
      subject: 'Interview',
      sensitivity: 'private',
    }, makeCtx({ senderRole: 'colleague', userId: 'U02K5PN5K4Y' }));
    logReq('drop-sens', req);
    ok('sensitivity dropped', req.sensitivity === undefined);
  }

  // ── 6. Relaxed — owner-path direct ──
  console.log('\n6. Relaxed flag — owner-path:');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'X', email: 'x@reflectiz.com' }],
      start: '2026-05-20T22:30:00',
      end: '2026-05-20T22:55:00',
      relaxed: true,
    }, makeCtx({ senderRole: 'owner' }));
    logReq('owner-relaxed', req);
    ok('relaxed=true', req.relaxed === true);
    ok("relaxedReason='owner_direct'", req.relaxedReason === 'owner_direct');
  }

  // ── 7. Relaxed — colleague-path, NOT in MPIM ──
  console.log('\n7. Relaxed flag — colleague-path, 1:1 DM (no MPIM context):');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'X', email: 'x@reflectiz.com' }],
      start: '2026-05-20T22:30:00',
      end: '2026-05-20T22:55:00',
      relaxed: true,
    }, makeCtx({ senderRole: 'colleague', userId: 'U02K5PN5K4Y' }));
    logReq('coll-relaxed', req);
    ok('relaxed dropped to false', req.relaxed === false);
    ok("relaxedReason='none'", req.relaxedReason === 'none');
  }

  // ── 8. Deferred replay ──
  console.log('\n8. Relaxed flag — deferred-replay path:');
  {
    const req = await normalizeBookingRequest('create_meeting', {
      attendees: [{ name: 'X', email: 'x@reflectiz.com' }],
      start: '2026-05-20T22:30:00',
      end: '2026-05-20T22:55:00',
      relaxed: true,
    }, makeCtx({ senderRole: 'owner' }), { isDeferredReplay: true });
    logReq('replay', req);
    ok("relaxedReason='deferred_replay'", req.relaxedReason === 'deferred_replay');
  }

  // ── 9. Intent inference ──
  console.log('\n9. Intent inference from tool name:');
  {
    const create = await normalizeBookingRequest('create_meeting', { attendees: [] }, makeCtx({}));
    const move = await normalizeBookingRequest('move_meeting', { attendees: [] }, makeCtx({}));
    const del = await normalizeBookingRequest('delete_meeting', { attendees: [] }, makeCtx({}));
    const find = await normalizeBookingRequest('find_available_slots', { attendees: [] }, makeCtx({}));
    ok('create_meeting → new_booking', create.intent === 'new_booking');
    ok('move_meeting → move', move.intent === 'move');
    ok('delete_meeting → cancel', del.intent === 'cancel');
    ok('find_available_slots → find_slots', find.intent === 'find_slots');
  }

  // ── Summary ──
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('simulate-booking-request failed:', err);
  process.exit(2);
});
