import type { Report } from './domain.js';

export function compare(previous: Report, current: Report) {
  if (previous.root !== current.root || previous.base !== current.base
    || previous.checkVersion !== current.checkVersion || previous.policyVersion !== current.policyVersion
    || [...previous.models].sort().join('\n') !== [...current.models].sort().join('\n')) {
    throw new Error('Reports have different repositories, baselines, models, or policies and cannot be compared.');
  }
  const supported = previous.decisions.filter(item => item.status === 'supported');
  const previouslySupported = new Set(supported.map(item => item.id));
  const earlier = supported.map(item => {
    const next = current.decisions.find(candidate => candidate.id === item.id);
    return { id: item.id, path: item.path, check: item.check,
      status: !next ? 'not_reassessed' : next.status === 'not_supported' ? 'no_longer_supported'
        : next.status === 'supported' ? 'still_present' : 'unresolved' };
  });
  const added = current.decisions.filter(item => item.status === 'supported' && !previouslySupported.has(item.id))
    .map(item => ({ id: item.id, path: item.path, check: item.check, status: 'newly_supported' }));
  return [...earlier, ...added];
}
