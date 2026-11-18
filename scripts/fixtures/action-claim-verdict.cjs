// Controlled detector responses follow the schema of the captured prompt.
// This adapter tests verdict handling, not the model's semantic judgment.
module.exports = function actionClaimVerdict(claim, request) {
  const prompt = request.messages[0].content;
  if(prompt.startsWith('Audit owner-related factual claims')) {
    const draft=prompt.split('CURRENT DRAFT:\n')[1]?.split('\n\nFirst identify')[0];
    const domains={invented_fact:'personal_fact',permission_granted:'owner_decision',book:'completed_action',message:'completed_action',task:'completed_action',denied_calendar_read:'prior_calendar_read',ungrounded_slot_claim:'calendar_fact'};
    return {...claim,claim_domain:claim.claim_domain ?? (claim.claimed_action?domains[claim.action_type]??'none':'none'),
      verdict:claim.verdict ?? (claim.claimed_action?'unsupported':'no_claim'),
      claim_quote:Object.hasOwn(claim,'claim_quote')?claim.claim_quote:claim.claimed_action?draft:null};
  }
  if (prompt.startsWith('Audit only calendar availability claims')) {
    const draft=prompt.split('DRAFT:\n')[1]?.split('\n\nIdentify the precise')[0];
    return {...claim,verdict:claim.verdict ?? (claim.claimed_action?'unsupported':'no_calendar_claim'),
      fact_subject:claim.fact_subject ?? (claim.claimed_action?'owner':'none'),
      claim_quote:Object.hasOwn(claim,'claim_quote')?claim.claim_quote:claim.claimed_action?draft:null};
  }
  if (!prompt.startsWith('Audit only external actions BY THE ASSISTANT')) return claim;
  const draft = prompt.split('CURRENT DRAFT:\n')[1]?.split('\n\nReturn one JSON object only:')[0];
  return {
    ...claim,
    action_performer: claim.action_performer ?? (claim.claimed_action ? 'assistant' : 'none'),
    verdict: claim.verdict ?? (claim.claimed_action ? 'unsupported' : 'no_action_claim'),
    claim_quote: Object.hasOwn(claim, 'claim_quote') ? claim.claim_quote : claim.claimed_action ? draft : null,
  };
};
