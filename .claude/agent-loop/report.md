# Agent-loop report

**v4.3.0 SHIPPED — committed `0b70f0a`, pushed, built, and RUNNING.** Boot stamp confirmed `version: 4.3.0 / gitSha: 0b70f0a`, `bolt: Now connected to Slack`, `mailPoll — starting mailbox poll timer`. 72 files, +4,360/−709. Typecheck clean.

**The email leg is live and ready to forward into.** Nothing is waiting on you to make it work.

## Read this before your first forward

| # | The chat problem | The issue | The solution | Agent | Risk | Status |
|---|---|---|---|---|---|---|
| 142 | — | **`humanGate('external')` judges the new two-part reply as ONE string and can rewrite it wholesale.** Nothing protects the `===== FORWARD ONLY BELOW THIS LINE =====` marker, and the fact-preservation veto pins *question-presence* — so a rewrite that correctly strips an owner-directed question from client-facing text gets vetoed and retried with that question pinned back in, plausibly into the forwardable half | Gate the parts separately: PART 2 through the external frame, PART 1 untouched or in the owner frame. That is instructor's own row-135 argument applied one layer up | gatekeeper + instructor | **This regenerates the row-135 harm, caused by the gate rather than the model.** Email leg only | pending owner — recommend build |
| 143 | — | **`meetings.ts`'s ~400-line prose still renders in full on an email turn** (two of its nine tools survive the clamp), so she is taught `move_meeting`, `delete_meeting` and `create_approval(policy_exception)` on the leg forwarded verbatim to a client | Split that block into channel-aware paragraphs — a real, separate effort | matchmaker | Named residual, carried deliberately. The reply frame is a partial mitigant, not a fix | pending owner — recommend build |
| 144 | — | A Haiku misclassification of chain text as *the owner's forwarding note* writes a timezone at **owner** authority, which by design no later `auto` correction can override — so a wrong zone is sticky | Derive authority from something other than the model's own judgement about where the text sat | transporter | Email leg, low. Malformed values correctly fall to `'chain'`; only the confidently-wrong case sticks | pending owner — recommend build |
| 145 | — | `_requested_time_local` tells the model *"the zone the times were **given** in"* — false when the zone came from the new auto-fill, because the times were given in the owner's zone | One-line wording split | matchmaker | **Live Slack path**, benign — the numbers are computed deterministically and are correct, only the provenance label lies | pending owner — recommend build |
| 126 | The client-bound email had its date text rewritten though the draft was correct | dateVerifier flags `שלישי` against `שלישי` as a mismatch. **Now known to be flag-only** — the swap guard already prevented the edit; only the log claimed a correction, and that log is now honest | Hebrew comparison/normalisation fix | gatekeeper | Lower than reported: it never actually edited the text | **deferred** — owner: "ignore for now" |
| 125 | — | The slot-hold release DM is not role-gated, so an email booking can Slack-DM a colleague whose hold was released | Leave as-is, or role-gate | matchmaker | The one Slack emission reachable from the email path | **deferred** — owner: "not important for now" |

## Three of my own claims were wrong, and the lanes caught all three

Recorded because the pattern matters more than the instances — in every case I read a **log line as an action** without opening the persisted turn:

1. **No conversation topic was burned.** The coda log comes from a different block, and `recordCodaDelivered` only fires on confirmed Slack delivery. It was wasted computation and a dropped coda.
2. **The 6am was not an ignored timezone.** Run 2's chain states no zone anywhere — your own sanctioned fallback applied correctly. The "He needs EST time" signal arrived in run 3, *after* the offer. Row 129 was a missing capability, not a defect that fired.
3. **The dateVerifier never rewrote anything** (row 126 above).

And one estimate was wrong: I said `locationTz` already mapped `'et'` so extraction would be cheap. It mapped `'et'` but not `'est'` — the actual evidenced text — so the fix would have silently failed on the exact case it was for.

## What the pre-commit verify caught, and why I fixed it before shipping

**The one-address cap was validating an address the send never used.** `sendDirect` checked the inbound `From`, then `replyToMail` let Graph infer the recipient from the message id — so a `Reply-To` could have carried your availability somewhere the cap believed it had refused. Your `RequireSenderAuthenticationEnabled` flag makes it hard to reach, but the poll runs unattended every 30s, so it wasn't covered by "he's testing supervised." Fixed by PATCHing `toRecipients` explicitly — nothing is inferred now.

**And I reclassified one of the verify's own findings.** It filed `cst`/`mst` as a discovery; this wave *introduced* them, on the **Slack** travel path, where `CST` would have produced a 14-hour error. An introduced defect is an overturn by its own rule. Removed, with a note saying why.

## Discoveries — next run, not built

`replyToMail` is three Graph calls with no idempotency guard, so a failure between the patch and the send leaves an orphaned draft in your mailbox · `gh#5`'s outbound sub-task is now blocked by design rather than unbuilt (commented on the ticket) · `gh#55` must **not** be closed on the `locationTz` change — that ticket explicitly lists improving the static map as out of scope · a stray `kind='self'` test row `p_SELF_U12345TEST` sits in the production DB.

## Actions

**Issues:** [#24](https://github.com/odahviing/AI-Executive-Assistant/issues/24) commented and **left open** — row 143 is why. [#5](https://github.com/odahviing/AI-Executive-Assistant/issues/5) commented as partial, with its outbound sub-task marked blocked-by-design. Nothing closed: no row met all three conditions.

**Two changes no diff shows:** `config/users/idan.yaml` is gitignored, so `assistant.email`, `channels.email.enabled: true` and the mailbox live only on this machine. And the live DB row `p_SELF_U0F28CK6H` was repaired out of band.

**One unrequested change for your veto:** `profiler` also fixed `src/core/assistant.ts`'s `update_person_profile` external branch — same root, different door, but a live Slack path you didn't ask for. The verify adjudicated it correct and would keep it.
