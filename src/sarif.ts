import { pathToFileURL } from 'node:url';
import type { Decision, Report } from './domain.js';
import { releaseVersion } from './version.js';

const levels = { high: 'error', medium: 'warning', low: 'note', unknown: 'warning' } as const satisfies Record<Decision['impact'], string>;

/**
 * Converts a review report to SARIF 2.1.0. Each supported decision becomes one result, and each check family
 * with any decision becomes one rule. Uncertain, needs-context, and not-supported decisions are not results;
 * run properties count them so a consumer can see what was left out.
 */
export function toSarif(report: Report) {
 const families = new Map<string, Decision>();
 for (const decision of report.decisions) if (!families.has(decision.check)) families.set(decision.check, decision);
 const ruleIds = [...families.keys()].sort();
 const rules = ruleIds.map(id => {
  const { hypothesis, verification } = families.get(id)!;
  return {
   id, name: id, shortDescription: { text: /^.*?[.!?](?=\s|$)/su.exec(hypothesis)?.[0] ?? hypothesis },
   fullDescription: { text: hypothesis }, help: { text: verification }, defaultConfiguration: { level: 'warning' as const }
  };
 });
 const results = report.decisions.filter(decision => decision.status === 'supported').map(decision => ({
  ruleId: decision.check, ruleIndex: ruleIds.indexOf(decision.check), kind: 'fail' as const, level: levels[decision.impact],
  message: { text: decision.hypothesis },
  locations: [{
   physicalLocation: {
    artifactLocation: { uri: decision.path.split('/').map(encodeURIComponent).join('/'), uriBaseId: 'SRCROOT' },
    region: { startLine: decision.range.start, endLine: decision.range.end, snippet: { text: decision.quote } },
   },
   logicalLocations: [{ name: decision.symbol }],
  }],
  fingerprints: { 'tracecheckCandidate/v1': decision.id },
  properties: {
   impact: decision.impact, impactConfidence: decision.impactConfidence, confidence: decision.confidence,
   probability: decision.probability, verification: decision.verification
  },
 }));
 const omitted = (status: Decision['status']) => report.decisions.filter(decision => decision.status === status).length;
 return {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0' as const,
  runs: [{
   tool: { driver: { name: 'Tracecheck', version: releaseVersion, informationUri: 'https://github.com/bmccarn/tracecheck', rules } },
   originalUriBaseIds: { SRCROOT: { uri: pathToFileURL(report.root.endsWith('/') ? report.root : `${report.root}/`).href } },
   results,
   properties: {
    reportId: report.id, status: report.status, snapshot: report.snapshot, base: report.base, head: report.head,
    models: report.models, limitations: report.limitations, notes: report.notes,
    omittedDecisions: { uncertain: omitted('uncertain'), needsContext: omitted('needs_context'), notSupported: omitted('not_supported') }
   },
  }],
 };
}
