/** The same requested length must produce the same interval for search, point checks and booking. */
export function meetingDuration(requestedMin: number, allowed: number[], isOwner: boolean) {
  const snappedMin = allowed.reduce((best, candidate) =>
    Math.abs(candidate - requestedMin) < Math.abs(best - requestedMin) ? candidate : best,
    allowed[0] ?? requestedMin);
  const nearPreset = Math.abs(snappedMin - requestedMin) <= 5;
  return {
    requestedMin,
    snappedMin,
    durationMin: nearPreset ? snappedMin : requestedMin,
    needsConfirm: !nearPreset && !isOwner,
  };
}
