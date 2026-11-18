import {getOpenRequestsForColleague} from '../../db/requests';
import {getActiveSlotHolds} from '../../db/slotHolds';
import {parseDetails} from '../requests/types';
import {extractCallbacks} from '../approvals/approvalCallbacks';
import type {RequestRow} from '../requests/types';

/** Withdrawal cancels this person's pending decision, never its calendar action. */
export function canWithdrawOwnRequest(row:RequestRow|undefined,owner:string,requester:string,channel:string,thread:string,meetingRequestId?:string):boolean {
  return !!row && requester!==owner && /^D[A-Z0-9]+$/.test(channel) && !!thread
    && row.kind==='approval' && row.state==='awaiting_owner'
    && row.owner_user_id===owner && row.requester_slack_id===requester
    && row.origin_channel===channel && row.origin_thread_ts===thread
    && (!meetingRequestId || parseDetails(row)?.meeting_request_id===meetingRequestId);
}

/** Current state belonging to the authenticated requester, shown only in their DM. */
export function requesterMeetingState(owner:string, requester:string, channel:string, thread:string) {
  if (owner===requester || !requester || !/^D[A-Z0-9]+$/.test(channel) || !thread) return;
  const approvals = getOpenRequestsForColleague(owner,requester).flatMap(row=>{
    if (row.owner_user_id!==owner || row.requester_slack_id!==requester || row.kind!=='approval'
      || (row.state!=='awaiting_owner' && row.state!=='awaiting_colleague')) return [];
    const details = parseDetails(row) ?? {};
    const action = extractCallbacks(details).on_approve;
    const boundQuestion = !action && row.subkind==='freeform' && typeof details.meeting_request_id==='string';
    if (!action && details.organizer_invitation!==true && !boundQuestion) return [];
    if (action && !['create_meeting','move_meeting','update_meeting','delete_meeting','check_join_availability'].includes(action.tool)) return [];
    const counter = details.counter && typeof details.counter==='object' ? details.counter as Record<string,unknown> : {};
    const args = action?.args ?? {};
    const start = counter.new_start ?? counter.start ?? counter.slot_iso ?? args.new_start ?? args.start;
    const end = counter.new_end ?? counter.end ?? args.new_end ?? args.end;
    // The expiry worker can be between ticks. Presentation must not describe a
    // passed appointment or expired approval as an actionable pending option.
    const expired = (typeof row.expires_at==='string' && Date.parse(row.expires_at)<=Date.now())
      || (typeof start==='string' && Date.parse(start)<=Date.now());
    return [{subject:row.subject,operation:action?.tool ?? (boundQuestion?'question':'attendance'),state:expired?'expired':row.state,
      ...(typeof details.meeting_request_id==='string' ? {meetingRequestId:details.meeting_request_id} : {}),
      ...(boundQuestion ? {question:details.question,context:details.context} : {}),
      ownerNotificationDelivered:!!row.terminal_dm_msg_ts,start:typeof start==='string'?start:undefined,end:typeof end==='string'?end:undefined}];
  });
  const holds = getActiveSlotHolds(owner).filter(h=>h.holder_slack_id===requester)
    .map(h=>({subject:h.subject,start:h.start_iso,end:h.end_iso,expires:h.expires_at}));
  return {approvals,holds};
}
