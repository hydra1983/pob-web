export function classifyCandidateDelta(delta) {
  const dps = delta.combinedDps ?? delta.totalDps ?? 0;
  const ehp = delta.effectiveHitPool ?? 0;
  const life = delta.life ?? 0;
  const chaosResist = delta.chaosResist ?? 0;

  if (dps > 0 && ehp >= -500 && life >= -50 && chaosResist >= -5) {
    return "upgrade_candidate";
  }
  if (dps < 0 && (ehp < 0 || life < 0 || chaosResist < 0)) {
    return "downgrade_skip";
  }
  return "manual_review";
}
