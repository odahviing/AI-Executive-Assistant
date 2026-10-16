// Fresh Boston travel matrix over real hours, finder, validator and spreader.
// I/O isolated by the existing V5 harness; no live calendar or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, Settings } = require('luxon');
const { harness } = require('./test-timezone-owner-interval.cjs');
const { regularWeek } = require('./fixtures/regular-week.cjs');
Settings.now = () => Date.parse('2026-10-16T00:00:00Z');
const boston = 'America/New_York', israel = 'Asia/Jerusalem';
const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const israelDays = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];
function fixture(start = '09:00', reverse = false, busy = []) {
  const zone = reverse ? israel : boston;
  const h = harness({}, { realAvailability: true, realDensity: true, extraMocks: {
    'src/connectors/graph/calendarReads.ts': {
      getFreeBusyForDecision: async () => ({ 'owner@example.test': busy }),
      getOwnerEventsForDecision: async () => busy.map((s,i)=>({id:`fixture-${i}`,subject:'Fixture commitment',start:{dateTime:s.start,timeZone:zone},end:{dateTime:s.end,timeZone:zone},showAs:s.status,isAllDay:false,isCancelled:false,attendees:[]})), isOutageShaped: () => false, CalendarOfflineError: Error,
    },
  } });
  h.profile.user.timezone = zone;
  h.profile.schedule.office_days.days = reverse ? israelDays : ['Monday','Tuesday','Thursday'];
  h.profile.schedule.home_days.days = reverse ? [] : ['Wednesday','Friday'];
  h.profile.schedule.work_hours = Object.fromEntries((reverse ? israelDays : weekdays).map(d => [d, [reverse ? '09:00-18:00' : `${start}-17:00`]]));
  Object.assign(h.profile.meetings, { offered_slot_count: 8, buffer_minutes: 5, packing_preference: 'dense', thinking_time_min_chunk_minutes: 30, work_hours_per_free_hour: 4 });
  const attendee = {email:'peer@example.test', timezone:reverse ? boston : israel, homeTimezone:reverse ? boston : israel,
    week:regularWeek(reverse ? weekdays : israelDays, reverse ? start : '09:00', reverse ? '17:00' : '18:00')};
  const search = (from,to,extra={}) => h.find(from,to,{timezone:zone,durationMinutes:25,attendeeAvailability:[attendee],...extra});
  const pick = slots => h.load('src/connectors/graph/calendarReads.ts').pickSpreadSlots(slots,zone,8,undefined,25);
  return {...h,zone,attendee,search,pick};
}
for (const host of ['UTC','Asia/Tokyo','America/Los_Angeles']) for (const start of ['08:00','09:00']) for (const reverse of [false,true]) {
  test(`${host} ${start} ${reverse?'Israel owner':'Boston owner'} transition week bounds and earliest open overlap`, async () => {
    const previous = Settings.defaultZone;
    try {
      Settings.defaultZone = host;
      for (const date of ['2026-10-22','2026-10-26','2026-11-02']) {
        const h = fixture(start,reverse), from = DateTime.fromISO(date,{zone:h.zone}).startOf('day'), to = from.endOf('day');
        const slots = await h.search(from.toISO(),to.toISO());
        assert.ok(slots.length, date);
        const expected = DateTime.fromISO(`${date}T${start}`,{zone:boston});
        assert.equal(Date.parse(h.pick(slots)[0]),expected.toMillis(),date);
        for (const s of slots) {
          assert.equal(h.check(s.start,s.end).passes,true,JSON.stringify(s));
          assert.ok(h.load('src/utils/attendeeAvailability.ts').attendeeWorkSegmentsBetween(h.attendee,DateTime.fromISO(s.start),DateTime.fromISO(s.end)).every(x=>x.fitsWorkHours));
          assert.ok(Date.parse(s.start)>=from.toMillis() && Date.parse(s.end)<=to.toMillis());
        }
      }
    } finally { Settings.defaultZone = previous; }
  });
}
test('timezone database gives seven/six/seven-hour difference across the staggered transitions', () => {
  for (const [date,gap] of [['2026-10-24',7],['2026-10-25',6],['2026-10-31',6],['2026-11-01',7]]) {
    const instant=DateTime.fromISO(`${date}T09:00`,{zone:boston});
    assert.equal((instant.setZone(israel).offset-instant.offset)/60,gap);
  }
});
test('Friday and Sunday are not ordinary mutual availability in either direction', async () => {
  for (const reverse of [false,true]) for (const date of ['2026-10-23','2026-10-25','2026-10-30','2026-11-01']) {
    const h=fixture('08:00',reverse),from=DateTime.fromISO(date,{zone:h.zone});
    assert.equal((await h.search(from.toISO(),from.endOf('day').toISO())).length,0);
  }
});
test('prebooked Boston evening does not grant ordinary night availability', async () => {
  const busy=[{start:'2026-11-02T20:00:00-05:00',end:'2026-11-02T21:00:00-05:00',status:'busy'}];
  const h=fixture('08:00',false,busy);
  const slots=await h.search('2026-11-02T00:00:00-05:00','2026-11-03T00:00:00-05:00');
  assert.ok(slots.length);
  assert.ok(slots.every(s=>DateTime.fromISO(s.end).setZone(boston).hour<=17));
  assert.equal((await h.search('2026-11-02T19:00:00-05:00','2026-11-02T19:25:00-05:00')).length,0);
});
test('cross-midnight requests do not inherit the prior owner or attendee workday', async () => {
  for (const reverse of [false,true]) {
    const h=fixture('08:00',reverse);
    assert.equal((await h.search('2026-10-29T23:45:00-04:00','2026-10-30T00:10:00-04:00')).length,0);
  }
});
test('bounded week retains eight offers across every mutually viable day', async () => {
  const h=fixture('08:00'),slots=await h.search('2026-10-26T00:00:00-04:00','2026-10-31T00:00:00-04:00');
  const picked=h.pick(slots);
  assert.equal(picked.length,8);
  assert.deepEqual([...new Set(picked.map(s=>DateTime.fromISO(s).setZone(boston).weekday))].sort(),[1,2,3,4]);
  assert.ok(picked.every(s=>Date.parse(s)>=Date.parse('2026-10-26T00:00:00-04:00')&&Date.parse(s)<Date.parse('2026-10-31T00:00:00-04:00')));
});
test('Boston office days and neutral future venue propagate without changing meeting-mode rules', () => {
  const h=fixture('08:00'), resolve=h.load('src/utils/resolveLocation.ts',true).resolveLocation;
  h.profile.meetings.physical_meetings_require_office_day=true;
  h.profile.meetings.office_location={short_label:'Boston Fixture Office',full_label:'100 Fixture Avenue, Boston',meeting_room_label:'Boston Fixture Room'};
  const input={profile:h.profile,intent:'new_booking',participantCount:2,hasExternalAttendee:false};
  for(const date of ['2026-11-02','2026-11-03','2026-11-05']) {
    const start=`${date}T09:00:00-05:00`,end=`${date}T09:25:00-05:00`;
    assert.equal(h.check(start,end,{inPersonRequested:true}).passes,true);
    assert.equal(resolve({...input,startIso:start}).location,'Boston Fixture Office');
    assert.equal(resolve({...input,startIso:start,hasExternalAttendee:true,ownerIsOnlineHint:false}).location,'100 Fixture Avenue, Boston');
    const group=resolve({...input,startIso:start,participantCount:4});
    assert.equal(group.location,'Boston Fixture Room');assert.equal(group.addRoomEmail,true);assert.equal(group.isOnline,true);
    const remote=resolve({...input,startIso:start,anyParticipantRemote:true});
    assert.equal(remote.location,'');assert.equal(remote.isOnline,true);
  }
  for(const date of ['2026-11-04','2026-11-06']) {
    const start=`${date}T09:00:00-05:00`,end=`${date}T09:25:00-05:00`;
    assert.equal(h.check(start,end,{inPersonRequested:true}).passes,false);
    assert.equal(h.check(start,end,{inPersonRequested:false}).passes,true);
    assert.notEqual(resolve({...input,startIso:start}).location,'Boston Fixture Office');
  }
  // Wednesday in Jerusalem/UTC is still Tuesday in Boston. Location derives
  // from Boston's day; the ordinary hours validator separately rejects night.
  const instant='2026-11-04T01:00:00Z';
  assert.equal(resolve({...input,startIso:instant}).location,'Boston Fixture Office');
  assert.equal(h.check(instant,'2026-11-04T01:25:00Z').passes,false);
});
test('Boston configured travel padding rejects adjacency and preserves online control', async () => {
  const busy=[{start:'2026-11-03T10:00:00-05:00',end:'2026-11-03T10:25:00-05:00',status:'busy'}];
  const h=fixture('08:00',false,busy);
  const from='2026-11-03T09:30:00-05:00',to='2026-11-03T09:55:00-05:00';
  assert.equal((await h.search(from,to)).length,1);
  assert.equal((await h.search(from,to,{travelBufferMinutes:30})).length,0);
});
