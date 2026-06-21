export * from './client';
export * from './people';
export * from './preferences';
export * from './conversations';
export * from './jobs';
export * from './events';
// v3.4.6 (spine collapse) — './approvals' retired. The legacy approvals table
// had no writer left (createApproval deleted v3.0.6; emitWaitingOwnerApproval +
// create_approval write the requests spine). Its last readers (coord-reply
// counter/cancel) were migrated to the spine, so the module + its re-export are
// gone. Approvals ARE requests now (src/core/requests/, src/db/requests.ts).
export * from './calendarIssues';
export * from './slotHolds';
export * from './summarySessions';
export * from './socialSubjects';
export * from './engagementRank';
export * from './venues';
