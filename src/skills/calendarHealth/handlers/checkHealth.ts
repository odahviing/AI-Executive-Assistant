/**
 * handleCheckHealth — the `check_calendar_health` case body, extracted VERBATIM
 * from ../../calendarHealth.ts. No logic changes: relative import depth deepened
 * two levels, free vars (context/self/profile/userEmail/timezone) threaded via
 * OpCtx, and the single `this.executeToolCall` re-dispatch rewritten to
 * `self.executeToolCall` (self = the skill instance).
 */
import { DateTime } from 'luxon';
import {
  getCalendarEvents,
  type CalendarEvent,
  updateMeeting,
  findAvailableSlots,
} from '../../../connectors/graph/calendar';
import {
  getActiveCalendarIssues,
  buildClusters,
  upsertCluster,
  markStaleResolved,
  getSuppressedEventIds,
  dayLevelIssueSyntheticId,
  type DetectedIssue,
  type IssueClass,
} from '../../../db';
import logger from '../../../utils/logger';
import { displaySubject } from '../../../utils/displaySubject';
import { getEffectiveWorkDay } from '../../../utils/workHours';
import { classifyGap, densityConfigFromProfile, prefersDensePacking } from '../../../utils/calendarDensity';
import { parseGraphDt, classifyEventCategory } from '../classify';
import { revalidateActiveOverlapIssues, executeInternalAutoMove, pullInternalMeetingToAbut } from '../autoMove';
import type { HealthIssue } from '../types';
import type { OpCtx } from './context';

export async function handleCheckHealth(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, self, profile, userEmail, timezone } = ctx;
        // v2.1.4 — default window is owner-rule-driven (today → end of
        // workweek; extend 7 days when ≤24h left). Explicit args still
        // override. See utils/workHours.computeHealthCheckWindow.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { computeHealthCheckWindow } = require('../../../utils/workHours') as typeof import('../../../utils/workHours');
        const defaultWindow = computeHealthCheckWindow(profile);
        // #143b — a deterministic per-firing window from the calendar-health
        // routine (morning → today; 1PM → today + 4 weeks) OVERRIDES both Sonnet's
        // args and the default, so the autonomous sweep's scope can't drift.
        // Owner-asked / chat calls carry no override → behaviour unchanged.
        const forced = context.healthWindowOverride;
        const startDate = forced?.startDate ?? (args.start_date as string) ?? defaultWindow.startDate;
        const endDate = forced?.endDate ?? (args.end_date as string) ?? defaultWindow.endDate;
        // v2.1.1 — mode resolution. Explicit arg wins; else profile default.
        const mode: 'passive' | 'active' =
          (args.mode === 'active' || args.mode === 'passive')
            ? args.mode
            : (profile.behavior.calendar_health_mode ?? 'passive');

        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, startDate, endDate, timezone);
        } catch (err) {
          logger.error('Calendar health: failed to fetch events', { err });
          return { error: 'Failed to fetch calendar events.' };
        }

        const issues: HealthIssue[] = [];
        // v3.7.x (#139) — auto-fix MEMORY. Two owner-scoped reads, consulted by
        // the double_booking detector below so active mode never re-flags or
        // re-moves a clash the owner already settled:
        //   • dismissedEventIds — issues he dismissed/approved/resolved (a revert
        //     writes a dismissal). "If I said no, it's no."
        //   • recentlyAutoMovedIds — meetings I auto-moved in the last 12h. If a
        //     cleared clash is BACK, he reverted it (by hand or via
        //     revert_last_auto_move); re-moving is the exact "no memory" bug.
        const dismissedEventIds = getSuppressedEventIds(context.profile.user.slack_user_id);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const recentlyAutoMovedIds = (require('../../../db/requests') as typeof import('../../../db/requests'))
          .getRecentlyAutoMovedEventIds(context.profile.user.slack_user_id);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const protection = require('../../../utils/meetingProtection') as typeof import('../../../utils/meetingProtection');
        const floatingBlocks = fb.getFloatingBlocks(profile);
        const allWorkDays = [
          ...profile.schedule.office_days.days,
          ...profile.schedule.home_days.days,
        ] as string[];

        // v2.8.7 (bug 1.4) — skip the `missing_floating_block` issue entirely
        // on days the owner deliberately cleared, so detection never pushes
        // it (no narration, no auto-book, no daily skip-message). The check
        // lives in DETECTION, not just the auto-book path.
        //
        // v3.1.7 / #119 — suppression source switched from the audit_log
        // delete-meeting rows to the `calendar_issues` waived set. The audit
        // approach over-suppressed: a single delete row lacking event_start_iso
        // matched EVERY day in the window (`d.date === undefined`), so one
        // dateless "Lunch" delete silenced the whole forward week of lunch
        // detection for 14 days (the bug). The waived set is date-scoped via
        // the block's synthetic event_id — only the exact day(s) the owner
        // approved/deleted are suppressed.
        let waivedBlockGapIds: Set<string> = new Set();
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getWaivedFloatingBlockEventIds } = require('../../../db/calendarIssues') as typeof import('../../../db/calendarIssues');
          waivedBlockGapIds = getWaivedFloatingBlockEventIds(profile.user.slack_user_id);
        } catch (err) {
          logger.warn('Calendar health: waived-gap preload failed — detection will not suppress', {
            err: String(err).slice(0, 200),
          });
        }

        // Iterate through each day in range
        let cursor = DateTime.fromISO(startDate, { zone: timezone });
        const end = DateTime.fromISO(endDate, { zone: timezone });

        while (cursor <= end) {
          const dayStr = cursor.toFormat('yyyy-MM-dd');
          const dayName = cursor.toFormat('EEEE');

          if (!allWorkDays.includes(dayName)) {
            cursor = cursor.plus({ days: 1 });
            continue;
          }

          // Get events for this day
          const dayEvents = events.filter(e => {
            if (e.isCancelled) return false;
            const eventStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            return eventStart.toFormat('yyyy-MM-dd') === dayStr;
          });

          // v3.2.6 (6.3) — a FULL-DAY busy or OOF event (vacation / all-day
          // block) means the day is off or fully spoken for: don't flag a
          // missing floating block on it. The owner blocks vacation days; no
          // lunch is expected there.
          const fullDayBlocked = dayEvents.some(e =>
            e.isAllDay && !e.isCancelled && (e.showAs === 'oof' || e.showAs === 'busy'));

          // ── Missing floating blocks ──
          // Every block configured for the profile (lunch + any custom) is
          // checked independently. Only the ones that apply on this day-of-week
          // are in scope. A block is "missing" when no event on the calendar
          // matches it (subject regex OR category match, via the helper).
          // missing_floating_block scope follows the analyzer's overall
          // window (computeHealthCheckWindow — day-of-week aware: Mon-Wed
          // sees through end-of-this-week, Thursday sees Thursday + next
          // week). Owner direction: scope matches calendarHealth, not
          // today+tomorrow. The recentlyDeleted suppressor catches the
          // "owner just deleted this block on this day" case so a fresh
          // delete doesn't re-fire; future days where the block genuinely
          // hasn't been placed surface for the active-mode auto-book on
          // the day of.
          for (const block of floatingBlocks) {
            if (fullDayBlocked) break;  // v3.2.6 (6.3) — full-day busy/OOF: no lunch expected
            if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;
            const hasBlock = dayEvents.some(e => {
              if (e.isAllDay) return false;
              return fb.isFloatingBlockEvent(
                { subject: e.subject, categories: e.categories },
                block,
              );
            });
            if (!hasBlock) {
              // v3.1.7 / #119 — skip days the owner deliberately waived
              // (approved the gap via manage_calendar_issue, or deleted the
              // block on that day). Keyed to the exact day via the synthetic
              // event_id (floatingBlockSyntheticEventId — single source of
              // truth), so only that day is suppressed; future same-weekday
              // blocks still surface. The issue never enters issues[] → no
              // brief narration, no auto-book attempt.
              const synth = fb.floatingBlockSyntheticEventId(profile, block.name, dayStr, timezone);
              if (synth && waivedBlockGapIds.has(synth.eventId)) continue;
              // v3.7.x (#140) — don't flag a missing block whose booking window
              // has already closed for TODAY; offering to book a lunch at 13:01
              // when its window has passed only yields a past-dated auto-book.
              // Future days are unaffected (winEndMs > now), so the day-of
              // auto-book still fires normally.
              const winEndMs = fb.windowMsForDay(dayStr, block.preferred_end, timezone);
              if (Number.isFinite(winEndMs) && winEndMs <= DateTime.now().setZone(timezone).toMillis()) continue;
              issues.push({
                type: 'missing_floating_block',
                date: dayStr,
                description: `No ${block.name.replace(/_/g, ' ')} on ${dayName} ${dayStr}`,
                suggestion: `Book a ${block.duration_minutes}-minute ${block.name.replace(/_/g, ' ')} between ${block.preferred_start} and ${block.preferred_end}`,
                block_name: block.name,
              });
            }
          }

          // ── Double bookings (v2.1.1 — tagged with internal_only + movable_event_id) ──
          //
          // Filter to events that COUNT as work meetings for overlap purposes.
          // Anything outside that scope is the owner's life and shouldn't be
          // surfaced as a calendar issue. Exclusions (v3.0.3):
          //   1. all-day / showAs free / showAs workingElsewhere
          //   2. subject matches anything in profile.meetings.issue_exclusions.subjects
          //      (yaml-driven; replaces the v2.x hardcoded night_shift.blocking_event
          //       check — owner's "Home Time" now lives in this list and the same
          //       mechanism extends to any other silent subject)
          //   3. matches a configured floating block (lunch / coffee / gym /
          //      thinking-time / etc — elastic personal time, not work)
          //   4. entirely outside the day's work-hours window (Boot Camp 20:00-
          //      21:30 on a 10:30-19:00 office day, etc.)
          //   5. v3.0.3 — any of the event's categories matches a yaml category
          //      flagged `no_issue_tracking: true` (e.g. "Personal" category —
          //      owner's life, not work-tracking territory)
          // v2.8.1 — multi-window aware. workStart = earliest window start,
          // workEnd = latest window end on this day.
          // v3.7.x (#143) — hours from the date's effective work day so an
          // override (custom hours / day off) shapes the issue-detection
          // bounding box + its TEXT, not raw weekday yaml.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getEffectiveWorkDay: _getEff, formatMinuteOfDay: _fmtMin } = require('../../../utils/workHours') as
            typeof import('../../../utils/workHours');
          const wins = _getEff(dayStr, profile).windows;
          const dayHoursStart = wins.length > 0
            ? _fmtMin(wins[0].startMin)
            : '09:00';
          const dayHoursEnd = wins.length > 0
            ? _fmtMin(wins[wins.length-1].endMin)
            : '19:00';
          const dayWorkStart = DateTime.fromISO(`${dayStr}T${dayHoursStart}`, { zone: timezone });
          const dayWorkEnd = DateTime.fromISO(`${dayStr}T${dayHoursEnd}`, { zone: timezone });
          const exclSubjects = (profile.meetings.issue_exclusions?.subjects ?? [])
            .map(s => s.toLowerCase()).filter(s => s.length > 0);
          const noTrackCategories = new Set(
            (profile.categories ?? [])
              .filter(c => c.no_issue_tracking === true)
              .map(c => c.name),
          );

          const nonAllDay = dayEvents.filter(e => {
            if (e.isAllDay) return false;
            if (e.showAs === 'free' || e.showAs === 'workingElsewhere') return false;
            // Exclusion 2: yaml-driven subject silence list
            const subjLower = (e.subject ?? '').toLowerCase();
            if (exclSubjects.some(s => subjLower.includes(s))) return false;
            // Exclusion 3: any configured floating block
            const matchesAnyBlock = floatingBlocks.some(b =>
              fb.isFloatingBlockEvent(
                { subject: e.subject, categories: e.categories },
                b,
              ),
            );
            if (matchesAnyBlock) return false;
            // Exclusion 5: yaml category flagged no_issue_tracking
            const eCats = e.categories ?? [];
            if (eCats.some(c => noTrackCategories.has(c))) return false;
            // Exclusion 4: entirely outside work-hours (start >= workEnd OR end <= workStart)
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            if (eStart >= dayWorkEnd || eEnd <= dayWorkStart) return false;
            return true;
          });
          for (let i = 0; i < nonAllDay.length; i++) {
            const a = nonAllDay[i];
            const aStart = parseGraphDt(a.start.dateTime, a.start.timeZone, timezone);
            const aEnd = parseGraphDt(a.end.dateTime, a.end.timeZone, timezone);
            for (let j = i + 1; j < nonAllDay.length; j++) {
              const b = nonAllDay[j];
              const bStart = parseGraphDt(b.start.dateTime, b.start.timeZone, timezone);
              const bEnd = parseGraphDt(b.end.dateTime, b.end.timeZone, timezone);

              if (aStart < bEnd && aEnd > bStart) {
                // v3.7.x (#139) — auto-fix memory: skip a pair the owner already
                // settled. (a) dismissed/approved/resolved → he told us to leave
                // it. (b) I auto-moved one side in the last 12h and the clash is
                // BACK → he reverted it; re-detecting would re-move it (the "no
                // memory" bug). Either way don't re-flag or re-move. Occurrence-
                // anchored via event ids; other occurrences still surface.
                if (
                  dismissedEventIds.has(a.id) || dismissedEventIds.has(b.id)
                  || recentlyAutoMovedIds.has(a.id) || recentlyAutoMovedIds.has(b.id)
                ) {
                  continue;
                }
                // Protection assessment for both sides + internal-only check
                const aProt = protection.isProtected(a, profile);
                const bProt = protection.isProtected(b, profile);
                const bothInternal = !aProt.reasons.includes('has external attendee')
                  && !bProt.reasons.includes('has external attendee');
                const pick = protection.pickMovableSide(a, b, profile);

                // v2.7.4 — mask private subjects in issue descriptions so the
                // brief / coord DMs / shadow notes don't leak.
                const aDisp = displaySubject(a, profile);
                const bDisp = displaySubject(b, profile);
                // Dismissal fingerprint anchors on the OCCURRENCE id, not
                // seriesMasterId. Owner direction: when a different occurrence
                // of the same recurring event overlaps with something new, that
                // IS worth re-flagging — the prior dismissal was for one
                // specific pair, not a blanket rule for the series. Personal-
                // category events are skipped from the detector entirely
                // (exclusion 5 above); recurring non-personal overlaps flag
                // per occurrence as intended.
                issues.push({
                  type: 'double_booking',
                  date: dayStr,
                  description: `"${aDisp}" (${aStart.toFormat('HH:mm')}-${aEnd.toFormat('HH:mm')}) overlaps with "${bDisp}" (${bStart.toFormat('HH:mm')}-${bEnd.toFormat('HH:mm')})`,
                  eventIds: [a.id, b.id],
                  suggestion: pick
                    ? `Propose moving "${displaySubject(pick.movable, profile)}" — the less-protected side. The other meeting is protected (${(pick.movable === a ? bProt : aProt).reasons.join(', ')}).`
                    : 'Both sides are protected — the owner needs to decide which to move.',
                  internal_only: bothInternal,
                  movable_event_id: pick?.movable.id,
                  kept_event_id: pick?.kept.id,
                  protection_reasons: pick ? (pick.movable === a ? bProt : aProt).reasons : [...aProt.reasons, ...bProt.reasons],
                });
              }
            }
          }

          // ── #133 — efficient-calendar dead gaps (dense packing only) ────────
          // A gap between two consecutive meetings too long to be back-to-back
          // but too short to be a real break (6–29 min) is dead time. Flag it
          // with the LATER meeting as the movable side IF it's internal +
          // unprotected + not already settled — the active-fix loop pulls it
          // back-to-back with the earlier meeting (earlier is always better).
          // Non-dense tenants: skipped entirely.
          if (prefersDensePacking(profile.meetings)) {
            const densCfg = densityConfigFromProfile(profile.meetings);
            const sortedDay = [...nonAllDay].sort((x, y) =>
              parseGraphDt(x.start.dateTime, x.start.timeZone, timezone).toMillis()
              - parseGraphDt(y.start.dateTime, y.start.timeZone, timezone).toMillis());
            for (let i = 0; i < sortedDay.length - 1; i++) {
              const a = sortedDay[i];
              const b = sortedDay[i + 1];
              const aEnd = parseGraphDt(a.end.dateTime, a.end.timeZone, timezone);
              const bStart = parseGraphDt(b.start.dateTime, b.start.timeZone, timezone);
              const gapMin = (bStart.toMillis() - aEnd.toMillis()) / 60000;
              if (gapMin <= 0) continue;                       // overlap → double_booking owns it
              if (classifyGap(gapMin, densCfg) !== 'dead') continue;
              if (dismissedEventIds.has(b.id) || recentlyAutoMovedIds.has(b.id)) continue;
              const bProt = protection.isProtected(b, profile);
              if (bProt.protected || bProt.reasons.includes('has external attendee')) continue;
              const aDisp = displaySubject(a, profile);
              const bDisp = displaySubject(b, profile);
              issues.push({
                type: 'inefficient_gap',
                date: dayStr,
                description: `${Math.round(gapMin)}-min dead gap between "${aDisp}" (ends ${aEnd.toFormat('HH:mm')}) and "${bDisp}" (starts ${bStart.toFormat('HH:mm')})`,
                eventIds: [a.id, b.id],
                suggestion: `Pull "${bDisp}" back-to-back after "${aDisp}" — internal, so its attendees just need to be free earlier.`,
                internal_only: true,
                movable_event_id: b.id,
                kept_event_id: a.id,
              });
            }
          }

          // ── OOF conflicts ──────────────────────────────────────────────────
          // v2.3.1 (B16) — trust showAs only. Owner pushed back on keyword
          // matching: if an event is marked SHOW AS FREE in Outlook, it's
          // free regardless of subject text. Previous logic let an all-day
          // event with subject containing "vacation"/"oof"/"holiday"/"pto"
          // upgrade to OOF even when showAs=free, generating false conflicts
          // for every meeting on that day. Only Outlook's explicit OOF
          // status counts now.
          const oofEvents = dayEvents.filter(e => e.showAs === 'oof');
          if (oofEvents.length > 0) {
            const ownerEmailLower = profile.user.email.toLowerCase();
            // v2.8.7 (bug 1.1) — skip owner-only events. A solo meeting on
            // the owner's OWN OOF day is intentional personal time (e.g.
            // "Bookcamp" during his Holiday Block), not a conflict to flag.
            // Solo := no attendees, OR every attendee is the owner himself.
            // Same shape downstream auto-move already filters by (state.ts
            // returns 'no_participants' when coordParticipants is empty),
            // but here we stop the detection from firing at all so the
            // brief doesn't see a phantom "clash" issue either.
            const isSoloOwnerEvent = (e: typeof nonAllDay[number]): boolean => {
              const att = e.attendees ?? [];
              if (att.length === 0) return true;
              return att.every(a =>
                (a.emailAddress?.address ?? '').toLowerCase() === ownerEmailLower
              );
            };
            // v2.9.2 — also skip events the owner has explicitly locked as
            // unmovable in yaml (`profile.meetings.protected[]` with
            // `movable: false`). When the owner has marked something as
            // never-move (e.g. "Bookcamp" — solo-but-intentional during
            // Holiday Block), the oof_conflict flag is noise — he placed it
            // there on purpose.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { isYamlLockedUnmovable } = require('../../../utils/meetingProtection') as
              typeof import('../../../utils/meetingProtection');
            const meetings = nonAllDay.filter(e =>
              (e.showAs === 'busy' || e.showAs === 'tentative')
              && !isSoloOwnerEvent(e)
              && !isYamlLockedUnmovable(e, profile),
            );
            for (const meeting of meetings) {
              const mStart = parseGraphDt(meeting.start.dateTime, meeting.start.timeZone, timezone);
              issues.push({
                type: 'oof_conflict',
                date: dayStr,
                description: `"${meeting.subject}" at ${mStart.toFormat('HH:mm')} is scheduled on a day marked OOF/vacation`,
                eventIds: [meeting.id],
                suggestion: 'Decline or reschedule this meeting — you are out of office',
              });
            }
          }

          // ── Missing categories ─────────────────────────────────────────────
          for (const e of nonAllDay) {
            if (!e.categories || e.categories.length === 0) {
              issues.push({
                type: 'missing_category',
                date: dayStr,
                description: `"${e.subject}" has no category`,
                eventIds: [e.id],
                suggestion: profile.categories && profile.categories.length > 0
                  ? `Add a category — choose from ${profile.categories.map(c => c.name).join(', ')}`
                  : 'Add a category to organize this event',
              });
            }
          }

          // ── Busy day (v2.1.1) ──────────────────────────────────────────────
          // Three signals — any ONE triggers. Tuned so a "rough Thursday"
          // with 6+ meetings, sub-threshold free time, or no 30-min block
          // gets surfaced to the owner. Thresholds read from profile where
          // they already exist; defaults inline for the rest.
          {
            const isOffice = (profile.schedule.office_days.days as string[]).includes(dayName);

            // v2.8.7 (bug 1.3) — per-window aware. Pre-fix (v2.8.1 multi-
            // window introduction) used a bounding-box approach: clip busy
            // intervals to [first.start, last.end] then merge. On split-shift
            // days that bounding box INCLUDES the gap between windows, so a
            // meeting between 15:30 and 21:30 (Tuesday's mid-day off-stretch
            // for Idan) got counted as busy AND the inter-window gap also
            // counted as "free", producing the impossible "0 free time +
            // 110-min gap" narration on 2026-05-19. The fix walks each
            // window separately and aggregates.
            // v3.7.x (#143) — windows from the date's effective work day so an
            // override (custom hours / day off) drives the busy-day free-time
            // math, not raw weekday yaml.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getEffectiveWorkDay, totalWorkMinutes } = require('../../../utils/workHours') as
              typeof import('../../../utils/workHours');
            const windows = getEffectiveWorkDay(dayStr, profile).windows;
            const fallbackWindows = windows.length > 0
              ? windows
              : [{ startMin: 9 * 60, endMin: 18 * 60 }];
            const workTotalMin = totalWorkMinutes(fallbackWindows);
            // bug 1.13 — length-based free-time floor via the shared helper (one
            // source of truth with analyze_calendar + checkSlot rule 9).
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { requiredFreeMinutesForWorkDay } = require('../../../utils/scheduleRules') as typeof import('../../../utils/scheduleRules');
            const freeTimeThresholdMin = requiredFreeMinutesForWorkDay(workTotalMin, profile.meetings.work_hours_per_free_hour);

            // Parse busy events ONCE; per-window calc reuses these.
            const allBusy = nonAllDay
              .filter(e => e.showAs !== 'workingElsewhere')
              .map(e => {
                const s = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
                const en = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
                return {
                  start: s.hour * 60 + s.minute,
                  end: en.hour * 60 + en.minute,
                };
              })
              .filter(b => b.end > b.start);

            // Walk each window: clip busy to THIS window only, merge, compute
            // window-local busy total and longest gap. Aggregate across windows.
            let totalBusyInWork = 0;
            let longestGap = 0;
            for (const w of fallbackWindows) {
              const inWindow = allBusy
                .map(b => ({
                  start: Math.max(b.start, w.startMin),
                  end: Math.min(b.end, w.endMin),
                }))
                .filter(b => b.end > b.start)
                .sort((a, b) => a.start - b.start);

              const merged: Array<{ start: number; end: number }> = [];
              for (const b of inWindow) {
                if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
                  merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
                } else {
                  merged.push({ ...b });
                }
              }
              totalBusyInWork += merged.reduce((sum, m) => sum + (m.end - m.start), 0);

              // Longest free segment INSIDE this window only.
              let prev = w.startMin;
              for (const m of merged) {
                longestGap = Math.max(longestGap, m.start - prev);
                prev = m.end;
              }
              longestGap = Math.max(longestGap, w.endMin - prev);
            }
            const freeMin = Math.max(0, workTotalMin - totalBusyInWork);

            // v2.5.6 (re-enabled) — busy_day flagging restored. Was removed
            // in v2.3.1 (#67) per prior owner direction; reversed in 2026-05
            // after a real-world test where almost every office day was under
            // the focus target and the owner never heard about it. Fires on a
            // single signal: total free time during work hours falls below the
            // length-based floor (requiredFreeMinutesForWorkDay — bug 1.13, the
            // same source of truth as analyze_calendar + checkSlot rule 9).
            // Pure report-only — no auto-fix; owner decides which meeting to
            // move. The longestGap value rides along in the issue payload so
            // Sonnet can narrate honest detail without recomputing.
            if (freeTimeThresholdMin > 0 && freeMin < freeTimeThresholdMin) {
              const dayLabel = cursor.toFormat('EEEE d MMMM');
              const freeHrs = (freeMin / 60).toFixed(1);
              const targetHrs = (freeTimeThresholdMin / 60).toFixed(1);
              issues.push({
                type: 'busy_day',
                date: cursor.toISODate() ?? '',
                // v3.5.x — stable anchor so the row materializes and can be
                // approved/suppressed (busy_day has no real event_id).
                synthetic_id: dayLevelIssueSyntheticId('busy_day', cursor.toISODate() ?? ''),
                description: `${dayLabel} has only ${freeMin} min of free time during work hours (under your ${targetHrs}h free-time target for the day). Longest single block: ${longestGap} min.`,
                free_minutes: freeMin,
                longest_gap_minutes: longestGap,
                threshold_minutes: freeTimeThresholdMin,
                is_office_day: isOffice,
              });
            }
            void nonAllDay;
          }

          cursor = cursor.plus({ days: 1 });
        }

        // v2.6 — category limit detection. Walk all configured categories with
        // limits.per_day / limits.per_week and flag windows that exceed.
        // Report-only; active mode doesn't auto-resolve (which interview gets
        // bumped is a judgment call only the owner can make).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { findCategoryViolations } = require('../../../utils/categoryRules') as
            typeof import('../../../utils/categoryRules');
          const allEvents = events;  // already in scope, full range fetch
          const rangeStart = DateTime.fromISO(startDate, { zone: timezone }).startOf('day');
          const rangeEnd = DateTime.fromISO(endDate, { zone: timezone }).endOf('day');
          const violations = findCategoryViolations({
            events: allEvents,
            profile,
            rangeStart,
            rangeEnd,
          });
          for (const v of violations) {
            const window = v.rule_broken === 'per_day' ? 'on' : 'in the';
            issues.push({
              type: 'category_limit_exceeded',
              date: v.window_start,
              description: `${v.category_name} ${v.rule_broken.replace('_', '-')} limit exceeded — ${v.current_count}/${v.rule_value} ${window} ${v.window_label}`,
              eventIds: v.event_ids,
              category_name: v.category_name,
              rule_broken: v.rule_broken,
              rule_value: v.rule_value,
              current_count: v.current_count,
            });
          }
        } catch (err) {
          logger.warn('analyze_calendar — category violation pass threw, skipping', {
            err: String(err).slice(0, 200),
          });
        }

        // Dedup: one entry per (type, sorted event-pair). Belt-and-suspenders
        // against the same conflict appearing under multiple detection paths.
        const seen = new Set<string>();
        const dedupedIssues: HealthIssue[] = [];
        for (const issue of issues) {
          const ids = [...(issue.eventIds ?? [])].sort().join('|');
          const key = `${issue.type}:${issue.date}:${ids}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedupedIssues.push(issue);
        }
        issues.length = 0;
        issues.push(...dedupedIssues);

        // v3.0.3 — suppression + write moved AFTER the active-mode fix loop.
        // Pre-write filtering against terminal rows is handled by upsertCluster's
        // 'suppressed' return; legacy dismissed-key filter retired. Auto-fix
        // success (active mode) → no row needed (audit_log carries it). Only
        // un-fixed issues land on the table. See cluster-based write block
        // below the fix loop.
        const ownerUserId = profile.user.slack_user_id;
        let newIssueCount = 0;

        // Include any active (unresolved) issues from previous checks — but
        // re-validate overlap rows against the live calendar first, so a stale
        // one (owner moved the event in Outlook, date outside the health window)
        // is resolved instead of surfaced. Fail-safe: keeps the row on any error.
        const activeIssues = await revalidateActiveOverlapIssues(
          getActiveCalendarIssues(ownerUserId), profile.user.email, profile.user.timezone,
        );

        // Active-mode fix loop. Runs ONLY when mode='active'. Each fix is
        // deterministic or high-confidence; failures fail open (the issue
        // stays flagged, fix_failed=true). Fixes covered:
        //   - missing_floating_block → book the block
        //   - missing_category → set category when classifier is high-conf
        //   - oof_conflict → move-coord for non-protected meetings
        //   - double_booking → direct floating-block move (Path a) OR
        //     move-coord on the movable side (Path b)
        //   - busy_day → DM the owner with candidates to move (no auto-move)
        let fixesApplied = 0;
        // v2.6.5 — internal_actions surfaces active-mode auto-fixes back up
        // through the tool result so the claim-checker can see them. Without
        // this, Sonnet's draft "I auto-fixed lunch on Tuesday" would be
        // flagged as a hallucination because the claim-checker only sees the
        // top-level tool (`check_calendar_health`), not the internal
        // book_floating_block / updateMeeting calls. The orchestrator's
        // summary-builder pushes each entry into toolCallSummaries.
        const internalActions: Array<{ tool: string; detail: string }> = [];
        if (mode === 'active') {
          logger.info('Calendar health: active mode — running fix loop', {
            ownerUserId, startDate, endDate, issueCount: issues.length,
          });
          // v3.7.x (#143) — DON'T auto-fix on a per-date override day (day off,
          // custom hours, office/home flip, or a travel/away day). The override
          // reshapes the day, so auto-adding lunch or auto-resolving on it is
          // exactly the harm the old WE suppressor prevented — now generalized to
          // EVERY override (no floating blocks on ANY override day, owner rule).
          for (const issue of issues) {
            try {
              if (getEffectiveWorkDay(issue.date, profile).hasOverride) {
                logger.info('Calendar health: skipping auto-fix on schedule-override day', {
                  date: issue.date, type: issue.type,
                });
                continue;
              }
              if (issue.type === 'missing_floating_block') {
                // v3.1.7 / #119 — no suppression check here. Days the owner
                // waived (approved gap, or deleted the block that day) are
                // skipped at DETECTION via the waivedBlockGapIds set, so a
                // suppressed gap never reaches this auto-book loop. The old
                // audit-log delete check that lived here (and at detection)
                // is gone — replaced by the date-scoped calendar_issues set.
                // Reuse book_floating_block so alignment + buffer + day-scope
                // rules apply consistently. Pass the block_name from the
                // issue (set by the detector loop above) — the handler now
                // requires it explicitly, no implicit "lunch" fallback.
                const result = await self.executeToolCall(
                  'book_floating_block',
                  { date: issue.date, block_name: issue.block_name },
                  context,
                ) as { ok?: boolean; created?: boolean; start?: string; end?: string; error?: string; message?: string } | null;
                if (result?.ok && result.created) {
                  issue.fixed = true;
                  issue.fix_detail = `Booked ${issue.block_name ?? 'floating block'} ${issue.date} ${result.start}–${result.end}.`;
                  fixesApplied += 1;
                  internalActions.push({
                    tool: 'book_floating_block',
                    detail: `${issue.block_name ?? 'floating block'} ${issue.date} ${result.start}–${result.end}`,
                  });
                } else if (result?.error) {
                  issue.fix_failed = true;
                  issue.fix_error = result.message ?? result.error;
                }
              } else if (issue.type === 'missing_category' && profile.categories && profile.categories.length > 0 && issue.eventIds && issue.eventIds[0]) {
                // High-confidence Sonnet classifier. If confidence isn't
                // high, skip — we'd rather under-tag than mis-tag.
                const eventId = issue.eventIds[0];
                const event = events.find(e => e.id === eventId);
                if (event) {
                  const picked = await classifyEventCategory(event, profile);
                  if (picked) {
                    await updateMeeting({
                      userEmail, meetingId: eventId,
                      categories: [picked],
                      timezone,
                    });
                    issue.fixed = true;
                    issue.fix_detail = `Tagged "${event.subject}" as ${picked}.`;
                    fixesApplied += 1;
                    internalActions.push({
                      tool: 'set_event_category',
                      detail: `Tagged "${event.subject}" as ${picked}`,
                    });
                  }
                }
              }
              // busy_day: no fix action in-tool — the owner needs to decide
              // which meeting to move. A separate DM already fires below
              // (batched) so this issue stays in the returned list for narration.
              else if (issue.type === 'oof_conflict' && issue.eventIds && issue.eventIds[0]) {
                // v2.1.1 — surprise-vacation handling. When an OOF day has
                // meetings scheduled BEFORE the vacation, the non-protected
                // ones get moved out automatically (1:1s, small internal
                // groups). Protected meetings (≥4 attendees / external /
                // rule-matched) stay flagged for the owner. Same pattern
                // as double_booking path (b) — internal-only coord with
                // the meeting's attendees, move-intent.
                try {
                  const conflictingId = issue.eventIds[0];
                  const conflicting = events.find(e => e.id === conflictingId);
                  if (!conflicting) {
                    // Event vanished between detection and fix — skip.
                  } else {
                    const prot = protection.isProtected(conflicting, profile);
                    if (prot.protected) {
                      // Leave it for the owner — this is the "10-person
                      // meeting on a surprise vacation" case.
                      issue.protection_reasons = prot.reasons;
                    } else {
                      // v3.4.x — the multi-party move-coord auto-fix was removed
                      // with the coord subsystem. We no longer poll attendees to
                      // reschedule the OOF-day meeting automatically. Leave the
                      // issue SURFACED so the owner can direct the move himself
                      // (move_meeting, or message the attendee directly).
                    }
                  }
                } catch (err) {
                  issue.fix_failed = true;
                  issue.fix_error = `OOF auto-fix check failed: ${String(err).slice(0, 200)}`;
                  logger.warn('OOF auto-fix check failed', {
                    issueDate: issue.date, err: String(err).slice(0, 300),
                  });
                }
              }
              else if (
                issue.type === 'double_booking'
                && issue.movable_event_id
                && issue.kept_event_id
              ) {
                // v2.1.1 — overlap with a clear movable side. Two paths:
                //   (b) Movable side is a regular internal-only meeting
                //       with attendees → MOVE-COORD: DM the attendees,
                //       propose slots, moveMeeting on their agreement.
                //   (c) Protected (4+ / external / rule-matched) or
                //       external-attendee on either side → skip entirely,
                //       report to owner.
                //
                // v2.9.3 (#104) — Path (a) (floating-block direct move from a
                // double_booking issue) deleted. It was unreachable: the
                // double_booking detector excludes floating blocks from its
                // pair-overlap scan (Exclusion 3 at the nonAllDay filter), so
                // no issue with movable=floating-block was ever produced. The
                // periodic rebalance sweep below the issue-loop now handles
                // every floating-block overlap on the day, regardless of how
                // the conflicting meeting was booked.
                try {
                  const movable = events.find(e => e.id === issue.movable_event_id);
                  const kept = events.find(e => e.id === issue.kept_event_id);
                  if (movable && kept) {
                    // ── Path (b): regular move-coord ──
                    // Gate on the MOVABLE side only — does the meeting we're
                    // about to move have any external attendees? If not, we
                    // can move-coord it (DM its internal attendees, propose
                    // slots, updateMeeting on agreement). The KEPT side's
                    // externals are exactly WHY it's kept; they don't block
                    // moving the OTHER side. Prior gate `issue.internal_only`
                    // (both-sides-internal) was too strict — for an
                    // internal-vs-external overlap, internal_only=false but
                    // the internal side is still freely movable. #76 surfaced
                    // this: Elan (internal) overlapped Gilly (external) and
                    // active mode silently skipped instead of moving Elan.
                    const movableHasExternal = protection.isProtected(movable, profile)
                      .reasons.includes('has external attendee');
                    if (movableHasExternal) {
                      // Movable side itself has externals — move-coord would
                      // need their say-so, which is owner-decision territory.
                      continue;
                    }
                    // v3.2.6 (Part C) — idempotency: if a move notice for THIS
                    // event is already open (awaiting the colleague), don't move
                    // + notify again on a later run. The direct move usually
                    // self-resolves the overlap, but this guards the window
                    // before the colleague replies (and a revert→re-detect race).
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const { getDb } = require('../../../db') as typeof import('../../../db');
                      const inflight = getDb().prepare(
                        `SELECT 1 FROM outreach_jobs WHERE owner_user_id = ? AND intent = 'meeting_reschedule'
                           AND status = 'sent' AND context_json LIKE ? LIMIT 1`,
                      ).get(ownerUserId, `%${movable.id}%`);
                      if (inflight) {
                        logger.info('Overlap autofix — move notice for this event already open; skipping', { movableId: movable.id });
                        continue;
                      }
                    } catch (err) {
                      logger.warn('Overlap idempotency check threw — proceeding', { err: String(err).slice(0, 160) });
                    }
                    const mStart = parseGraphDt(movable.start.dateTime, movable.start.timeZone, timezone);
                    const mEnd = parseGraphDt(movable.end.dateTime, movable.end.timeZone, timezone);
                    const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);

                    // Find fresh slots to propose.
                    // v2.7.4 — only filter out 'declined'. Per Microsoft Graph
                    // docs, 'none' is the default response status — attendees
                    // who haven't been tracked yet (common when YOU organized
                    // and they haven't accepted). Outlook's "Didn't respond"
                    // UI label maps to 'none' AND 'notResponded'; both should
                    // KEEP the attendee for downstream coord/move logic.
                    const participantsRaw = (movable.attendees ?? []).filter(a => {
                      const status = a.status?.response;
                      return status !== 'declined';
                    });
                    const attendeeEmails = participantsRaw
                      .map(a => a.emailAddress.address)
                      .filter(Boolean);

                    // v2.1.4 — cadence-aware search window. For recurring
                    // occurrences, cap `searchTo` at the next instance of
                    // the same series (exclusive) — moving Brett's biweekly
                    // forward past the next biweekly would duplicate the
                    // cadence. For non-recurring meetings, use the legacy
                    // +2 days window. Fail-open: if the series lookup fails,
                    // proceed with default window (safer to propose than to
                    // stall silently).
                    const searchFrom = DateTime.fromISO(issue.date, { zone: timezone }).startOf('day').toUTC().toISO()!;
                    let searchTo = DateTime.fromISO(issue.date, { zone: timezone }).plus({ days: 2 }).endOf('day').toUTC().toISO()!;
                    const movableSeriesId = (movable as unknown as { seriesMasterId?: string }).seriesMasterId;
                    if (movableSeriesId) {
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const cal = require('../../../connectors/graph/calendar') as typeof import('../../../connectors/graph/calendar');
                      const nextInstance = await cal.getNextSeriesOccurrenceAfter(
                        userEmail, movableSeriesId, mStart.toUTC().toISO()!,
                      );
                      if (nextInstance) {
                        // Cap at 1 minute before the next instance — strict
                        // exclusion so the slot search can't land on the
                        // same moment as the next cadence firing.
                        const capped = DateTime.fromISO(nextInstance).minus({ minutes: 1 }).toUTC().toISO()!;
                        // Only apply the cap if it's EARLIER than the
                        // default window. If the next occurrence is far out
                        // (single non-recurring or rare cadence), keep the
                        // narrow default.
                        if (capped < searchTo) searchTo = capped;
                        logger.info('Overlap move-coord: capped search at next series occurrence', {
                          movableId: movable.id, seriesMasterId: movableSeriesId,
                          originalSearchTo: searchTo, nextInstance, capped,
                        });
                      }
                    }
                    // v3.2.6 (Part A) — keep the move within the SAME week as the
                    // conflict (owner direction: don't push it to next week).
                    // Clamp searchTo to the end of the conflict's week (Sun–Sat,
                    // owner-local). If nothing's free in-week, surface to the owner.
                    const conflictDt = DateTime.fromISO(issue.date, { zone: timezone });
                    const weekEndIso = conflictDt.minus({ days: conflictDt.weekday % 7 }).plus({ days: 6 }).endOf('day').toUTC().toISO()!;
                    if (weekEndIso < searchTo) searchTo = weekEndIso;

                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { attendeeCheckParams } = require('../../../utils/attendeeAvailability') as typeof import('../../../utils/attendeeAvailability');
                    const slots = await findAvailableSlots({
                      userEmail,
                      timezone,
                      durationMinutes: durationMin,
                      // Check the attendees fully — never move the clash onto a time they're
                      // busy OR outside their (cross-TZ) work hours.
                      ...attendeeCheckParams(attendeeEmails, userEmail),
                      searchFrom,
                      searchTo,
                      // Don't auto-widen past the intended 2-day / week-clamped window
                      // (autoExpand's +7-day widening defeated the week-clamp and pushed
                      // clash-fixes into the NEXT week). Nothing free in-window → surface.
                      autoExpand: false,
                      profile,
                    });
                    // v3.2.6 (RC1) — prefer a slot that leaves floating blocks
                    // (lunch) untouched. Only displace a block when NO
                    // non-disturbing slot is free this week. This stops the
                    // "moved Eli onto lunch at 12:45, then shoved lunch to
                    // 13:30" damage — a free post-lunch slot wins over the
                    // earliest-but-lunch-colliding one.
                    const top = slots.find(s => !s.disturbs_floating_block) ?? slots[0];
                    if (!top) {
                      // v3.2.6 (Part A) — no in-week slot free for everyone. Per
                      // owner direction: do NOT push to next week — return it to him.
                      issue.fix_failed = true;
                      issue.fix_error = 'No slot free for everyone this week — left for you (move it yourself, or tell me to look next week).';
                    } else {
                      // v3.2.6 (Part A) — the movable meeting is internal-only
                      // (external attendees were gated out above) and `top` is a
                      // slot verified free for the owner + all attendees, IN-WEEK.
                      // MOVE IT DIRECTLY (owner authority, active mode), then notify
                      // the attendee(s) with a pushback escape hatch. No coord, no
                      // waiting, no orphan.
                      // v3.7.x (#133) — the move + record + notify + shadow now lives
                      // in the shared executeInternalAutoMove (defrag reuses the SAME
                      // path). double_booking supplies its clash reason + verb + the
                      // target slot it found above.
                      const conflictReason = protection.sanitizeConflictReason(kept, profile.user.name.split(' ')[0], profile);
                      await executeInternalAutoMove({
                        movable, origStart: mStart, origEnd: mEnd, durationMin,
                        newStartIso: top.start, participantsRaw, conflictReason,
                        moveVerb: 'to clear the clash',
                        keptEventId: issue.kept_event_id,
                        issue, userEmail, ownerUserId, timezone, profile, context, internalActions,
                      });
                      if (issue.fixed) fixesApplied += 1;
                    }
                  }
                } catch (err) {
                  issue.fix_failed = true;
                  issue.fix_error = `Move-coord init failed: ${String(err).slice(0, 200)}`;
                  logger.warn('Move-coord for internal overlap failed', {
                    issueDate: issue.date, err: String(err).slice(0, 300),
                  });
                }
              }
              else if (
                issue.type === 'inefficient_gap'
                && issue.movable_event_id && issue.kept_event_id
              ) {
                // #133 — defrag: pull the movable (later, internal) meeting
                // back-to-back with the earlier one, via the shared abut helper
                // (also used by the #133c lunch-anchored fallback). Anchor = the
                // earlier MEETING's end. Moves only if a slot free for the
                // movable's attendees exists there AND it doesn't just shift the
                // dead gap onto the next meeting.
                try {
                  const movable = events.find(e => e.id === issue.movable_event_id);
                  const kept = events.find(e => e.id === issue.kept_event_id);
                  if (movable && kept) {
                    const mvProt = protection.isProtected(movable, profile);
                    if (mvProt.protected || mvProt.reasons.includes('has external attendee')) {
                      // Not ours to move — leave it surfaced for the owner.
                    } else {
                      const keptEnd = parseGraphDt(kept.end.dateTime, kept.end.timeZone, timezone);
                      await pullInternalMeetingToAbut({
                        movable, keptEndDt: keptEnd, keptEventId: issue.kept_event_id,
                        moveVerb: 'to pack it back-to-back after your prior meeting',
                        conflictReason: 'packing the day tighter',
                        dayEventsForBusy: events, issue,
                        userEmail, ownerUserId, timezone, profile, context, internalActions,
                      });
                      if (issue.fixed) fixesApplied += 1;
                    }
                  }
                } catch (err) {
                  issue.fix_failed = true;
                  issue.fix_error = `Defrag move failed: ${String(err).slice(0, 200)}`;
                  logger.warn('inefficient_gap auto-fix failed', { issueDate: issue.date, err: String(err).slice(0, 300) });
                }
              }
              // Other overlap cases (both protected, external, unclear
              // movable side): intentionally unhandled — fall through to the
              // passive report path so the owner decides.
            } catch (err) {
              issue.fix_failed = true;
              issue.fix_error = String(err).slice(0, 300);
              logger.warn('Calendar health active-mode fix threw', {
                issueType: issue.type, date: issue.date, err: String(err).slice(0, 300),
              });
            }
          }

          // v2.3.1 (B12 / #67) — busy_day DM removed per owner direction.
          // He never asked for "rough day" alerts and they were firing
          // unsolicited. Active mode now only handles conflict / OOF /
          // missing-block / buffer issues.

          // v2.9.3 (#104) — periodic floating-block rebalance sweep. The
          // mutation-time hook (rebalanceFloatingBlocksAfterMutation in
          // meetings/ops.ts + coord/booking.ts) only fires when Maelle
          // herself booked or moved a meeting via her own tools. Events
          // added in Outlook directly never trigger it, leaving lunch (or
          // any floating block) sitting on top of a meeting until owner
          // notices. Active-mode runs twice a day; iterating each date in
          // the health window and calling the helper catches Outlook-direct
          // entries before the next brief. The helper self-checks "no
          // overlap → skip silently" so safe to call unconditionally per
          // date. Replaces the dead Path (a) inside the double_booking
          // branch — the detector excludes floating blocks from its
          // pair-overlap scan (line 463-470), so Path (a) could never fire.
          // #133c — blocks the sweep relocated this run; the lunch-anchored
          // fallback below skips them (Graph re-fetch may still show the old
          // position — defer to the next sweep on settled data).
          const consolidatedBlockIds = new Set<string>();
          try {
            const { rebalanceFloatingBlocksAfterMutation } = await import('../../../utils/rebalanceFloatingBlocks');
            const sweepStart = DateTime.fromISO(startDate, { zone: timezone });
            const sweepEnd = DateTime.fromISO(endDate, { zone: timezone });
            const dayCount = Math.max(1, Math.floor(sweepEnd.diff(sweepStart, 'days').days) + 1);
            // #143c — ONE range fetch for the whole sweep, then hand each day its
            // slice via preloadedDayEvents — a 28-day sweep makes 1 Graph read, not
            // 28. Fail-safe: if the range fetch throws, dayEvents stays undefined
            // and the helper fetches that day itself (the original per-day path).
            let sweepEvents: CalendarEvent[] = [];
            try {
              sweepEvents = await getCalendarEvents(userEmail, startDate, endDate, timezone);
            } catch (fetchErr) {
              logger.warn('Sweep range fetch failed — helper will per-day fetch', { err: String(fetchErr).slice(0, 160) });
            }
            for (let d = 0; d < dayCount; d++) {
              const dt = sweepStart.plus({ days: d }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
              const affectedIso = dt.toUTC().toISO();
              if (!affectedIso) continue;
              let dayEvents: CalendarEvent[] | undefined;
              if (sweepEvents.length > 0) {
                const dayStartMs = dt.startOf('day').toMillis();
                const dayEndMs = dt.endOf('day').toMillis();
                dayEvents = sweepEvents.filter(e => {
                  if (e.isCancelled) return false;
                  const s = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis();
                  const en = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis();
                  return s < dayEndMs && en > dayStartMs;   // events intersecting this day
                });
              }
              const result = await rebalanceFloatingBlocksAfterMutation({
                profile,
                affectedSlotIso: affectedIso,
                ownerSlackId: profile.user.slack_user_id,
                // #133b — sweep-only: on a dense calendar also SLIDE a block
                // sitting in a dead sliver (6–29 min) to abut a neighbour, so
                // free time coalesces into one real break. Booking-path callers
                // omit this → their behaviour is unchanged.
                consolidateDense: true,
                preloadedDayEvents: dayEvents,   // #143c — batched read
              });
              for (const id of result.movedBlockEventIds) consolidatedBlockIds.add(id);
              if (result.moved > 0) {
                internalActions.push({
                  tool: 'rebalance_floating_blocks',
                  detail: `Rebalanced ${result.moved} floating block(s) on ${dt.toFormat('EEE d MMM')} (sweep).`,
                });
                fixesApplied += result.moved;
              }
            }
          } catch (err) {
            logger.warn('Periodic rebalance sweep threw — continuing', {
              err: String(err).slice(0, 200),
            });
          }

          // ── #133c — lunch-anchored defrag FALLBACK (dense only) ────────────
          // Runs AFTER consolidation (the cheap move — sliding lunch — is always
          // tried first) on FRESH data. For the SANDWICHED case (a meeting, then
          // lunch, then a 6–29 min sliver, then an internal meeting) sliding lunch
          // only relocates the sliver, so consolidation correctly declined — here
          // we pull the later MEETING earlier to abut lunch's end. Internal only:
          // an external / 4+-person / protected meeting is NEVER moved (it stays,
          // sliver and all). Same validated move path as the meeting-to-meeting
          // defrag, via pullInternalMeetingToAbut.
          if (prefersDensePacking(profile.meetings)) {
            try {
              const densCfgFb = densityConfigFromProfile(profile.meetings);
              const freshEvents = await getCalendarEvents(userEmail, startDate, endDate, timezone);
              const nowMsFb = DateTime.now().setZone(timezone).toMillis();
              const exclSubjectsFb = (profile.meetings.issue_exclusions?.subjects ?? [])
                .map(s => s.toLowerCase()).filter(s => s.length > 0);
              const noTrackCatsFb = new Set(
                (profile.categories ?? []).filter(c => c.no_issue_tracking === true).map(c => c.name),
              );
              const isRealMeetingFb = (e: CalendarEvent): boolean => {
                if (e.isCancelled || e.isAllDay) return false;
                if (e.showAs === 'free' || e.showAs === 'workingElsewhere') return false;
                const subj = (e.subject ?? '').toLowerCase();
                if (exclSubjectsFb.some(s => subj.includes(s))) return false;
                if (floatingBlocks.some(b => fb.isFloatingBlockEvent({ subject: e.subject, categories: e.categories }, b))) return false;
                if ((e.categories ?? []).some(c => noTrackCatsFb.has(c))) return false;
                return true;
              };
              let cursorFb = DateTime.fromISO(startDate, { zone: timezone });
              const endFb = DateTime.fromISO(endDate, { zone: timezone });
              while (cursorFb <= endFb) {
                const dStr = cursorFb.toFormat('yyyy-MM-dd');
                const dName = cursorFb.toFormat('EEEE');
                if (!allWorkDays.includes(dName) || getEffectiveWorkDay(dStr, profile).hasOverride) {
                  cursorFb = cursorFb.plus({ days: 1 });
                  continue;
                }
                const dayEvts = freshEvents.filter(e => !e.isCancelled
                  && parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toFormat('yyyy-MM-dd') === dStr);
                const meetingsSorted = dayEvts.filter(isRealMeetingFb)
                  .map(e => ({ e, start: parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis() }))
                  .sort((a, b) => a.start - b.start);
                for (const block of floatingBlocks) {
                  if (!fb.blockAppliesOnDay(block, dName, profile)) continue;
                  const blockEvent = dayEvts.find(e => !e.isAllDay
                    && fb.isFloatingBlockEvent({ subject: e.subject, categories: e.categories }, block));
                  if (!blockEvent) continue;
                  if (consolidatedBlockIds.has(blockEvent.id)) continue;      // moved this sweep → stale re-fetch risk; next sweep handles it
                  const blockEnd = parseGraphDt(blockEvent.end.dateTime, blockEvent.end.timeZone, timezone);
                  if (blockEnd.toMillis() <= nowMsFb) continue;               // block already passed today
                  const nextM = meetingsSorted.find(m => m.start >= blockEnd.toMillis());
                  if (!nextM) continue;                                        // nothing after lunch
                  const gapMin = (nextM.start - blockEnd.toMillis()) / 60000;
                  if (classifyGap(gapMin, densCfgFb) !== 'dead') continue;     // only 6–29 min slivers
                  const M = nextM.e;
                  const prot = protection.isProtected(M, profile);
                  if (prot.protected || prot.reasons.includes('has external attendee')) continue;  // NEVER external / protected
                  if (recentlyAutoMovedIds.has(M.id) || dismissedEventIds.has(M.id)) continue;
                  const synthIssue: HealthIssue = {
                    type: 'inefficient_gap', date: dStr,
                    description: `${Math.round(gapMin)}-min gap between your ${block.name.replace(/_/g, ' ')} and "${displaySubject(M, profile)}"`,
                  };
                  await pullInternalMeetingToAbut({
                    movable: M, keptEndDt: blockEnd, keptEventId: blockEvent.id,
                    moveVerb: `to close the ${Math.round(gapMin)}-min gap after your ${block.name.replace(/_/g, ' ')}`,
                    conflictReason: 'packing the day tighter',
                    dayEventsForBusy: dayEvts, issue: synthIssue,
                    userEmail, ownerUserId, timezone, profile, context, internalActions,
                  });
                  if (synthIssue.fixed) fixesApplied += 1;
                }
                cursorFb = cursorFb.plus({ days: 1 });
              }
            } catch (err) {
              logger.warn('Lunch-anchored defrag fallback threw — continuing', { err: String(err).slice(0, 200) });
            }
          }

          logger.info('Calendar health: active mode complete', {
            ownerUserId, fixesApplied, totalIssues: issues.length,
          });
        }

        // v3.1.7 / #119 — the old "drop .suppressed issues" pass is gone.
        // Days the owner waived are now skipped at DETECTION (never enter
        // issues[]), so there's nothing to filter out here before the brief.

        // v3.0.3 — cluster-based write for un-fixed issues. Maps HealthIssue
        // shape to DetectedIssue, groups via overlap edges into clusters,
        // upserts one row per cluster. Terminal rows suppress; active rows
        // merge/migrate; new clusters insert. After all clusters processed,
        // auto-stale flips any non-touched active row to 'resolved' (its
        // condition vanished since last detection).
        //
        // Active-mode SUCCESS (issue.fixed) → no row write. Failure or no-fix-
        // attempt → row gets written. Owner sees only what needs attention.
        const eventEndMs = new Map<string, number>();
        const eventDateByEventId = new Map<string, string>();
        const eventSubjectByEventId = new Map<string, string>();
        for (const e of events) {
          if (!e?.id) continue;
          try {
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            eventEndMs.set(e.id, eEnd.toMillis());
            eventDateByEventId.set(e.id, eEnd.toFormat('yyyy-MM-dd'));
            if (e.subject) eventSubjectByEventId.set(e.id, e.subject);
          } catch (_) { /* skip events with unparseable dates */ }
        }

        const classMap: Record<string, IssueClass> = {
          double_booking:           'overlap',
          oof_conflict:             'oof_with_meetings',
          category_limit_exceeded:  'category_limit',
          missing_floating_block:   'missing_floating_block',
          busy_day:                 'busy_day',
        };

        const detectedForWrite: DetectedIssue[] = [];
        const dateFallback = new Map<string, string>();
        for (const issue of issues) {
          if (issue.fixed) continue;  // active-mode success → no row
          const cls = classMap[issue.type];
          if (!cls) continue;          // missing_category / unknown — not tracked
          const eIds = issue.eventIds ?? [];
          let primaryId: string | undefined = eIds[0];
          let peerId: string | undefined = eIds[1];
          // missing_floating_block: synthesize event_id per owner direction
          // ({NNN}-{MMDDYYYY}-{HHMM}). Index from profile.meetings.floating_blocks.
          if (cls === 'missing_floating_block') {
            // v3.1.7 / #119 — synthetic id via the single-source helper. Must
            // match the detection-suppression, approve, and delete→dismiss
            // paths exactly (they all call the same helper), so a waived gap
            // suppresses and a re-detected gap re-anchors the same row.
            const synth = fb.floatingBlockSyntheticEventId(profile, issue.block_name ?? '', issue.date, timezone);
            if (synth) {
              primaryId = synth.eventId;
              peerId = undefined;
              eventEndMs.set(primaryId, synth.eventEndMs);
              dateFallback.set(primaryId, issue.date);
            }
          }
          // v3.5.x — busy_day has no real event_id; anchor it on the stable
          // synthetic id so the row materializes (was dropped at `!primaryId`)
          // and can be approved/suppressed like any other issue.
          if (cls === 'busy_day' && issue.synthetic_id) {
            primaryId = issue.synthetic_id;
            peerId = undefined;
            const dayEndMs = DateTime.fromISO(issue.date, { zone: timezone }).endOf('day').toMillis();
            eventEndMs.set(primaryId, dayEndMs);
            dateFallback.set(primaryId, issue.date);
          }
          if (!primaryId) continue;
          const endMs = eventEndMs.get(primaryId) ?? 0;
          const peerEnd = peerId ? eventEndMs.get(peerId) : undefined;
          // Use issue.date as the date fallback when we don't have it from events.
          if (!eventDateByEventId.has(primaryId)) {
            eventDateByEventId.set(primaryId, dateFallback.get(primaryId) ?? issue.date);
          }
          const detail = issue.fix_failed
            ? `auto-fix attempted: ${issue.fix_error ?? 'unknown reason'} (${issue.description})`
            : issue.description;
          detectedForWrite.push({
            class: cls,
            event_id: primaryId,
            event_subject: eventSubjectByEventId.get(primaryId),
            event_end_ms: endMs,
            peer_event_id: peerId,
            peer_subject: peerId ? eventSubjectByEventId.get(peerId) : undefined,
            peer_end_ms: peerEnd,
            detail,
          });
        }

        const touchedRowIds = new Set<string>();
        if (detectedForWrite.length > 0) {
          const clusters = buildClusters(detectedForWrite, eventDateByEventId);
          for (const c of clusters) {
            // status: 'awaiting_owner' is the post-detection landing for
            // passive mode and for active-mode-failure. We set it
            // unconditionally here — the caller decides whether to narrate.
            const res = upsertCluster(ownerUserId, c, 'awaiting_owner');
            if (res.row_id && (res.action === 'insert' || res.action === 'update' || res.action === 'merge')) {
              touchedRowIds.add(res.row_id);
              if (res.action === 'insert') newIssueCount += 1;
            }
          }
        }
        // Auto-stale anything not touched in this pass within the date range.
        markStaleResolved(ownerUserId, touchedRowIds, startDate, endDate);

        // Route 2 narration. Build a deterministic per-issue summary text
        // directly from the issue list + fix outcomes. The routine prompt
        // uses this verbatim instead of asking Sonnet to "tell me what got
        // done" (fabrications crept in when fix_failed wasn't narrated
        // honestly). humanGate humanizes the template downstream. One
        // truth source.
        // v3.5.x — don't re-narrate an issue the owner already acknowledged
        // (approved/dismissed) or that auto-resolved. The brief & analyze
        // read-paths already drop these via getSuppressedEventIds; the routine's
        // summaryText never did, so a busy_day / category_limit re-flagged EVERY
        // run despite a terminal row — the "I told you 3 times to ignore it" bug.
        // Only un-fixed "! Detected" lines are gated; fixes/failures still narrate.
        let suppressedForNarration: Set<string> = new Set();
        try {
          suppressedForNarration = getSuppressedEventIds(ownerUserId);
        } catch (err) {
          logger.warn('calendar health: suppressed-id load failed — narration unfiltered', {
            err: String(err).slice(0, 120),
          });
        }
        const isAckSuppressed = (i: HealthIssue): boolean => {
          if (i.synthetic_id && suppressedForNarration.has(i.synthetic_id)) return true;
          for (const id of (i.eventIds ?? [])) if (suppressedForNarration.has(id)) return true;
          return false;
        };

        const summaryLines: string[] = [];
        for (const i of issues) {
          // #133/#143 — a dense inefficient_gap is an AUTONOMOUS preference, not
          // an owner-actionable conflict. A SUCCESSFUL defrag already shadow-
          // notifies; a FAILED one must stay SILENT. Surfacing "couldn't close
          // the 20-min gap" led Sonnet to offer to OVERRIDE an attendee's work
          // hours for a packing tweak (the Lori 5-Aug 13:45 offer). Leave it,
          // exactly like consolidation's "no strict improvement → no move".
          if (i.type === 'inefficient_gap' && i.fix_failed) continue;
          if (i.fixed && i.fix_detail) {
            // Successful fix — narrate the action.
            summaryLines.push(`✓ ${i.fix_detail}`);
          } else if (i.fix_failed) {
            // Attempted fix but failed — narrate the attempt + the reason.
            const reason = i.fix_error ?? 'unknown reason';
            summaryLines.push(`× Tried to fix "${i.description}" but couldn't: ${reason}`);
          } else if (mode === 'active') {
            if (isAckSuppressed(i)) continue;  // acknowledged / resolved — don't re-narrate
            // Detected but no autofix attempted (or autofix skipped). Surface.
            summaryLines.push(`! Detected: ${i.description}`);
          }
        }
        // Count of issues worth surfacing (un-fixed, un-acknowledged) — drives the
        // passive-mode fallback line and the vacuous flag so neither re-counts a
        // waived issue.
        const narratableCount = issues.filter(i => !i.fixed && !i.fix_failed && !isAckSuppressed(i)).length;
        const summaryText = summaryLines.length > 0
          ? summaryLines.join('\n')
          : (narratableCount === 0
              ? 'Calendar looks healthy — no issues found.'
              : `Scanned ${startDate} to ${endDate} — ${narratableCount} issue${narratableCount === 1 ? '' : 's'} detected.`);

        // v3.1.2 fix (#118) — vacuous flag: nothing found, nothing fixed.
        // Routine dispatcher checks this to stay silent on auto-fired runs
        // (the routine prompt already says "stay silent if nothing to report"
        // but Sonnet ignored it). Owner-asked runs from chat don't go through
        // dispatchRoutine, so they ignore this flag and narrate normally so
        // the owner can verify "all good". v3.5.x — vacuous now means "nothing
        // worth saying" (all detected issues acknowledged/resolved), so the
        // routine goes quiet instead of re-sending a waived count.
        const vacuous = summaryLines.length === 0 && narratableCount === 0 && fixesApplied === 0;
        // v3.5.x (#3 follow-up, 2026-06-25) — the routine narrates from `issues`,
        // not the deterministic `summary_text`, so filtering only summary_text
        // left an acknowledged issue (the approved "5 weeklies on June 29") in
        // the array the narrator reads → it re-flagged despite the approval.
        // Drop acknowledged/resolved-and-unfixed issues from what's RETURNED, so
        // the narrator can't surface them. Fixed/failed issues stay (Maelle still
        // reports the action she took). Mirrors the brief/analyze read-paths.
        const visibleIssues = issues.filter(i => i.fixed || i.fix_failed || !isAckSuppressed(i));
        return {
          issues: visibleIssues,
          count: visibleIssues.length,
          mode,
          fixes_applied: fixesApplied,
          // v2.6.5 — surface internal mutations so the claim-checker doesn't
          // false-positive on legitimate auto-fix claims. Empty array stays
          // empty — only populated when active mode actually mutated something.
          internal_actions: internalActions.length > 0 ? internalActions : undefined,
          activeTrackedIssues: activeIssues.length > 0 ? activeIssues : undefined,
          // v2.7.4 — deterministic summary text the caller (routine, brief,
          // narration) should pass verbatim instead of having Sonnet improvise
          // from issues[]. humanGate humanizes the template downstream.
          summary_text: summaryText,
          vacuous,
          summary: visibleIssues.length === 0
            ? 'Calendar looks healthy — no issues found.'
            : mode === 'active'
            ? `Scanned ${startDate} to ${endDate}: ${visibleIssues.length} issue${visibleIssues.length === 1 ? '' : 's'} found, ${fixesApplied} fixed automatically. Remaining need your input.`
            : `Found ${visibleIssues.length} issue${visibleIssues.length === 1 ? '' : 's'} across ${startDate} to ${endDate}.${newIssueCount > 0 ? ` ${newIssueCount} new issue(s) tracked for follow-up.` : ''}`,
        };
}
