import type { Decision, Report } from './domain.js';

/**
 * A candidate ID includes the file path, so a rename gives the same site a new ID. The site is still the same finding
 * when its path at the base, check, symbol, and quote with whitespace collapsed all agree.
 */
const siteKey = (item: Decision) => JSON.stringify([item.previousPath ?? item.path, item.check, item.symbol, item.quote.replace(/\s+/g, ' ')]);

/** `currentId` and `currentPath` name where the current report holds an earlier finding after its file was renamed. */
type HistoryEntry = {
  id: string; path: string; check: string; currentId?: string; currentPath?: string;
  status: 'still_present' | 'no_longer_supported' | 'unresolved' | 'not_reassessed' | 'newly_supported';
};

export function compare(previous: Report, current: Report): HistoryEntry[] {
  if (previous.root !== current.root || previous.base !== current.base
    || previous.checkVersion !== current.checkVersion || previous.policyVersion !== current.policyVersion
    || [...previous.models].sort().join('\n') !== [...current.models].sort().join('\n')) {
    throw new Error('Reports have different repositories, baselines, models, or policies and cannot be compared.');
  }
  const previousIds = new Set(previous.decisions.map(item => item.id));
  const currentById = new Map(current.decisions.map(item => [item.id, item]));
  // Current decisions no earlier decision shares an ID with, by site, in report order.
  const unmatched = new Map<string, Decision[]>();
  for (const item of current.decisions) {
    if (previousIds.has(item.id)) continue;
    const key = siteKey(item);
    const sites = unmatched.get(key);
    if (sites) sites.push(item);
    else unmatched.set(key, [item]);
  }
  const followed = new Set<string>();
  const earlier = previous.decisions.filter(item => item.status === 'supported').map((item): HistoryEntry => {
    let next = currentById.get(item.id);
    if (!next) {
      const sites = unmatched.get(siteKey(item)) ?? [];
      const index = sites.findIndex(site => site.path !== item.path);
      if (index >= 0) [next] = sites.splice(index, 1);
    }
    if (next) followed.add(next.id);
    return { id: item.id, path: item.path, check: item.check,
      ...(next && next.id !== item.id ? { currentId: next.id, currentPath: next.path } : {}),
      status: !next ? 'not_reassessed' : next.status === 'not_supported' ? 'no_longer_supported'
        : next.status === 'supported' ? 'still_present' : 'unresolved' };
  });
  const added = current.decisions.filter(item => item.status === 'supported' && !followed.has(item.id))
    .map((item): HistoryEntry => ({ id: item.id, path: item.path, check: item.check, status: 'newly_supported' }));
  return [...earlier, ...added];
}
