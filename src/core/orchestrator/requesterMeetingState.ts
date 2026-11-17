import {getOpenRequestsForThread} from '../../db/requests';
import {getActiveSlotHolds} from '../../db/slotHolds';
import {parseDetails} from '../requests/types';
import {extractCallbacks} from '../approvals/approvalCallbacks';

/** Current state visible to the authenticated requester in this private thread. */
export function requesterMeetingState(owner:string, requester:string, channel:string, thread:string) {
  if (owner===requester || !requester || !/^D[A-Z0-9]+$/.test(channel) || !thread) return;
  const approvals = getOpenRequestsForThread(owner,thread).flatMap(row=>{
    if (row.owner_user_id!==owner || row.requester_slack_id!==requester || row.origin_channel!==channel
      || row.origin_thread_ts!==thread || row.kind!=='approval'
      || (row.state!=='awaiting_owner' && row.state!=='awaiting_colleague')) return [];
    const details = parseDetails(row) ?? {};
    const action = extractCallbacks(details).on_approve;
    if (!action && details.organizer_invitation!==true) return [];
    if (action && !['create_meeting','move_meeting','update_meeting','delete_meeting','check_join_availability'].includes(action.tool)) return [];
    const counter = details.counter && typeof details.counter==='object' ? details.counter as Record<string,unknown> : {};
    const args = action?.args ?? {};
    const start = counter.new_start ?? counter.start ?? counter.slot_iso ?? args.new_start ?? args.start;
    const end = counter.new_end ?? counter.end ?? args.new_end ?? args.end;
    return [{subject:row.subject,operation:action?.tool ?? 'attendance',state:row.state,
      ownerNotificationDelivered:!!row.terminal_dm_msg_ts,start:typeof start==='string'?start:undefined,end:typeof end==='string'?end:undefined}];
  });
  const holds = getActiveSlotHolds(owner).filter(h=>h.holder_slack_id===requester && h.origin_channel===channel && h.origin_thread_ts===thread)
    .map(h=>({subject:h.subject,start:h.start_iso,end:h.end_iso,expires:h.expires_at}));
  return {approvals,holds};
}
