/**
 * Decision gates, calibrated on labeled defect and clean pairs with the live model (docs/calibration.md).
 * Changing a source gate requires a new POLICY_VERSION; changing a quality gate requires a new RUBRIC_VERSION,
 * because compare refuses to compare reports made under different gates.
 */
export const SOURCE_GATES = { probability: 0.7, confidence: 0.6, impactConfidence: 0.6 } as const;
export const QUALITY_GATES = {
  relevance: 0.8, applicability: 0.5, scoreConfidence: 0.4, concernConfidence: 0.6, concernProbability: 0.8,
} as const;
