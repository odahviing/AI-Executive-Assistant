import type { UserProfile } from '../../config/userProfile';

/**
 * ownerEmailAddresses (v4.3.0, #24 E3/E4) — the ONE rule for "which email
 * addresses count as the owner", shared by both directions of this
 * transport:
 *   - the inbound sender gate (connectors/email/inbound.ts) — who may drive
 *     Maelle over email at all
 *   - the outbound one-address send cap (`./index.ts`,
 *     EmailConnection.sendDirect) — who she may ever send a reply to
 *
 * By the owner's own design (see the `owner_aliases` schema comment in
 * config/userProfile.ts) these two are the SAME set on purpose. Two copies
 * of this rule can drift apart silently, and either direction of drift is
 * bad: accepted at the door but refused by the cap means a message gets
 * read and acted on (calendar searched, possibly booked) with no reply ever
 * able to leave; accepted by the cap but refused at the door means the cap
 * is guarding an address that can never reach it anyway. One function,
 * imported by both sides, makes that divergence structurally impossible
 * instead of just documented against.
 *
 * The owner's own address (`profile.user.email`) plus every configured
 * alias (`profile.channels.email?.owner_aliases`), trimmed and lower-cased.
 * No aliases configured, or `channels.email` absent entirely, both degrade
 * to just `[owner]` — never invents an alias, never throws.
 */
export function ownerEmailAddresses(profile: UserProfile): string[] {
  const owner = profile.user.email.trim().toLowerCase();
  const aliases = (profile.channels.email?.owner_aliases ?? []).map(a => a.trim().toLowerCase());
  return [owner, ...aliases];
}
