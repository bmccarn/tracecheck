import type { Report } from './domain.js';

export function compare(previous: Report, current: Report) {
  if (previous.root !== current.root || previous.base !== current.base
    || previous.checkVersion !== current.checkVersion || previous.policyVersion !== current.policyVersion
    || previous.models.join(',') !== current.models.join(',')) {
    throw new Error('Reports have different repositories, baselines, models, or policies and cannot be compared.');
  }
  return previous.decisions.filter(item => item.status === 'supported').map(item => {
    const next = current.decisions.find(candidate => candidate.id === item.id);
    return { id: item.id, path: item.path, check: item.check,
      status: !next ? 'not_reassessed' : next.status === 'not_supported' ? 'no_longer_supported'
        : next.status === 'supported' ? 'still_present' : 'unresolved' };
  });
}
