// Labeled defect/clean pairs for calibrating Tracecheck's decision gates against a live Jev model.
// Each pair shares a small module, a caller, a test, and a stated contract (the review task). The defect variant's
// working-tree change violates the contract at the site a source-check candidate quotes; the clean variant makes a
// similar change that honors it. Quality-only pairs have no candidates and exercise the broad quality layer.
// Case source is synthetic and is never executed.

export type CheckFamily = 'zero-divisor' | 'swallowed-failure' | 'unhandled-json';
export type Family = CheckFamily | 'quality-only';
export type Split = 'development' | 'holdout';
export type VariantName = 'defect' | 'clean';
export type CheckLabel = 'supported' | 'not_supported';

export type QualityLabels = {
  /** Dimension keys clearly relevant to the task. */
  relevant: string[];
  /** Dimension keys clearly irrelevant to the task. */
  irrelevant: string[];
  /** Relevant dimensions on which the defect variant should score lower than the clean variant. */
  lowerOnDefect: string[];
};

export type CalibrationCase = {
  id: string;
  family: Family;
  split: Split;
  /** Stated contract, passed to collection as the review task. */
  task: string;
  /** Files committed as the baseline. */
  base: Record<string, string>;
  /** Working-tree files each variant writes over the baseline. */
  variants: Record<VariantName, Record<string, string>>;
  quality: QualityLabels;
};

export const variantNames: readonly VariantName[] = ['defect', 'clean'];

/** Expected decision for every candidate of each check in a variant; a quality-only variant expects no candidates. */
export function expectedChecks(item: CalibrationCase, variant: VariantName): Partial<Record<CheckFamily, CheckLabel>> {
  return item.family === 'quality-only' ? {} : { [item.family]: variant === 'defect' ? 'supported' : 'not_supported' };
}

const familyQuality: Record<CheckFamily, QualityLabels> = {
  'zero-divisor': { relevant: ['correctness'], irrelevant: ['performance', 'scalability', 'observability', 'security'], lowerOnDefect: ['correctness'] },
  'swallowed-failure': { relevant: ['correctness', 'reliability'], irrelevant: ['performance', 'scalability', 'security'], lowerOnDefect: ['correctness', 'reliability'] },
  'unhandled-json': { relevant: ['correctness', 'reliability'], irrelevant: ['performance', 'scalability'], lowerOnDefect: ['correctness', 'reliability'] },
};

// String.raw keeps regular-expression escapes such as \s intact; the leading newline is dropped.
const code = (strings: TemplateStringsArray) => String.raw({ raw: strings.raw }).replace(/^\n/, '');

type Spec = Omit<CalibrationCase, 'variants' | 'quality'> & { defect: Record<string, string>; clean: Record<string, string>; quality?: Partial<QualityLabels> };
const pair = ({ defect, clean, quality, ...item }: Spec): CalibrationCase => {
  const defaults = item.family === 'quality-only' ? { relevant: [], irrelevant: [], lowerOnDefect: [] } : familyQuality[item.family];
  return { ...item, variants: { defect, clean }, quality: { ...defaults, ...quality } };
};

export const cases: CalibrationCase[] = [
  // Zero divisor, development.
  pair({
    id: 'zd-cart-average', family: 'zero-divisor', split: 'development',
    task: "Weight the cart's average unit price by quantity. The receipt must never show NaN: an empty cart, or one whose quantities sum to zero, averages 0.",
    base: {
      'src/cart.ts': code`
export type LineItem = { sku: string; unitPrice: number; quantity: number };

/** Average unit price across the cart. An empty cart averages 0. */
export function averageUnitPrice(items: LineItem[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, item) => sum + item.unitPrice, 0);
  return total / items.length;
}
`,
      'src/receipt.ts': code`
import { averageUnitPrice, type LineItem } from './cart.js';

export function receiptFooter(items: LineItem[]): string {
  return 'Average unit price: $' + averageUnitPrice(items).toFixed(2);
}
`,
      'test/cart.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageUnitPrice } from '../src/cart.js';

test('averages unit prices', () => {
  assert.equal(averageUnitPrice([{ sku: 'a', unitPrice: 4, quantity: 1 }, { sku: 'b', unitPrice: 6, quantity: 1 }]), 5);
});

test('an empty cart averages zero', () => {
  assert.equal(averageUnitPrice([]), 0);
});
`,
    },
    defect: {
      'src/cart.ts': code`
export type LineItem = { sku: string; unitPrice: number; quantity: number };

/** Average unit price across every unit in the cart, weighted by quantity. An empty cart averages 0. */
export function averageUnitPrice(items: LineItem[]): number {
  const units = items.reduce((count, item) => count + item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  return total / units;
}
`,
    },
    clean: {
      'src/cart.ts': code`
export type LineItem = { sku: string; unitPrice: number; quantity: number };

/** Average unit price across every unit in the cart, weighted by quantity. An empty cart averages 0. */
export function averageUnitPrice(items: LineItem[]): number {
  const units = items.reduce((count, item) => count + item.quantity, 0);
  if (units === 0) return 0;
  const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  return total / units;
}
`,
    },
  }),
  pair({
    id: 'zd-split-bill', family: 'zero-divisor', split: 'development',
    task: 'Split bills by payer weight instead of evenly. splitBill must throw RangeError when there are no payers or the weights sum to zero; it never returns NaN or Infinity shares.',
    base: {
      'src/split.ts': code`
export type Payer = { name: string; weight: number };

/** Splits a bill in cents across payers. Throws RangeError when no share can be computed. */
export function splitBill(totalCents: number, payers: Payer[]): Map<string, number> {
  if (payers.length === 0) throw new RangeError('A bill needs at least one payer.');
  const share = Math.floor(totalCents / payers.length);
  return new Map(payers.map(payer => [payer.name, share]));
}
`,
      'src/settle.ts': code`
import { splitBill, type Payer } from './split.js';

/** The API maps a RangeError from settle to a 422 response. */
export function settle(totalCents: number, payers: Payer[]) {
  const shares = splitBill(totalCents, payers);
  return [...shares].map(([name, cents]) => ({ name, owes: cents }));
}
`,
      'test/split.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from '../src/split.js';

test('splits a bill', () => {
  assert.deepEqual([...splitBill(900, [{ name: 'a', weight: 1 }, { name: 'b', weight: 2 }]).values()].length, 2);
});

test('rejects a bill without payers', () => {
  assert.throws(() => splitBill(100, []), RangeError);
});
`,
    },
    defect: {
      'src/split.ts': code`
export type Payer = { name: string; weight: number };

/** Splits a bill in cents across payers by weight. Throws RangeError when no share can be computed. */
export function splitBill(totalCents: number, payers: Payer[]): Map<string, number> {
  const totalWeight = payers.reduce((sum, payer) => sum + payer.weight, 0);
  return new Map(payers.map(payer => [payer.name, Math.floor((totalCents * payer.weight) / totalWeight)]));
}
`,
    },
    clean: {
      'src/split.ts': code`
export type Payer = { name: string; weight: number };

/** Splits a bill in cents across payers by weight. Throws RangeError when no share can be computed. */
export function splitBill(totalCents: number, payers: Payer[]): Map<string, number> {
  const totalWeight = payers.reduce((sum, payer) => sum + payer.weight, 0);
  if (totalWeight <= 0) throw new RangeError('Payer weights must sum to more than zero.');
  return new Map(payers.map(payer => [payer.name, Math.floor((totalCents * payer.weight) / totalWeight)]));
}
`,
    },
  }),
  pair({
    id: 'zd-conversion-rate', family: 'zero-divisor', split: 'development',
    task: 'Measure campaign conversion per unique visitor instead of per session. A campaign with no visitors must still show 0% on the dashboard.',
    base: {
      'src/metrics.ts': code`
export type CampaignStats = { sessions: Array<{ visitorId: string }>; orders: number };

/** Orders per 100 sessions. A campaign without sessions reports 0. */
export function conversionRate(stats: CampaignStats): number {
  if (stats.sessions.length === 0) return 0;
  return (stats.orders / stats.sessions.length) * 100;
}
`,
      'src/dashboard.ts': code`
import { conversionRate, type CampaignStats } from './metrics.js';

export function campaignRow(name: string, stats: CampaignStats) {
  return { name, conversion: conversionRate(stats).toFixed(1) + '%' };
}
`,
      'test/metrics.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionRate } from '../src/metrics.js';

test('converts orders per session', () => {
  assert.equal(conversionRate({ sessions: [{ visitorId: 'a' }, { visitorId: 'b' }], orders: 1 }), 50);
});

test('a campaign without traffic reports zero', () => {
  assert.equal(conversionRate({ sessions: [], orders: 0 }), 0);
});
`,
    },
    defect: {
      'src/metrics.ts': code`
export type CampaignStats = { sessions: Array<{ visitorId: string }>; orders: number };

/** Orders per 100 unique visitors. A campaign without visitors reports 0. */
export function conversionRate(stats: CampaignStats): number {
  const visitors = new Set(stats.sessions.map(session => session.visitorId)).size;
  return (stats.orders / visitors) * 100;
}
`,
    },
    clean: {
      'src/metrics.ts': code`
export type CampaignStats = { sessions: Array<{ visitorId: string }>; orders: number };

/** Orders per 100 unique visitors. A campaign without visitors reports 0. */
export function conversionRate(stats: CampaignStats): number {
  const visitors = new Set(stats.sessions.map(session => session.visitorId)).size;
  if (visitors === 0) return 0;
  return (stats.orders / visitors) * 100;
}
`,
    },
  }),
  pair({
    id: 'zd-upload-progress', family: 'zero-divisor', split: 'development',
    task: 'Show one progress bar for a whole batch of uploads. Empty files and empty batches count as 100% complete; the bar must never show NaN%.',
    base: {
      'src/progress.ts': code`
export type Upload = { sentBytes: number; totalBytes: number };

/** Whole-number percentage for one upload's progress bar. An empty file is complete. */
export function percentComplete(upload: Upload): number {
  if (upload.totalBytes === 0) return 100;
  return Math.round((upload.sentBytes / upload.totalBytes) * 100);
}
`,
      'src/uploader.ts': code`
import { percentComplete, type Upload } from './progress.js';

export function renderProgress(upload: Upload): string {
  const percent = percentComplete(upload);
  return '[' + '#'.repeat(Math.floor(percent / 10)).padEnd(10, ' ') + '] ' + percent + '%';
}
`,
      'test/progress.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentComplete } from '../src/progress.js';

test('reports whole percentages', () => {
  assert.equal(percentComplete({ sentBytes: 50, totalBytes: 200 }), 25);
});

test('an empty file is complete', () => {
  assert.equal(percentComplete({ sentBytes: 0, totalBytes: 0 }), 100);
});
`,
    },
    defect: {
      'src/progress.ts': code`
export type Upload = { sentBytes: number; totalBytes: number };

/** Whole-number percentage for a batch's progress bar. Empty files and batches are complete. */
export function percentComplete(uploads: Upload[]): number {
  let sent = 0;
  let total = 0;
  for (const upload of uploads) {
    sent += upload.sentBytes;
    total += upload.totalBytes;
  }
  return Math.round((sent / total) * 100);
}
`,
      'src/uploader.ts': code`
import { percentComplete, type Upload } from './progress.js';

export function renderProgress(uploads: Upload[]): string {
  const percent = percentComplete(uploads);
  return '[' + '#'.repeat(Math.floor(percent / 10)).padEnd(10, ' ') + '] ' + percent + '%';
}
`,
      'test/progress.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentComplete } from '../src/progress.js';

test('reports whole percentages across a batch', () => {
  assert.equal(percentComplete([{ sentBytes: 50, totalBytes: 100 }, { sentBytes: 0, totalBytes: 100 }]), 25);
});
`,
    },
    clean: {
      'src/progress.ts': code`
export type Upload = { sentBytes: number; totalBytes: number };

/** Whole-number percentage for a batch's progress bar. Empty files and batches are complete. */
export function percentComplete(uploads: Upload[]): number {
  let sent = 0;
  let total = 0;
  for (const upload of uploads) {
    sent += upload.sentBytes;
    total += upload.totalBytes;
  }
  if (total === 0) return 100;
  return Math.round((sent / total) * 100);
}
`,
      'src/uploader.ts': code`
import { percentComplete, type Upload } from './progress.js';

export function renderProgress(uploads: Upload[]): string {
  const percent = percentComplete(uploads);
  return '[' + '#'.repeat(Math.floor(percent / 10)).padEnd(10, ' ') + '] ' + percent + '%';
}
`,
      'test/progress.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentComplete } from '../src/progress.js';

test('reports whole percentages across a batch', () => {
  assert.equal(percentComplete([{ sentBytes: 50, totalBytes: 100 }, { sentBytes: 0, totalBytes: 100 }]), 25);
});
`,
    },
  }),
  pair({
    id: 'zd-page-count', family: 'zero-divisor', split: 'development',
    task: 'Let clients choose the page size with ?pageSize=. Missing, zero, negative, or non-numeric values fall back to 20, and sizes above 100 are capped at 100. pageCount must always be a finite whole number.',
    quality: { irrelevant: ['performance', 'scalability', 'observability'] },
    base: {
      'src/paginate.js': code`
const DEFAULT_PAGE_SIZE = 20;

/** Pagination for a list endpoint, read from the request's query parameters. */
export function pageInfo(query, totalItems) {
  const pageSize = DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(query.page) || 1);
  return { page, pageSize, pageCount: Math.ceil(totalItems / pageSize) };
}
`,
      'src/routes/orders.js': code`
import { pageInfo } from '../paginate.js';

export function listOrders(req, orders) {
  const info = pageInfo(req.query, orders.length);
  const start = (info.page - 1) * info.pageSize;
  return { ...info, items: orders.slice(start, start + info.pageSize) };
}
`,
      'test/paginate.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageInfo } from '../src/paginate.js';

test('counts pages', () => {
  assert.deepEqual(pageInfo({ page: '2' }, 45), { page: 2, pageSize: 20, pageCount: 3 });
});
`,
    },
    defect: {
      'src/paginate.js': code`
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Pagination for a list endpoint, read from the request's query parameters. */
export function pageInfo(query, totalItems) {
  const pageSize = query.pageSize === undefined ? DEFAULT_PAGE_SIZE : Math.min(Number(query.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, Number(query.page) || 1);
  return { page, pageSize, pageCount: Math.ceil(totalItems / pageSize) };
}
`,
    },
    clean: {
      'src/paginate.js': code`
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Pagination for a list endpoint, read from the request's query parameters. */
export function pageInfo(query, totalItems) {
  const requested = Number(query.pageSize);
  const pageSize = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(query.page) || 1);
  return { page, pageSize, pageCount: Math.ceil(totalItems / pageSize) };
}
`,
    },
  }),

  // Zero divisor, holdout.
  pair({
    id: 'zd-inventory-turnover', family: 'zero-divisor', split: 'holdout',
    task: 'Compute inventory turnover from the mean of the monthly stock snapshots. A period whose average stock is zero, including one with no snapshots, has no turnover: return null so the report shows n/a.',
    base: {
      'src/inventory.ts': code`
export type Period = { costOfGoodsSold: number; openingStock: number; closingStock: number };

/** Inventory turnover for a period, or null when the period held no stock. */
export function turnover(period: Period): number | null {
  const averageStock = (period.openingStock + period.closingStock) / 2;
  if (averageStock === 0) return null;
  return period.costOfGoodsSold / averageStock;
}
`,
      'src/stats.ts': code`
/** Arithmetic mean; the mean of no values is 0. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
`,
      'src/reports.ts': code`
import { turnover, type Period } from './inventory.js';

export function formatTurnover(period: Period): string {
  const value = turnover(period);
  return value === null ? 'n/a' : value.toFixed(2) + 'x';
}
`,
      'test/inventory.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnover } from '../src/inventory.js';

test('divides cost of goods by average stock', () => {
  assert.equal(turnover({ costOfGoodsSold: 120, openingStock: 10, closingStock: 30 }), 6);
});
`,
    },
    defect: {
      'src/inventory.ts': code`
import { mean } from './stats.js';

export type Period = { costOfGoodsSold: number; monthlyStock: number[] };

/** Inventory turnover for a period, or null when the period held no stock. */
export function turnover(period: Period): number | null {
  const averageStock = mean(period.monthlyStock);
  return period.costOfGoodsSold / averageStock;
}
`,
      'test/inventory.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnover } from '../src/inventory.js';

test('divides cost of goods by mean monthly stock', () => {
  assert.equal(turnover({ costOfGoodsSold: 120, monthlyStock: [10, 30] }), 6);
});
`,
    },
    clean: {
      'src/inventory.ts': code`
import { mean } from './stats.js';

export type Period = { costOfGoodsSold: number; monthlyStock: number[] };

/** Inventory turnover for a period, or null when the period held no stock. */
export function turnover(period: Period): number | null {
  const averageStock = mean(period.monthlyStock);
  if (averageStock === 0) return null;
  return period.costOfGoodsSold / averageStock;
}
`,
      'test/inventory.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnover } from '../src/inventory.js';

test('divides cost of goods by mean monthly stock', () => {
  assert.equal(turnover({ costOfGoodsSold: 120, monthlyStock: [10, 30] }), 6);
});
`,
    },
  }),
  pair({
    id: 'zd-uptime', family: 'zero-divisor', split: 'holdout',
    task: 'Exclude scheduled maintenance windows from uptime. When every window is maintenance, or nothing was monitored, uptime is 100%; the status page must never show NaN.',
    base: {
      'src/uptime.ts': code`
export type Window = { minutes: number; downMinutes: number };

/** Uptime percentage over the monitored windows. With nothing monitored, uptime is 100. */
export function uptimePercent(windows: Window[]): number {
  const monitored = windows.reduce((sum, window) => sum + window.minutes, 0);
  if (monitored === 0) return 100;
  const down = windows.reduce((sum, window) => sum + window.downMinutes, 0);
  return ((monitored - down) / monitored) * 100;
}
`,
      'src/status-page.ts': code`
import { uptimePercent, type Window } from './uptime.js';

export function uptimeLabel(windows: Window[]): string {
  return uptimePercent(windows).toFixed(3) + '% uptime';
}
`,
      'test/uptime.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uptimePercent } from '../src/uptime.js';

test('reports uptime', () => {
  assert.equal(uptimePercent([{ minutes: 100, downMinutes: 1 }]), 99);
});
`,
    },
    defect: {
      'src/uptime.ts': code`
export type Window = { minutes: number; downMinutes: number; maintenance: boolean };

/** Uptime percentage over the monitored windows, excluding maintenance. With nothing monitored, uptime is 100. */
export function uptimePercent(windows: Window[]): number {
  const counted = windows.filter(window => !window.maintenance);
  const monitored = counted.reduce((sum, window) => sum + window.minutes, 0);
  const down = counted.reduce((sum, window) => sum + window.downMinutes, 0);
  return ((monitored - down) / monitored) * 100;
}
`,
    },
    clean: {
      'src/uptime.ts': code`
export type Window = { minutes: number; downMinutes: number; maintenance: boolean };

/** Uptime percentage over the monitored windows, excluding maintenance. With nothing monitored, uptime is 100. */
export function uptimePercent(windows: Window[]): number {
  const counted = windows.filter(window => !window.maintenance);
  const monitored = counted.reduce((sum, window) => sum + window.minutes, 0);
  if (monitored === 0) return 100;
  const down = counted.reduce((sum, window) => sum + window.downMinutes, 0);
  return ((monitored - down) / monitored) * 100;
}
`,
    },
  }),
  pair({
    id: 'zd-currency-convert', family: 'zero-divisor', split: 'holdout',
    task: 'Accept common currency aliases such as RMB for CNY. Unknown currencies must still throw UnknownCurrencyError, and convert must never return Infinity or NaN for a rate table that passed loadRates.',
    base: {
      'src/fx.ts': code`
export class UnknownCurrencyError extends Error {}

export type RateTable = Record<string, number>;

/** Validates a rate table from the treasury feed. Every rate is quoted against USD and must be positive. */
export function loadRates(raw: Record<string, unknown>): RateTable {
  const rates: RateTable = {};
  for (const [currency, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !(value > 0)) throw new RangeError('Invalid rate for ' + currency);
    rates[currency.toUpperCase()] = value;
  }
  return rates;
}

/** Converts between currencies. Unknown currencies throw UnknownCurrencyError. */
export function convert(amount: number, from: string, to: string, rates: RateTable): number {
  const fromRate = rates[from];
  const toRate = rates[to];
  if (fromRate === undefined || toRate === undefined) throw new UnknownCurrencyError(from + '->' + to);
  return (amount / fromRate) * toRate;
}
`,
      'src/invoice.ts': code`
import { convert, type RateTable } from './fx.js';

export function invoiceTotal(lines: Array<{ amount: number; currency: string }>, currency: string, rates: RateTable): number {
  return lines.reduce((sum, line) => sum + convert(line.amount, line.currency, currency, rates), 0);
}
`,
      'test/fx.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, loadRates, UnknownCurrencyError } from '../src/fx.js';

const rates = loadRates({ USD: 1, EUR: 0.5 });

test('converts through USD', () => {
  assert.equal(convert(10, 'EUR', 'USD', rates), 20);
});

test('rejects unknown currencies', () => {
  assert.throws(() => convert(10, 'XYZ', 'USD', rates), UnknownCurrencyError);
});
`,
    },
    defect: {
      'src/fx.ts': code`
export class UnknownCurrencyError extends Error {}

export type RateTable = Record<string, number>;

const ALIASES: Record<string, string> = { RMB: 'CNY', NIS: 'ILS' };
const currencyCode = (currency: string) => ALIASES[currency.toUpperCase()] ?? currency.toUpperCase();

/** Validates a rate table from the treasury feed. Every rate is quoted against USD and must be positive. */
export function loadRates(raw: Record<string, unknown>): RateTable {
  const rates: RateTable = {};
  for (const [currency, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !(value > 0)) throw new RangeError('Invalid rate for ' + currency);
    rates[currency.toUpperCase()] = value;
  }
  return rates;
}

/** Converts between currencies. Unknown currencies throw UnknownCurrencyError. */
export function convert(amount: number, from: string, to: string, rates: RateTable): number {
  const fromRate = rates[currencyCode(from)] ?? 0;
  const toRate = rates[currencyCode(to)] ?? 0;
  return (amount / fromRate) * toRate;
}
`,
    },
    clean: {
      'src/fx.ts': code`
export class UnknownCurrencyError extends Error {}

export type RateTable = Record<string, number>;

const ALIASES: Record<string, string> = { RMB: 'CNY', NIS: 'ILS' };
const currencyCode = (currency: string) => ALIASES[currency.toUpperCase()] ?? currency.toUpperCase();

/** Validates a rate table from the treasury feed. Every rate is quoted against USD and must be positive. */
export function loadRates(raw: Record<string, unknown>): RateTable {
  const rates: RateTable = {};
  for (const [currency, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !(value > 0)) throw new RangeError('Invalid rate for ' + currency);
    rates[currency.toUpperCase()] = value;
  }
  return rates;
}

/** Converts between currencies. Unknown currencies throw UnknownCurrencyError. */
export function convert(amount: number, from: string, to: string, rates: RateTable): number {
  const fromRate = rates[currencyCode(from)];
  const toRate = rates[currencyCode(to)];
  if (fromRate === undefined || toRate === undefined) throw new UnknownCurrencyError(from + '->' + to);
  return (amount / fromRate) * toRate;
}
`,
    },
  }),
  pair({
    id: 'zd-payout-bigint', family: 'zero-divisor', split: 'holdout',
    task: 'Skip frozen accounts when allocating a payout. Accounts that sold their position stay listed with 0 shares. When the eligible shares total zero, allocate returns an empty map; it must never throw.',
    base: {
      'src/payout.ts': code`
export type Holder = { account: string; shares: bigint };

/** Splits a payout in minor units across holders by share count; the remainder stays in the treasury. */
export function allocate(payout: bigint, holders: Holder[]): Map<string, bigint> {
  const totalShares = holders.reduce((sum, holder) => sum + holder.shares, 0n);
  if (totalShares === 0n) return new Map();
  return new Map(holders.map(holder => [holder.account, (payout * holder.shares) / totalShares]));
}
`,
      'src/distribution.ts': code`
import { allocate, type Holder } from './payout.js';

export interface Ledger { credit(account: string, amount: bigint): void }

export function runDistribution(ledger: Ledger, payout: bigint, holders: Holder[]): void {
  for (const [account, amount] of allocate(payout, holders)) ledger.credit(account, amount);
}
`,
      'test/payout.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/payout.js';

test('allocates by share count', () => {
  assert.equal(allocate(100n, [{ account: 'a', shares: 1n }, { account: 'b', shares: 3n }]).get('b'), 75n);
});
`,
    },
    defect: {
      'src/payout.ts': code`
export type Holder = { account: string; shares: bigint; frozen: boolean };

/** Splits a payout in minor units across unfrozen holders by share count; the remainder stays in the treasury. */
export function allocate(payout: bigint, holders: Holder[]): Map<string, bigint> {
  const eligible = holders.filter(holder => !holder.frozen);
  const totalShares = eligible.reduce((sum, holder) => sum + holder.shares, 0n);
  return new Map(eligible.map(holder => [holder.account, (payout * holder.shares) / totalShares]));
}
`,
    },
    clean: {
      'src/payout.ts': code`
export type Holder = { account: string; shares: bigint; frozen: boolean };

/** Splits a payout in minor units across unfrozen holders by share count; the remainder stays in the treasury. */
export function allocate(payout: bigint, holders: Holder[]): Map<string, bigint> {
  const eligible = holders.filter(holder => !holder.frozen);
  const totalShares = eligible.reduce((sum, holder) => sum + holder.shares, 0n);
  if (totalShares === 0n) return new Map();
  return new Map(eligible.map(holder => [holder.account, (payout * holder.shares) / totalShares]));
}
`,
    },
  }),
  pair({
    id: 'zd-chart-scale', family: 'zero-divisor', split: 'holdout',
    task: "Pad the chart's vertical domain by 5% of its range so points do not touch the edges. A flat series, where every value is equal, must still draw at mid-height; toPixelY must always return a finite number.",
    base: {
      'src/scale.js': code`
/** Maps a value in [min, max] to a y pixel in [height, 0]. A flat series draws at mid-height. */
export function toPixelY(value, min, max, height) {
  if (max === min) return height / 2;
  return height - ((value - min) / (max - min)) * height;
}
`,
      'src/sparkline.js': code`
import { toPixelY } from './scale.js';

export function points(values, width, height) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => [index * step, toPixelY(value, min, max, height)]);
}
`,
      'test/scale.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPixelY } from '../src/scale.js';

test('maps the maximum to the top', () => {
  assert.equal(toPixelY(10, 0, 10, 100), 0);
});

test('draws a flat series at mid-height', () => {
  assert.equal(toPixelY(5, 5, 5, 100), 50);
});
`,
    },
    defect: {
      'src/scale.js': code`
/** Maps a value to a y pixel in [height, 0], padding the domain by 5% of its range. A flat series draws at mid-height. */
export function toPixelY(value, min, max, height) {
  const pad = (max - min) * 0.05;
  const low = min - pad;
  const high = max + pad;
  return height - ((value - low) / (high - low)) * height;
}
`,
    },
    clean: {
      'src/scale.js': code`
/** Maps a value to a y pixel in [height, 0], padding the domain by 5% of its range. A flat series draws at mid-height. */
export function toPixelY(value, min, max, height) {
  if (max === min) return height / 2;
  const pad = (max - min) * 0.05;
  const low = min - pad;
  const high = max + pad;
  return height - ((value - low) / (high - low)) * height;
}
`,
    },
  }),

  // Swallowed failure, development.
  pair({
    id: 'sf-settings-save', family: 'swallowed-failure', split: 'development',
    task: 'Log storage failures when saving settings, including the storage key. saveSettings must still resolve false when the write fails, so the panel shows the retry banner; true means the settings were persisted.',
    base: {
      'src/settings.ts': code`
export interface SettingsStore { write(key: string, value: string): Promise<void> }
export interface Logger { warn(message: string, fields: Record<string, string>): void }
export type Settings = { theme: 'light' | 'dark'; locale: string };

/** Persists settings. Resolves true only when the write succeeded, and false when storage rejected it. */
export async function saveSettings(store: SettingsStore, settings: Settings): Promise<boolean> {
  return store.write('settings', JSON.stringify(settings)).then(() => true, () => false);
}
`,
      'src/settings-panel.ts': code`
import { saveSettings, type Settings, type SettingsStore } from './settings.js';

export interface Ui { toast(message: string): void; banner(message: string): void }

export async function onSave(store: SettingsStore, settings: Settings, ui: Ui): Promise<void> {
  if (await saveSettings(store, settings)) ui.toast('Settings saved');
  else ui.banner('Settings could not be saved. Try again.');
}
`,
      'test/settings.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings } from '../src/settings.js';

test('resolves false when storage fails', async () => {
  const store = { write: async () => { throw new Error('quota exceeded'); } };
  assert.equal(await saveSettings(store, { theme: 'dark', locale: 'en' }), false);
});
`,
    },
    defect: {
      'src/settings.ts': code`
export interface SettingsStore { write(key: string, value: string): Promise<void> }
export interface Logger { warn(message: string, fields: Record<string, string>): void }
export type Settings = { theme: 'light' | 'dark'; locale: string };

/** Persists settings. Resolves true only when the write succeeded, and false when storage rejected it. */
export async function saveSettings(store: SettingsStore, settings: Settings, log: Logger = console): Promise<boolean> {
  try {
    await store.write('settings', JSON.stringify(settings));
  } catch (error) {
    log.warn('settings write failed', { key: 'settings', error: String(error) });
  }
  return true;
}
`,
    },
    clean: {
      'src/settings.ts': code`
export interface SettingsStore { write(key: string, value: string): Promise<void> }
export interface Logger { warn(message: string, fields: Record<string, string>): void }
export type Settings = { theme: 'light' | 'dark'; locale: string };

/** Persists settings. Resolves true only when the write succeeded, and false when storage rejected it. */
export async function saveSettings(store: SettingsStore, settings: Settings, log: Logger = console): Promise<boolean> {
  try {
    await store.write('settings', JSON.stringify(settings));
    return true;
  } catch (error) {
    log.warn('settings write failed', { key: 'settings', error: String(error) });
    return false;
  }
}
`,
    },
  }),
  pair({
    id: 'sf-payment-capture', family: 'swallowed-failure', split: 'development',
    task: "Count gateway errors in the payments.capture_error metric and report them as { status: 'failed', reason } instead of throwing. Orders ship only after a real capture, so a gateway error must never produce status 'captured'.",
    base: {
      'src/payments.ts': code`
export interface Gateway { capture(orderId: string, amountCents: number): Promise<{ id: string }> }
export interface Metrics { increment(name: string): void }
export type CaptureResult = { status: 'captured'; captureId: string } | { status: 'failed'; reason: string };

export async function capturePayment(gateway: Gateway, metrics: Metrics, orderId: string, amountCents: number): Promise<CaptureResult> {
  const capture = await gateway.capture(orderId, amountCents);
  return { status: 'captured', captureId: capture.id };
}
`,
      'src/fulfillment.ts': code`
import { capturePayment, type Gateway, type Metrics } from './payments.js';

export interface Warehouse { ship(orderId: string): Promise<void> }

export async function completeOrder(order: { id: string; totalCents: number }, gateway: Gateway, metrics: Metrics, warehouse: Warehouse) {
  const result = await capturePayment(gateway, metrics, order.id, order.totalCents);
  if (result.status === 'captured') await warehouse.ship(order.id);
  return result;
}
`,
      'test/payments.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePayment } from '../src/payments.js';

test('captures a payment', async () => {
  const gateway = { capture: async () => ({ id: 'cap_1' }) };
  assert.deepEqual(await capturePayment(gateway, { increment() {} }, 'o1', 500), { status: 'captured', captureId: 'cap_1' });
});
`,
    },
    defect: {
      'src/payments.ts': code`
export interface Gateway { capture(orderId: string, amountCents: number): Promise<{ id: string }> }
export interface Metrics { increment(name: string): void }
export type CaptureResult = { status: 'captured'; captureId: string } | { status: 'failed'; reason: string };

export async function capturePayment(gateway: Gateway, metrics: Metrics, orderId: string, amountCents: number): Promise<CaptureResult> {
  let captureId = 'pending-' + orderId;
  try {
    captureId = (await gateway.capture(orderId, amountCents)).id;
  } catch (error) {
    metrics.increment('payments.capture_error');
  }
  return { status: 'captured', captureId };
}
`,
    },
    clean: {
      'src/payments.ts': code`
export interface Gateway { capture(orderId: string, amountCents: number): Promise<{ id: string }> }
export interface Metrics { increment(name: string): void }
export type CaptureResult = { status: 'captured'; captureId: string } | { status: 'failed'; reason: string };

export async function capturePayment(gateway: Gateway, metrics: Metrics, orderId: string, amountCents: number): Promise<CaptureResult> {
  try {
    const capture = await gateway.capture(orderId, amountCents);
    return { status: 'captured', captureId: capture.id };
  } catch (error) {
    metrics.increment('payments.capture_error');
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
`,
    },
  }),
  pair({
    id: 'sf-profile-cache', family: 'swallowed-failure', split: 'development',
    task: 'Serve profiles through the cache first. The cache is best-effort: a cache failure falls back to the database. getProfile resolves null only for a missing profile; database failures must reject so the route returns 503 rather than 404.',
    base: {
      'src/profiles.ts': code`
export type Profile = { id: string; name: string };
export interface Db { loadProfile(id: string): Promise<Profile | null> }
export interface ProfileCache { get(id: string): Promise<Profile | undefined>; set(id: string, profile: Profile): Promise<void> }
export type ProfileDeps = { db: Db; cache: ProfileCache };

/** Loads a profile. Resolves null only when the profile does not exist; database errors reject. */
export async function getProfile(deps: ProfileDeps, id: string): Promise<Profile | null> {
  return deps.db.loadProfile(id);
}
`,
      'src/routes/profile.ts': code`
import { getProfile, type ProfileDeps } from '../profiles.js';

/** GET /profiles/:id. The framework turns a rejected handler into a 503 response. */
export async function profileRoute(deps: ProfileDeps, id: string) {
  const profile = await getProfile(deps, id);
  return profile ? { status: 200, body: profile } : { status: 404 };
}
`,
      'test/profiles.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfile } from '../src/profiles.js';

test('database failures reject', async () => {
  const deps = { db: { loadProfile: async () => { throw new Error('connection reset'); } }, cache: { get: async () => undefined, set: async () => {} } };
  await assert.rejects(getProfile(deps, 'p1'));
});
`,
    },
    defect: {
      'src/profiles.ts': code`
export type Profile = { id: string; name: string };
export interface Db { loadProfile(id: string): Promise<Profile | null> }
export interface ProfileCache { get(id: string): Promise<Profile | undefined>; set(id: string, profile: Profile): Promise<void> }
export type ProfileDeps = { db: Db; cache: ProfileCache };

/** Loads a profile through the cache. Resolves null only when the profile does not exist; database errors reject. */
export async function getProfile(deps: ProfileDeps, id: string): Promise<Profile | null> {
  try {
    const cached = await deps.cache.get(id);
    if (cached) return cached;
    const profile = await deps.db.loadProfile(id);
    if (profile) await deps.cache.set(id, profile);
    return profile;
  } catch {
    return null;
  }
}
`,
    },
    clean: {
      'src/profiles.ts': code`
export type Profile = { id: string; name: string };
export interface Db { loadProfile(id: string): Promise<Profile | null> }
export interface ProfileCache { get(id: string): Promise<Profile | undefined>; set(id: string, profile: Profile): Promise<void> }
export type ProfileDeps = { db: Db; cache: ProfileCache };

/** Loads a profile through the cache. Resolves null only when the profile does not exist; database errors reject. */
export async function getProfile(deps: ProfileDeps, id: string): Promise<Profile | null> {
  let cached: Profile | undefined;
  try {
    cached = await deps.cache.get(id);
  } catch {
    cached = undefined; // Best effort: a cache outage falls back to the database.
  }
  if (cached) return cached;
  const profile = await deps.db.loadProfile(id);
  if (profile) void deps.cache.set(id, profile).catch(() => undefined);
  return profile;
}
`,
    },
  }),
  pair({
    id: 'sf-migrations', family: 'swallowed-failure', split: 'development',
    task: 'Log the name of any migration that fails. The contract is unchanged: the first failing migration stops the run, nothing after it is applied, and migrate rejects so the deploy command exits non-zero.',
    base: {
      'src/migrate.ts': code`
export interface Db { applied(): Promise<Set<string>>; markApplied(name: string): Promise<void> }
export type Migration = { name: string; up(db: Db): Promise<void> };
export interface Logger { error(message: string, fields: Record<string, string>): void }

export class MigrationError extends Error {
  constructor(readonly migration: string, options?: ErrorOptions) { super('Migration failed: ' + migration, options); }
}

/** Applies pending migrations in order and returns how many ran. The first failure rejects and stops the run. */
export async function migrate(db: Db, migrations: Migration[]): Promise<number> {
  const done = await db.applied();
  let count = 0;
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await migration.up(db);
    await db.markApplied(migration.name);
    count++;
  }
  return count;
}
`,
      'src/deploy.ts': code`
import { migrate, type Db, type Migration } from './migrate.js';

/** Deploy step; a rejected migrate makes the deploy exit non-zero. */
export async function deploy(db: Db, migrations: Migration[], out: { write(text: string): void }): Promise<void> {
  const count = await migrate(db, migrations);
  out.write('Applied ' + count + ' migration(s).\n');
}
`,
      'test/migrate.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';

test('stops at the first failing migration', async () => {
  const marked: string[] = [];
  const db = { applied: async () => new Set<string>(), markApplied: async (name: string) => { marked.push(name); } };
  const migrations = [
    { name: '001', up: async () => { throw new Error('syntax error'); } },
    { name: '002', up: async () => {} },
  ];
  await assert.rejects(migrate(db, migrations));
  assert.deepEqual(marked, []);
});
`,
    },
    defect: {
      'src/migrate.ts': code`
export interface Db { applied(): Promise<Set<string>>; markApplied(name: string): Promise<void> }
export type Migration = { name: string; up(db: Db): Promise<void> };
export interface Logger { error(message: string, fields: Record<string, string>): void }

export class MigrationError extends Error {
  constructor(readonly migration: string, options?: ErrorOptions) { super('Migration failed: ' + migration, options); }
}

/** Applies pending migrations in order and returns how many ran. The first failure rejects and stops the run. */
export async function migrate(db: Db, migrations: Migration[], log: Logger = console): Promise<number> {
  const done = await db.applied();
  let count = 0;
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    try {
      await migration.up(db);
      await db.markApplied(migration.name);
      count++;
    } catch (error) {
      log.error('migration failed', { migration: migration.name, error: String(error) });
    }
  }
  return count;
}
`,
    },
    clean: {
      'src/migrate.ts': code`
export interface Db { applied(): Promise<Set<string>>; markApplied(name: string): Promise<void> }
export type Migration = { name: string; up(db: Db): Promise<void> };
export interface Logger { error(message: string, fields: Record<string, string>): void }

export class MigrationError extends Error {
  constructor(readonly migration: string, options?: ErrorOptions) { super('Migration failed: ' + migration, options); }
}

/** Applies pending migrations in order and returns how many ran. The first failure rejects and stops the run. */
export async function migrate(db: Db, migrations: Migration[], log: Logger = console): Promise<number> {
  const done = await db.applied();
  let count = 0;
  let failure: MigrationError | undefined;
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    try {
      await migration.up(db);
    } catch (error) {
      log.error('migration failed', { migration: migration.name, error: String(error) });
      failure = new MigrationError(migration.name, { cause: error });
      break;
    }
    await db.markApplied(migration.name);
    count++;
  }
  if (failure) throw failure;
  return count;
}
`,
    },
  }),
  pair({
    id: 'sf-webhook-fanout', family: 'swallowed-failure', split: 'development',
    task: 'Keep delivering to the remaining endpoints when one endpoint throws a network error. Every endpoint that was not delivered, whether it returned a non-2xx status or threw, must appear in failed so it is retried.',
    base: {
      'src/webhooks.js': code`
/** Delivers an event to every endpoint. Returns the URLs that failed so the caller can schedule retries. */
export async function deliverAll(event, endpoints, post) {
  const failed = [];
  for (const url of endpoints) {
    const response = await post(url, event);
    if (!response.ok) failed.push(url);
  }
  return { delivered: endpoints.length - failed.length, failed };
}
`,
      'src/events.js': code`
import { deliverAll } from './webhooks.js';

export async function publish(event, endpoints, post, retryQueue) {
  const { failed } = await deliverAll(event, endpoints, post);
  for (const url of failed) retryQueue.add({ url, event });
}
`,
      'test/webhooks.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverAll } from '../src/webhooks.js';

test('reports endpoints that answered with an error status', async () => {
  const post = async url => ({ ok: url !== 'https://b.example' });
  assert.deepEqual(await deliverAll({}, ['https://a.example', 'https://b.example'], post), { delivered: 1, failed: ['https://b.example'] });
});
`,
    },
    defect: {
      'src/webhooks.js': code`
/** Delivers an event to every endpoint. Returns the URLs that failed so the caller can schedule retries. */
export async function deliverAll(event, endpoints, post) {
  const failed = [];
  for (const url of endpoints) {
    try {
      const response = await post(url, event);
      if (!response.ok) failed.push(url);
    } catch {
      // Keep going: one unreachable endpoint must not block the others.
    }
  }
  return { delivered: endpoints.length - failed.length, failed };
}
`,
    },
    clean: {
      'src/webhooks.js': code`
/** Delivers an event to every endpoint. Returns the URLs that failed so the caller can schedule retries. */
export async function deliverAll(event, endpoints, post) {
  const failed = [];
  for (const url of endpoints) {
    try {
      const response = await post(url, event);
      if (!response.ok) failed.push(url);
    } catch {
      // Keep going: record the unreachable endpoint for a retry and continue with the others.
      failed.push(url);
    }
  }
  return { delivered: endpoints.length - failed.length, failed };
}
`,
    },
  }),

  // Swallowed failure, holdout.
  pair({
    id: 'sf-report-export', family: 'swallowed-failure', split: 'holdout',
    task: 'Create the output directory when it does not exist, then write the report. Any other write failure, such as a permission error or a full disk, must still reject so the CLI exits with status 1.',
    base: {
      'src/export.ts': code`
export interface Files { writeFile(path: string, data: string): Promise<void>; mkdir(path: string): Promise<void> }

/** Writes the report as CSV. Rejects when the file cannot be written. */
export async function exportReport(files: Files, path: string, rows: string[][]): Promise<void> {
  const csv = rows.map(row => row.join(',')).join('\n');
  await files.writeFile(path, csv);
}
`,
      'src/cli/export-command.ts': code`
import { exportReport, type Files } from '../export.js';

/** Exit status 0 on success and 1 when the report could not be written. */
export async function exportCommand(files: Files, out: string, rows: string[][]): Promise<number> {
  return exportReport(files, out, rows).then(() => 0, () => 1);
}
`,
      'test/export.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportReport } from '../src/export.js';

test('writes CSV', async () => {
  let written = '';
  await exportReport({ writeFile: async (_path, data) => { written = data; }, mkdir: async () => {} }, 'out.csv', [['a', 'b']]);
  assert.equal(written, 'a,b');
});
`,
    },
    defect: {
      'src/export.ts': code`
import { dirname } from 'node:path';

export interface Files { writeFile(path: string, data: string): Promise<void>; mkdir(path: string): Promise<void> }

const isMissingDirectory = (error: unknown) => (error as { code?: string }).code === 'ENOENT';

/** Writes the report as CSV, creating the output directory if needed. Rejects when the file cannot be written. */
export async function exportReport(files: Files, path: string, rows: string[][]): Promise<void> {
  const csv = rows.map(row => row.join(',')).join('\n');
  try {
    await files.writeFile(path, csv);
  } catch (error) {
    if (isMissingDirectory(error)) {
      await files.mkdir(dirname(path));
      await files.writeFile(path, csv);
    }
  }
}
`,
    },
    clean: {
      'src/export.ts': code`
import { dirname } from 'node:path';

export interface Files { writeFile(path: string, data: string): Promise<void>; mkdir(path: string): Promise<void> }

const isMissingDirectory = (error: unknown) => (error as { code?: string }).code === 'ENOENT';

/** Writes the report as CSV, creating the output directory if needed. Rejects when the file cannot be written. */
export async function exportReport(files: Files, path: string, rows: string[][]): Promise<void> {
  const csv = rows.map(row => row.join(',')).join('\n');
  try {
    await files.writeFile(path, csv);
  } catch (error) {
    if (!isMissingDirectory(error)) throw error;
    await files.mkdir(dirname(path));
    await files.writeFile(path, csv);
  }
}
`,
    },
  }),
  pair({
    id: 'sf-feature-flags', family: 'swallowed-failure', split: 'holdout',
    task: "Make flag lookups best-effort: when the flag service fails, count flags.fallback and use the flag's compiled-in default from DEFAULTS, which is false for unknown flags. An outage must not turn on unreleased features.",
    base: {
      'src/flags.ts': code`
export interface FlagService { isEnabled(flag: string, userId: string): Promise<boolean> }
export interface Metrics { increment(name: string): void }

/** Compiled-in defaults, used when the flag service is unavailable. */
export const DEFAULTS: Record<string, boolean> = { newCheckout: false, darkMode: true };

export async function flagEnabled(service: FlagService, metrics: Metrics, flag: string, userId: string): Promise<boolean> {
  return service.isEnabled(flag, userId);
}
`,
      'src/checkout.ts': code`
import { flagEnabled, type FlagService, type Metrics } from './flags.js';

export async function checkoutVersion(service: FlagService, metrics: Metrics, userId: string): Promise<'v1' | 'v2'> {
  return (await flagEnabled(service, metrics, 'newCheckout', userId)) ? 'v2' : 'v1';
}
`,
      'test/flags.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagEnabled } from '../src/flags.js';

test('reads a flag from the service', async () => {
  assert.equal(await flagEnabled({ isEnabled: async () => true }, { increment() {} }, 'darkMode', 'u1'), true);
});
`,
    },
    defect: {
      'src/flags.ts': code`
export interface FlagService { isEnabled(flag: string, userId: string): Promise<boolean> }
export interface Metrics { increment(name: string): void }

/** Compiled-in defaults, used when the flag service is unavailable. */
export const DEFAULTS: Record<string, boolean> = { newCheckout: false, darkMode: true };

export async function flagEnabled(service: FlagService, metrics: Metrics, flag: string, userId: string): Promise<boolean> {
  try {
    return await service.isEnabled(flag, userId);
  } catch {
    metrics.increment('flags.fallback');
    return true;
  }
}
`,
    },
    clean: {
      'src/flags.ts': code`
export interface FlagService { isEnabled(flag: string, userId: string): Promise<boolean> }
export interface Metrics { increment(name: string): void }

/** Compiled-in defaults, used when the flag service is unavailable. */
export const DEFAULTS: Record<string, boolean> = { newCheckout: false, darkMode: true };

export async function flagEnabled(service: FlagService, metrics: Metrics, flag: string, userId: string): Promise<boolean> {
  try {
    return await service.isEnabled(flag, userId);
  } catch {
    metrics.increment('flags.fallback');
    return DEFAULTS[flag] ?? false;
  }
}
`,
    },
  }),
  pair({
    id: 'sf-order-import', family: 'swallowed-failure', split: 'holdout',
    task: 'Record rows that fail validation by line number in rejected and keep importing the rest. A database failure is not a bad row: it must abort the import by rejecting, so the nightly job is retried.',
    base: {
      'src/import-orders.ts': code`
export class ValidationError extends Error {}
export type Row = Record<string, string | undefined>;
export type Order = { sku: string; quantity: number };
export interface OrderDb { insert(order: Order): Promise<void> }

function toOrder(row: Row): Order {
  const quantity = Number(row.quantity);
  if (!row.sku || !Number.isInteger(quantity) || quantity < 1) throw new ValidationError('Invalid order row');
  return { sku: row.sku, quantity };
}

/** Imports order rows. Returns how many were imported and the one-based line numbers of rejected rows. */
export async function importOrders(db: OrderDb, rows: Row[]): Promise<{ imported: number; rejected: number[] }> {
  let imported = 0;
  for (const row of rows) {
    await db.insert(toOrder(row));
    imported++;
  }
  return { imported, rejected: [] };
}
`,
      'src/jobs/nightly-import.ts': code`
import { importOrders, type OrderDb, type Row } from '../import-orders.js';

/** The scheduler retries the nightly job when it rejects. */
export async function nightlyImport(db: OrderDb, rows: Row[], report: (summary: string) => void): Promise<void> {
  const result = await importOrders(db, rows);
  report(result.imported + ' imported, ' + result.rejected.length + ' rejected');
}
`,
      'test/import-orders.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importOrders } from '../src/import-orders.js';

test('imports valid rows', async () => {
  const db = { insert: async () => {} };
  assert.deepEqual(await importOrders(db, [{ sku: 'A1', quantity: '2' }]), { imported: 1, rejected: [] });
});
`,
    },
    defect: {
      'src/import-orders.ts': code`
export class ValidationError extends Error {}
export type Row = Record<string, string | undefined>;
export type Order = { sku: string; quantity: number };
export interface OrderDb { insert(order: Order): Promise<void> }

function toOrder(row: Row): Order {
  const quantity = Number(row.quantity);
  if (!row.sku || !Number.isInteger(quantity) || quantity < 1) throw new ValidationError('Invalid order row');
  return { sku: row.sku, quantity };
}

/** Imports order rows. Returns how many were imported and the one-based line numbers of rejected rows. */
export async function importOrders(db: OrderDb, rows: Row[]): Promise<{ imported: number; rejected: number[] }> {
  let imported = 0;
  const rejected: number[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      await db.insert(toOrder(row));
      imported++;
    } catch {
      rejected.push(index + 2); // Line 1 is the header.
    }
  }
  return { imported, rejected };
}
`,
    },
    clean: {
      'src/import-orders.ts': code`
export class ValidationError extends Error {}
export type Row = Record<string, string | undefined>;
export type Order = { sku: string; quantity: number };
export interface OrderDb { insert(order: Order): Promise<void> }

function toOrder(row: Row): Order {
  const quantity = Number(row.quantity);
  if (!row.sku || !Number.isInteger(quantity) || quantity < 1) throw new ValidationError('Invalid order row');
  return { sku: row.sku, quantity };
}

/** Imports order rows. Returns how many were imported and the one-based line numbers of rejected rows. */
export async function importOrders(db: OrderDb, rows: Row[]): Promise<{ imported: number; rejected: number[] }> {
  let imported = 0;
  const rejected: number[] = [];
  for (const [index, row] of rows.entries()) {
    let order: Order;
    try {
      order = toOrder(row);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      rejected.push(index + 2); // Line 1 is the header.
      continue;
    }
    await db.insert(order);
    imported++;
  }
  return { imported, rejected };
}
`,
    },
  }),
  pair({
    id: 'sf-token-refresh', family: 'swallowed-failure', split: 'holdout',
    task: "Handle refresh failures. When the refresh call fails, clear the session and resolve { ok: false, reason: 'expired' } so the client redirects to sign-in; never report an expired token as refreshed.",
    base: {
      'src/auth.ts': code`
export type RefreshResult = { ok: true; token: string } | { ok: false; reason: 'expired' };
export interface Session { token: string; refreshToken: string; clear(): void }
export interface AuthApi { refresh(refreshToken: string): Promise<{ accessToken: string }> }

/** Refreshes the access token after a 401 response. */
export async function refreshAccessToken(api: AuthApi, session: Session): Promise<RefreshResult> {
  const { accessToken } = await api.refresh(session.refreshToken);
  session.token = accessToken;
  return { ok: true, token: accessToken };
}
`,
      'src/http.ts': code`
import { refreshAccessToken, type AuthApi, type Session } from './auth.js';

export async function onUnauthorized(api: AuthApi, session: Session, retry: (token: string) => Promise<Response>, signIn: () => void) {
  const result = await refreshAccessToken(api, session);
  if (!result.ok) return signIn();
  return retry(result.token);
}
`,
      'test/auth.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshAccessToken } from '../src/auth.js';

test('stores the refreshed token', async () => {
  const session = { token: 'old', refreshToken: 'r', clear() {} };
  assert.deepEqual(await refreshAccessToken({ refresh: async () => ({ accessToken: 'new' }) }, session), { ok: true, token: 'new' });
});
`,
    },
    defect: {
      'src/auth.ts': code`
export type RefreshResult = { ok: true; token: string } | { ok: false; reason: 'expired' };
export interface Session { token: string; refreshToken: string; clear(): void }
export interface AuthApi { refresh(refreshToken: string): Promise<{ accessToken: string }> }

/** Refreshes the access token after a 401 response. */
export async function refreshAccessToken(api: AuthApi, session: Session): Promise<RefreshResult> {
  try {
    const { accessToken } = await api.refresh(session.refreshToken);
    session.token = accessToken;
  } catch (error) {
    console.warn('token refresh failed; keeping the current token', error);
  }
  return { ok: true, token: session.token };
}
`,
    },
    clean: {
      'src/auth.ts': code`
export type RefreshResult = { ok: true; token: string } | { ok: false; reason: 'expired' };
export interface Session { token: string; refreshToken: string; clear(): void }
export interface AuthApi { refresh(refreshToken: string): Promise<{ accessToken: string }> }

/** Refreshes the access token after a 401 response. */
export async function refreshAccessToken(api: AuthApi, session: Session): Promise<RefreshResult> {
  try {
    const { accessToken } = await api.refresh(session.refreshToken);
    session.token = accessToken;
    return { ok: true, token: accessToken };
  } catch (error) {
    console.warn('token refresh failed; signing out', error);
    session.clear();
    return { ok: false, reason: 'expired' };
  }
}
`,
    },
  }),
  pair({
    id: 'sf-temp-workspace', family: 'swallowed-failure', split: 'holdout',
    task: 'Always remove the temporary workspace, even when the task fails. Cleanup is best-effort: a failed removal is logged and ignored. Task failures must still reject so the build stops before publishing.',
    base: {
      'src/workspace.js': code`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs task in a fresh temporary directory and returns its result. */
export async function withWorkspace(task) {
  const dir = await mkdtemp(join(tmpdir(), 'build-'));
  const result = await task(dir);
  await rm(dir, { recursive: true, force: true });
  return result;
}
`,
      'src/build.js': code`
import { withWorkspace } from './workspace.js';

export async function buildAndPublish(compile, publish) {
  const artifact = await withWorkspace(dir => compile(dir));
  await publish(artifact);
}
`,
      'test/workspace.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWorkspace } from '../src/workspace.js';

test('returns the task result', async () => {
  assert.equal(await withWorkspace(async () => 42), 42);
});
`,
    },
    defect: {
      'src/workspace.js': code`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs task in a fresh temporary directory and returns its result. The directory is always removed. */
export async function withWorkspace(task) {
  const dir = await mkdtemp(join(tmpdir(), 'build-'));
  try {
    return await task(dir);
  } catch (error) {
    console.warn('workspace task failed', error);
  } finally {
    await rm(dir, { recursive: true, force: true }).then(undefined, error => console.warn('could not remove ' + dir, error));
  }
}
`,
    },
    clean: {
      'src/workspace.js': code`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs task in a fresh temporary directory and returns its result. The directory is always removed. */
export async function withWorkspace(task) {
  const dir = await mkdtemp(join(tmpdir(), 'build-'));
  try {
    return await task(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn('could not remove ' + dir, error);
    }
  }
}
`,
    },
  }),

  // Unhandled JSON, development.
  pair({
    id: 'uj-create-user', family: 'unhandled-json', split: 'development',
    task: "Move request-body decoding into a reusable decodeBody helper for the other handlers. POST /users must still answer a malformed JSON body with 400 { error: 'invalid_json' } and never throw for bad input.",
    base: {
      'src/users-handler.ts': code`
export type HttpRequest = { body: string };
export type HttpResponse = { status: number; body?: unknown };
export interface UserRepo { create(input: { email: string; name: string }): Promise<{ id: string }> }

/** POST /users. Malformed JSON gets 400 { error: 'invalid_json' }; invalid fields get 422. */
export async function createUser(repo: UserRepo, request: HttpRequest): Promise<HttpResponse> {
  let input: { email?: unknown; name?: unknown };
  try {
    input = JSON.parse(request.body);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400, body: { error: 'invalid_json' } };
    throw error;
  }
  if (typeof input.email !== 'string' || typeof input.name !== 'string') return { status: 422, body: { error: 'invalid_user' } };
  return { status: 201, body: await repo.create({ email: input.email, name: input.name }) };
}
`,
      'src/router.ts': code`
import { createUser, type HttpRequest, type UserRepo } from './users-handler.js';

export function routes(repo: UserRepo) {
  return { 'POST /users': (request: HttpRequest) => createUser(repo, request) };
}
`,
      'test/users-handler.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/users-handler.js';

const repo = { create: async () => ({ id: 'u1' }) };

test('creates a user', async () => {
  assert.equal((await createUser(repo, { body: '{"email":"a@example.com","name":"A"}' })).status, 201);
});

test('rejects malformed JSON with 400', async () => {
  assert.equal((await createUser(repo, { body: '{' })).status, 400);
});
`,
    },
    defect: {
      'src/users-handler.ts': code`
export type HttpRequest = { body: string };
export type HttpResponse = { status: number; body?: unknown };
export interface UserRepo { create(input: { email: string; name: string }): Promise<{ id: string }> }

/** Decodes a JSON request body. */
export function decodeBody<T>(body: string): T {
  return JSON.parse(body) as T;
}

/** POST /users. Malformed JSON gets 400 { error: 'invalid_json' }; invalid fields get 422. */
export async function createUser(repo: UserRepo, request: HttpRequest): Promise<HttpResponse> {
  const input = decodeBody<{ email?: unknown; name?: unknown }>(request.body);
  if (typeof input.email !== 'string' || typeof input.name !== 'string') return { status: 422, body: { error: 'invalid_user' } };
  return { status: 201, body: await repo.create({ email: input.email, name: input.name }) };
}
`,
    },
    clean: {
      'src/users-handler.ts': code`
export type HttpRequest = { body: string };
export type HttpResponse = { status: number; body?: unknown };
export interface UserRepo { create(input: { email: string; name: string }): Promise<{ id: string }> }

/** Decodes a JSON request body. Throws SyntaxError for malformed JSON; handlers translate it to 400. */
export function decodeBody<T>(body: string): T {
  return JSON.parse(body) as T;
}

/** POST /users. Malformed JSON gets 400 { error: 'invalid_json' }; invalid fields get 422. */
export async function createUser(repo: UserRepo, request: HttpRequest): Promise<HttpResponse> {
  let input: { email?: unknown; name?: unknown };
  try {
    input = decodeBody(request.body);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400, body: { error: 'invalid_json' } };
    throw error;
  }
  if (typeof input.email !== 'string' || typeof input.name !== 'string') return { status: 422, body: { error: 'invalid_user' } };
  return { status: 201, body: await repo.create({ email: input.email, name: input.name }) };
}
`,
    },
  }),
  pair({
    id: 'uj-event-import', family: 'unhandled-json', split: 'development',
    task: 'Ignore blank lines and lines starting with # in event files. A malformed event line must still reject the batch with ImportError naming its one-based line number, never a raw SyntaxError, because the ingest endpoint turns ImportError into a 422 response.',
    base: {
      'src/events-import.ts': code`
export class ImportError extends Error {
  constructor(readonly line: number, options?: ErrorOptions) { super('Invalid event on line ' + line, options); }
}
export type Event = { type: string; at: string };

/** Parses newline-delimited JSON events. A malformed line rejects the batch with ImportError. */
export function parseEvents(text: string): Event[] {
  const events: Event[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.trim()) continue;
    try {
      events.push(JSON.parse(lines[index]!) as Event);
    } catch (error) {
      throw new ImportError(index + 1, { cause: error });
    }
  }
  return events;
}
`,
      'src/ingest.ts': code`
import { ImportError, parseEvents } from './events-import.js';

export function ingest(body: string, store: (events: unknown[]) => void) {
  try {
    store(parseEvents(body));
    return { status: 202 };
  } catch (error) {
    if (error instanceof ImportError) return { status: 422, line: error.line };
    throw error;
  }
}
`,
      'test/events-import.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, parseEvents } from '../src/events-import.js';

test('parses events', () => {
  assert.equal(parseEvents('{"type":"a","at":"t"}\n{"type":"b","at":"t"}').length, 2);
});

test('names the malformed line', () => {
  assert.throws(() => parseEvents('{"type":"a","at":"t"}\n{oops'), (error: unknown) => error instanceof ImportError && error.line === 2);
});
`,
    },
    defect: {
      'src/events-import.ts': code`
export class ImportError extends Error {
  constructor(readonly line: number, options?: ErrorOptions) { super('Invalid event on line ' + line, options); }
}
export type Event = { type: string; at: string };

/** Parses newline-delimited JSON events, skipping blank and # comment lines. A malformed line rejects the batch with ImportError. */
export function parseEvents(text: string): Event[] {
  return text.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => JSON.parse(line) as Event);
}
`,
    },
    clean: {
      'src/events-import.ts': code`
export class ImportError extends Error {
  constructor(readonly line: number, options?: ErrorOptions) { super('Invalid event on line ' + line, options); }
}
export type Event = { type: string; at: string };

/** Parses newline-delimited JSON events, skipping blank and # comment lines. A malformed line rejects the batch with ImportError. */
export function parseEvents(text: string): Event[] {
  let line = 0;
  try {
    return text.split('\n').flatMap((content, index) => {
      line = index + 1;
      return content.trim() && !content.startsWith('#') ? [JSON.parse(content) as Event] : [];
    });
  } catch (error) {
    throw new ImportError(line, { cause: error });
  }
}
`,
    },
  }),
  pair({
    id: 'uj-preferences', family: 'unhandled-json', split: 'development',
    task: "Also read preferences saved under the legacy 'prefs' key. Missing or corrupt saved data must fall back to DEFAULT_PREFERENCES so the app always starts.",
    base: {
      'src/preferences.ts': code`
export interface KeyValueStore { getItem(key: string): string | null }
export type Preferences = { theme: 'light' | 'dark'; fontSize: number };
export const DEFAULT_PREFERENCES: Preferences = { theme: 'light', fontSize: 14 };

/** Reads saved preferences. Missing or corrupt data falls back to the defaults. */
export function loadPreferences(storage: KeyValueStore): Preferences {
  const saved = storage.getItem('preferences');
  if (saved === null) return DEFAULT_PREFERENCES;
  try {
    return { ...DEFAULT_PREFERENCES, ...(JSON.parse(saved) as Partial<Preferences>) };
  } catch (error) {
    if (error instanceof SyntaxError) return DEFAULT_PREFERENCES;
    throw error;
  }
}
`,
      'src/app.ts': code`
import { loadPreferences, type KeyValueStore } from './preferences.js';

export function startApp(storage: KeyValueStore, applyTheme: (theme: string) => void): void {
  const preferences = loadPreferences(storage);
  applyTheme(preferences.theme);
}
`,
      'test/preferences.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, loadPreferences } from '../src/preferences.js';

test('corrupt data falls back to the defaults', () => {
  assert.deepEqual(loadPreferences({ getItem: () => '{not json' }), DEFAULT_PREFERENCES);
});
`,
    },
    defect: {
      'src/preferences.ts': code`
export interface KeyValueStore { getItem(key: string): string | null }
export type Preferences = { theme: 'light' | 'dark'; fontSize: number };
export const DEFAULT_PREFERENCES: Preferences = { theme: 'light', fontSize: 14 };

function readSaved(storage: KeyValueStore): Partial<Preferences> | null {
  const saved = storage.getItem('preferences') ?? storage.getItem('prefs');
  return saved === null ? null : (JSON.parse(saved) as Partial<Preferences>);
}

/** Reads saved preferences, including the legacy key. Missing or corrupt data falls back to the defaults. */
export function loadPreferences(storage: KeyValueStore): Preferences {
  return { ...DEFAULT_PREFERENCES, ...readSaved(storage) };
}
`,
    },
    clean: {
      'src/preferences.ts': code`
export interface KeyValueStore { getItem(key: string): string | null }
export type Preferences = { theme: 'light' | 'dark'; fontSize: number };
export const DEFAULT_PREFERENCES: Preferences = { theme: 'light', fontSize: 14 };

function readSaved(storage: KeyValueStore): Partial<Preferences> | null {
  const saved = storage.getItem('preferences') ?? storage.getItem('prefs');
  return saved === null ? null : (JSON.parse(saved) as Partial<Preferences>);
}

/** Reads saved preferences, including the legacy key. Missing or corrupt data falls back to the defaults. */
export function loadPreferences(storage: KeyValueStore): Preferences {
  try {
    return { ...DEFAULT_PREFERENCES, ...readSaved(storage) };
  } catch (error) {
    if (error instanceof SyntaxError) return DEFAULT_PREFERENCES;
    throw error;
  }
}
`,
    },
  }),
  pair({
    id: 'uj-queue-consumer', family: 'unhandled-json', split: 'development',
    task: "Accept version 2 envelopes ({ version: 2, data }) as well as bare payloads. A message whose body is not valid JSON must still be dead-lettered with reason 'invalid_json' and acknowledged, and the rest of the batch must be processed.",
    base: {
      'src/consumer.ts': code`
export type Message = { id: string; body: string };
export type OrderPlaced = { orderId: string; totalCents: number };
export interface Queue { receive(): Promise<Message[]>; ack(id: string): Promise<void>; deadLetter(message: Message, reason: string): Promise<void> }

/** Processes one batch of messages. */
export async function processBatch(queue: Queue, handle: (event: OrderPlaced) => Promise<void>): Promise<void> {
  for (const message of await queue.receive()) {
    let event: OrderPlaced;
    try {
      event = JSON.parse(message.body) as OrderPlaced;
    } catch (error) {
      if (error instanceof SyntaxError) {
        await queue.deadLetter(message, 'invalid_json');
        await queue.ack(message.id);
        continue;
      }
      throw error;
    }
    await handle(event);
    await queue.ack(message.id);
  }
}
`,
      'src/worker.ts': code`
import { processBatch, type OrderPlaced, type Queue } from './consumer.js';

/** An exception from processBatch stops the worker process. */
export async function runWorker(queue: Queue, handle: (event: OrderPlaced) => Promise<void>, running: () => boolean): Promise<void> {
  while (running()) await processBatch(queue, handle);
}
`,
      'test/consumer.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processBatch } from '../src/consumer.js';

test('dead-letters malformed messages and continues', async () => {
  const handled: string[] = [];
  const dead: string[] = [];
  const queue = {
    receive: async () => [{ id: '1', body: '{' }, { id: '2', body: '{"orderId":"o2","totalCents":5}' }],
    ack: async () => {},
    deadLetter: async (message: { id: string }) => { dead.push(message.id); },
  };
  await processBatch(queue, async event => { handled.push(event.orderId); });
  assert.deepEqual([dead, handled], [['1'], ['o2']]);
});
`,
    },
    defect: {
      'src/consumer.ts': code`
export type Message = { id: string; body: string };
export type OrderPlaced = { orderId: string; totalCents: number };
export interface Queue { receive(): Promise<Message[]>; ack(id: string): Promise<void>; deadLetter(message: Message, reason: string): Promise<void> }

function decode(message: Message): OrderPlaced {
  const parsed = JSON.parse(message.body) as OrderPlaced | { version: 2; data: OrderPlaced };
  return 'version' in parsed && parsed.version === 2 ? parsed.data : (parsed as OrderPlaced);
}

/** Processes one batch of messages. */
export async function processBatch(queue: Queue, handle: (event: OrderPlaced) => Promise<void>): Promise<void> {
  for (const message of await queue.receive()) {
    await handle(decode(message));
    await queue.ack(message.id);
  }
}
`,
    },
    clean: {
      'src/consumer.ts': code`
export type Message = { id: string; body: string };
export type OrderPlaced = { orderId: string; totalCents: number };
export interface Queue { receive(): Promise<Message[]>; ack(id: string): Promise<void>; deadLetter(message: Message, reason: string): Promise<void> }

function decode(message: Message): OrderPlaced {
  const parsed = JSON.parse(message.body) as OrderPlaced | { version: 2; data: OrderPlaced };
  return 'version' in parsed && parsed.version === 2 ? parsed.data : (parsed as OrderPlaced);
}

/** Processes one batch of messages. */
export async function processBatch(queue: Queue, handle: (event: OrderPlaced) => Promise<void>): Promise<void> {
  for (const message of await queue.receive()) {
    let event: OrderPlaced;
    try {
      event = decode(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await queue.deadLetter(message, 'invalid_json');
        await queue.ack(message.id);
        continue;
      }
      throw error;
    }
    await handle(event);
    await queue.ack(message.id);
  }
}
`,
    },
  }),
  pair({
    id: 'uj-express-batch', family: 'unhandled-json', split: 'development',
    task: "Add POST /events/batch, which accepts a JSON array of events. As with POST /events, a malformed JSON body must get 400 { error: 'invalid_json' }, not a 500 error page.",
    base: {
      'src/app.js': code`
import express from 'express';
import { recordEvent } from './events.js';

export const app = express();
app.use(express.text({ type: 'application/json' }));

/** POST /events. A malformed JSON body gets 400 { error: 'invalid_json' }. */
app.post('/events', (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
    throw error;
  }
  recordEvent(event);
  res.status(202).end();
});
`,
      'src/events.js': code`
const events = [];

export function recordEvent(event) {
  events.push({ ...event, receivedAt: Date.now() });
}
`,
      'src/server.js': code`
import { app } from './app.js';

app.listen(Number(process.env.PORT ?? 3000));
`,
      'test/app.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';

test('rejects a malformed event with 400', async () => {
  const response = await request(app).post('/events').set('content-type', 'application/json').send('{');
  assert.equal(response.status, 400);
});
`,
    },
    defect: {
      'src/app.js': code`
import express from 'express';
import { recordEvent } from './events.js';

export const app = express();
app.use(express.text({ type: 'application/json' }));

/** POST /events. A malformed JSON body gets 400 { error: 'invalid_json' }. */
app.post('/events', (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
    throw error;
  }
  recordEvent(event);
  res.status(202).end();
});

/** POST /events/batch. The body is a JSON array of events. */
app.post('/events/batch', (req, res) => {
  const events = JSON.parse(req.body);
  for (const event of events) recordEvent(event);
  res.status(202).json({ accepted: events.length });
});
`,
    },
    clean: {
      'src/app.js': code`
import express from 'express';
import { recordEvent } from './events.js';

export const app = express();
app.use(express.text({ type: 'application/json' }));

/** POST /events. A malformed JSON body gets 400 { error: 'invalid_json' }. */
app.post('/events', (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
    throw error;
  }
  recordEvent(event);
  res.status(202).end();
});

/** POST /events/batch. The body is a JSON array of events. */
app.post('/events/batch', (req, res) => {
  const events = JSON.parse(req.body);
  for (const event of events) recordEvent(event);
  res.status(202).json({ accepted: events.length });
});

// Express passes errors thrown synchronously by route handlers to this error handler.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
  next(error);
});
`,
    },
  }),

  // Unhandled JSON, holdout.
  pair({
    id: 'uj-webhook', family: 'unhandled-json', split: 'holdout',
    task: 'Accept webhook bodies that contain either one event or an array of events. A body that is not valid JSON must still get 400, and the handler must never throw for bad input.',
    base: {
      'src/webhook.ts': code`
export type WebhookRequest = { rawBody: string; signatureValid: boolean };
export type WebhookResponse = { status: 200 | 400 | 401 };
export type ProviderEvent = { id: string; type: string };

/** Dispatches a payment-provider webhook. Unsigned requests get 401 and malformed JSON gets 400. */
export function handleWebhook(request: WebhookRequest, dispatch: (event: ProviderEvent) => void): WebhookResponse {
  if (!request.signatureValid) return { status: 401 };
  let event: ProviderEvent;
  try {
    event = JSON.parse(request.rawBody) as ProviderEvent;
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400 };
    throw error;
  }
  dispatch(event);
  return { status: 200 };
}
`,
      'src/server.ts': code`
import { handleWebhook, type ProviderEvent } from './webhook.js';

export function webhookRoute(verify: (body: string, signature: string) => boolean, dispatch: (event: ProviderEvent) => void) {
  return (body: string, signature: string) => handleWebhook({ rawBody: body, signatureValid: verify(body, signature) }, dispatch);
}
`,
      'test/webhook.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook } from '../src/webhook.js';

test('malformed JSON gets 400', () => {
  assert.deepEqual(handleWebhook({ rawBody: '{', signatureValid: true }, () => {}), { status: 400 });
});
`,
    },
    defect: {
      'src/webhook.ts': code`
export type WebhookRequest = { rawBody: string; signatureValid: boolean };
export type WebhookResponse = { status: 200 | 400 | 401 };
export type ProviderEvent = { id: string; type: string };

function parseEvents(rawBody: string): ProviderEvent[] {
  const parsed = JSON.parse(rawBody) as ProviderEvent | ProviderEvent[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Dispatches a payment-provider webhook. Unsigned requests get 401 and malformed JSON gets 400. */
export function handleWebhook(request: WebhookRequest, dispatch: (event: ProviderEvent) => void): WebhookResponse {
  if (!request.signatureValid) return { status: 401 };
  for (const event of parseEvents(request.rawBody)) dispatch(event);
  return { status: 200 };
}
`,
    },
    clean: {
      'src/webhook.ts': code`
export type WebhookRequest = { rawBody: string; signatureValid: boolean };
export type WebhookResponse = { status: 200 | 400 | 401 };
export type ProviderEvent = { id: string; type: string };

function parseEvents(rawBody: string): ProviderEvent[] {
  const parsed = JSON.parse(rawBody) as ProviderEvent | ProviderEvent[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Dispatches a payment-provider webhook. Unsigned requests get 401 and malformed JSON gets 400. */
export function handleWebhook(request: WebhookRequest, dispatch: (event: ProviderEvent) => void): WebhookResponse {
  if (!request.signatureValid) return { status: 401 };
  let events: ProviderEvent[];
  try {
    events = parseEvents(request.rawBody);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400 };
    throw error;
  }
  for (const event of events) dispatch(event);
  return { status: 200 };
}
`,
    },
  }),
  pair({
    id: 'uj-catalog-metadata', family: 'unhandled-json', split: 'holdout',
    task: 'Treat an empty metadata cell as {} and trim SKUs. A row whose metadata is not valid JSON must still produce { ok: false, row } with its one-based row number; toProducts must not throw for bad metadata.',
    base: {
      'src/catalog-import.ts': code`
export type CsvRow = { sku: string; metadata: string };
export type Product = { sku: string; metadata: Record<string, unknown> };
export type ImportResult = { ok: true; products: Product[] } | { ok: false; row: number };

/** Converts catalog CSV rows. A row with malformed metadata yields { ok: false, row }. */
export function toProducts(rows: CsvRow[]): ImportResult {
  const products: Product[] = [];
  for (const [index, row] of rows.entries()) {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, row: index + 1 };
      throw error;
    }
    products.push({ sku: row.sku, metadata });
  }
  return { ok: true, products };
}
`,
      'src/routes/catalog.ts': code`
import { toProducts, type CsvRow } from '../catalog-import.js';

export function importCatalog(rows: CsvRow[], save: (products: unknown[]) => void) {
  const result = toProducts(rows);
  if (!result.ok) return { status: 422, body: { error: 'invalid_metadata', row: result.row } };
  save(result.products);
  return { status: 201 };
}
`,
      'test/catalog-import.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toProducts } from '../src/catalog-import.js';

test('reports the malformed row', () => {
  assert.deepEqual(toProducts([{ sku: 'A', metadata: '{}' }, { sku: 'B', metadata: '{' }]), { ok: false, row: 2 });
});
`,
    },
    defect: {
      'src/catalog-import.ts': code`
export type CsvRow = { sku: string; metadata: string };
export type Product = { sku: string; metadata: Record<string, unknown> };
export type ImportResult = { ok: true; products: Product[] } | { ok: false; row: number };

/** Converts catalog CSV rows. A row with malformed metadata yields { ok: false, row }. */
export function toProducts(rows: CsvRow[]): ImportResult {
  const products = rows.map(row => ({
    sku: row.sku.trim(),
    metadata: row.metadata.trim() ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  }));
  return { ok: true, products };
}
`,
    },
    clean: {
      'src/catalog-import.ts': code`
export type CsvRow = { sku: string; metadata: string };
export type Product = { sku: string; metadata: Record<string, unknown> };
export type ImportResult = { ok: true; products: Product[] } | { ok: false; row: number };

/** Converts catalog CSV rows. A row with malformed metadata yields { ok: false, row }. */
export function toProducts(rows: CsvRow[]): ImportResult {
  let current = 0;
  try {
    const products = rows.map((row, index) => {
      current = index + 1;
      return { sku: row.sku.trim(), metadata: row.metadata.trim() ? (JSON.parse(row.metadata) as Record<string, unknown>) : {} };
    });
    return { ok: true, products };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, row: current };
    throw error;
  }
}
`,
    },
  }),
  pair({
    id: 'uj-chat-frames', family: 'unhandled-json', split: 'holdout',
    task: "Let clients send several frames in one message, separated by newlines. A frame that is not valid JSON must get { type: 'error', code: 'bad_frame' } and the connection must stay open; an exception thrown from the message listener crashes the server process.",
    base: {
      'src/chat-server.ts': code`
export interface Socket { on(event: 'message', listener: (data: string) => void): void; send(data: string): void }
export type Frame = { type: 'join'; room: string } | { type: 'say'; room: string; text: string };
export type Router = (socket: Socket, frame: Frame) => void;

const BAD_FRAME = JSON.stringify({ type: 'error', code: 'bad_frame' });

/** Attaches the chat protocol to a connection. */
export function attach(socket: Socket, route: Router): void {
  socket.on('message', data => {
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch (error) {
      if (error instanceof SyntaxError) return socket.send(BAD_FRAME);
      throw error;
    }
    route(socket, frame);
  });
}
`,
      'src/server.ts': code`
import { attach, type Router, type Socket } from './chat-server.js';

export function onConnection(socket: Socket, route: Router): void {
  attach(socket, route);
}
`,
      'test/chat-server.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attach } from '../src/chat-server.js';

test('answers a malformed frame with bad_frame', () => {
  const sent: string[] = [];
  let listener: (data: string) => void = () => {};
  attach({ on: (_event, handler) => { listener = handler; }, send: data => { sent.push(data); } }, () => {});
  listener('{');
  assert.deepEqual(sent, ['{"type":"error","code":"bad_frame"}']);
});
`,
    },
    defect: {
      'src/chat-server.ts': code`
export interface Socket { on(event: 'message', listener: (data: string) => void): void; send(data: string): void }
export type Frame = { type: 'join'; room: string } | { type: 'say'; room: string; text: string };
export type Router = (socket: Socket, frame: Frame) => void;

const BAD_FRAME = JSON.stringify({ type: 'error', code: 'bad_frame' });

/** Attaches the chat protocol to a connection. A message may carry several newline-separated frames. */
export function attach(socket: Socket, route: Router): void {
  socket.on('message', data => {
    const frames = data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Frame);
    for (const frame of frames) route(socket, frame);
  });
}
`,
    },
    clean: {
      'src/chat-server.ts': code`
export interface Socket { on(event: 'message', listener: (data: string) => void): void; send(data: string): void }
export type Frame = { type: 'join'; room: string } | { type: 'say'; room: string; text: string };
export type Router = (socket: Socket, frame: Frame) => void;

const BAD_FRAME = JSON.stringify({ type: 'error', code: 'bad_frame' });

/** Attaches the chat protocol to a connection. A message may carry several newline-separated frames. */
export function attach(socket: Socket, route: Router): void {
  socket.on('message', data => {
    let frames: Frame[];
    try {
      frames = data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Frame);
    } catch (error) {
      if (error instanceof SyntaxError) return socket.send(BAD_FRAME);
      throw error;
    }
    for (const frame of frames) route(socket, frame);
  });
}
`,
    },
  }),
  pair({
    id: 'uj-resize-jobs', family: 'unhandled-json', split: 'holdout',
    task: "Let resize jobs carry an optional height, and have the worker process every claimed job concurrently. A job whose payload is not valid JSON must still be marked failed with 'invalid_payload' while the other jobs complete, and runBatch must not reject because of it.",
    base: {
      'src/jobs/payload.ts': code`
export type ResizeJob = { imageId: string; width: number };

/** Decodes a queued job payload. Throws SyntaxError for malformed JSON; the worker marks such jobs failed. */
export function decodeJob(raw: string): ResizeJob {
  const job = JSON.parse(raw) as Partial<ResizeJob>;
  return { imageId: String(job.imageId), width: job.width ?? 800 };
}
`,
      'src/jobs/worker.ts': code`
import { decodeJob, type ResizeJob } from './payload.js';

export interface JobQueue { claim(limit: number): Promise<Array<{ id: string; payload: string }>>; complete(id: string): Promise<void>; fail(id: string, reason: string): Promise<void> }

/** Runs claimed jobs one at a time. A malformed payload marks that job failed with 'invalid_payload'. */
export async function runBatch(queue: JobQueue, resize: (job: ResizeJob) => Promise<void>): Promise<void> {
  for (const item of await queue.claim(4)) {
    let job: ResizeJob;
    try {
      job = decodeJob(item.payload);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await queue.fail(item.id, 'invalid_payload');
        continue;
      }
      throw error;
    }
    await resize(job);
    await queue.complete(item.id);
  }
}
`,
      'test/jobs/worker.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../../src/jobs/worker.js';

test('fails malformed jobs and completes the rest', async () => {
  const failed: string[] = [];
  const completed: string[] = [];
  const queue = {
    claim: async () => [{ id: 'a', payload: '{' }, { id: 'b', payload: '{"imageId":"i1"}' }],
    complete: async (id: string) => { completed.push(id); },
    fail: async (id: string) => { failed.push(id); },
  };
  await runBatch(queue, async () => {});
  assert.deepEqual([failed, completed], [['a'], ['b']]);
});
`,
    },
    defect: {
      'src/jobs/payload.ts': code`
export type ResizeJob = { imageId: string; width: number; height?: number };

/** Decodes a queued job payload. Throws SyntaxError for malformed JSON; the worker marks such jobs failed. */
export function decodeJob(raw: string): ResizeJob {
  const job = JSON.parse(raw) as Partial<ResizeJob>;
  return { imageId: String(job.imageId), width: job.width ?? 800, ...(job.height ? { height: job.height } : {}) };
}
`,
      'src/jobs/worker.ts': code`
import { decodeJob, type ResizeJob } from './payload.js';

export interface JobQueue { claim(limit: number): Promise<Array<{ id: string; payload: string }>>; complete(id: string): Promise<void>; fail(id: string, reason: string): Promise<void> }

/** Runs claimed jobs concurrently. A malformed payload marks that job failed with 'invalid_payload'. */
export async function runBatch(queue: JobQueue, resize: (job: ResizeJob) => Promise<void>): Promise<void> {
  const items = await queue.claim(4);
  await Promise.all(items.map(async item => {
    await resize(decodeJob(item.payload));
    await queue.complete(item.id);
  }));
}
`,
    },
    clean: {
      'src/jobs/payload.ts': code`
export type ResizeJob = { imageId: string; width: number; height?: number };

/** Decodes a queued job payload. Throws SyntaxError for malformed JSON; the worker marks such jobs failed. */
export function decodeJob(raw: string): ResizeJob {
  const job = JSON.parse(raw) as Partial<ResizeJob>;
  return { imageId: String(job.imageId), width: job.width ?? 800, ...(job.height ? { height: job.height } : {}) };
}
`,
      'src/jobs/worker.ts': code`
import { decodeJob, type ResizeJob } from './payload.js';

export interface JobQueue { claim(limit: number): Promise<Array<{ id: string; payload: string }>>; complete(id: string): Promise<void>; fail(id: string, reason: string): Promise<void> }

/** Runs claimed jobs concurrently. A malformed payload marks that job failed with 'invalid_payload'. */
export async function runBatch(queue: JobQueue, resize: (job: ResizeJob) => Promise<void>): Promise<void> {
  const items = await queue.claim(4);
  await Promise.all(items.map(async item => {
    let job: ResizeJob;
    try {
      job = decodeJob(item.payload);
    } catch (error) {
      if (error instanceof SyntaxError) return queue.fail(item.id, 'invalid_payload');
      throw error;
    }
    await resize(job);
    await queue.complete(item.id);
  }));
}
`,
    },
  }),
  pair({
    id: 'uj-remote-config', family: 'unhandled-json', split: 'holdout',
    task: 'Accept config served as text/plain, and fall back when refreshSeconds is not a positive number. An unreachable service, an error status, or a malformed JSON body must all resolve FALLBACK so startup never fails.',
    base: {
      'src/remote-config.js': code`
export const FALLBACK = { refreshSeconds: 300, features: {} };

/** Fetches remote config. Any failure resolves FALLBACK; startup must not fail. */
export function fetchRemoteConfig(fetchImpl, url) {
  return fetchImpl(url)
    .then(response => (response.ok ? response.json() : FALLBACK))
    .catch(() => FALLBACK);
}
`,
      'src/startup.js': code`
import { fetchRemoteConfig } from './remote-config.js';

export async function start(fetchImpl, url, schedule) {
  const config = await fetchRemoteConfig(fetchImpl, url);
  schedule(config.refreshSeconds);
  return config;
}
`,
      'test/remote-config.test.js': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK, fetchRemoteConfig } from '../src/remote-config.js';

test('falls back when the service is unreachable', async () => {
  assert.equal(await fetchRemoteConfig(async () => { throw new Error('ECONNREFUSED'); }, 'https://config.example'), FALLBACK);
});
`,
    },
    defect: {
      'src/remote-config.js': code`
export const FALLBACK = { refreshSeconds: 300, features: {} };

/** Fetches remote config. Any failure resolves FALLBACK; startup must not fail. */
export async function fetchRemoteConfig(fetchImpl, url) {
  const response = await fetchImpl(url).catch(() => null);
  if (!response || !response.ok) return FALLBACK;
  const config = JSON.parse(await response.text());
  return config.refreshSeconds > 0 ? config : FALLBACK;
}
`,
    },
    clean: {
      'src/remote-config.js': code`
export const FALLBACK = { refreshSeconds: 300, features: {} };

/** Fetches remote config. Any failure resolves FALLBACK; startup must not fail. */
export function fetchRemoteConfig(fetchImpl, url) {
  return fetchImpl(url)
    .then(response => (response.ok ? response.text() : Promise.reject(new Error('HTTP ' + response.status))))
    .then(text => JSON.parse(text))
    .then(config => (config.refreshSeconds > 0 ? config : FALLBACK))
    .catch(() => FALLBACK);
}
`,
    },
  }),

  // Quality only, development: no source-check candidates.
  pair({
    id: 'q-discount-tests', family: 'quality-only', split: 'development',
    task: 'Add a gold loyalty tier: 10% off, capped at $50 per order. Tests must pin both the percentage and the cap boundary so a regression in either fails.',
    quality: { relevant: ['correctness', 'testQuality'], irrelevant: ['performance', 'scalability', 'security', 'observability'], lowerOnDefect: ['testQuality'] },
    base: {
      'src/discounts.ts': code`
export type Tier = 'basic' | 'silver';

/** Loyalty discount in cents for an order subtotal in cents. */
export function loyaltyDiscount(subtotalCents: number, tier: Tier): number {
  if (tier === 'silver') return Math.round(subtotalCents * 0.05);
  return 0;
}
`,
      'src/checkout-total.ts': code`
import { loyaltyDiscount, type Tier } from './discounts.js';

export function orderTotal(subtotalCents: number, tier: Tier): number {
  return subtotalCents - loyaltyDiscount(subtotalCents, tier);
}
`,
      'test/discounts.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyDiscount } from '../src/discounts.js';

test('basic tier has no discount', () => {
  assert.equal(loyaltyDiscount(10_000, 'basic'), 0);
});

test('silver tier takes 5 percent', () => {
  assert.equal(loyaltyDiscount(10_000, 'silver'), 500);
});
`,
    },
    defect: {
      'src/discounts.ts': code`
export type Tier = 'basic' | 'silver' | 'gold';

/** Loyalty discount in cents for an order subtotal in cents. Gold is 10%, capped at $50. */
export function loyaltyDiscount(subtotalCents: number, tier: Tier): number {
  if (tier === 'gold') return Math.min(Math.round(subtotalCents * 0.1), 5_000);
  if (tier === 'silver') return Math.round(subtotalCents * 0.05);
  return 0;
}
`,
      'test/discounts.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyDiscount } from '../src/discounts.js';

test('basic tier has no discount', () => {
  assert.equal(loyaltyDiscount(10_000, 'basic'), 0);
});

test('silver tier takes 5 percent', () => {
  assert.equal(loyaltyDiscount(10_000, 'silver'), 500);
});

test('gold tier gets a discount', () => {
  assert.ok(loyaltyDiscount(20_000, 'gold') > 0);
});
`,
    },
    clean: {
      'src/discounts.ts': code`
export type Tier = 'basic' | 'silver' | 'gold';

/** Loyalty discount in cents for an order subtotal in cents. Gold is 10%, capped at $50. */
export function loyaltyDiscount(subtotalCents: number, tier: Tier): number {
  if (tier === 'gold') return Math.min(Math.round(subtotalCents * 0.1), 5_000);
  if (tier === 'silver') return Math.round(subtotalCents * 0.05);
  return 0;
}
`,
      'test/discounts.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyDiscount } from '../src/discounts.js';

test('basic tier has no discount', () => {
  assert.equal(loyaltyDiscount(10_000, 'basic'), 0);
});

test('silver tier takes 5 percent', () => {
  assert.equal(loyaltyDiscount(10_000, 'silver'), 500);
});

test('gold tier takes 10 percent below the cap', () => {
  assert.equal(loyaltyDiscount(20_000, 'gold'), 2_000);
});

test('gold discount is capped at $50', () => {
  assert.equal(loyaltyDiscount(50_000, 'gold'), 5_000);
  assert.equal(loyaltyDiscount(80_000, 'gold'), 5_000);
});
`,
    },
  }),
  pair({
    id: 'q-delivery-duplication', family: 'quality-only', split: 'development',
    task: 'Remote postcodes take 5 business days for standard delivery and 3 for express. Remote areas are exactly the ones that get the shipping surcharge; the logistics team maintains that list in one place.',
    quality: { relevant: ['correctness', 'duplication', 'changeability', 'maintainability'], irrelevant: ['performance', 'scalability', 'security'], lowerOnDefect: ['duplication', 'changeability'] },
    base: {
      'src/regions.ts': code`
const REMOTE_PREFIXES = ['HS', 'KW', 'ZE', 'IV4', 'PA2', 'PH4'];

export function normalizePostcode(postcode: string): string {
  return postcode.replace(/\s+/g, '').toUpperCase();
}

/** True for postcodes in remote delivery areas. The logistics team maintains REMOTE_PREFIXES. */
export function isRemotePostcode(postcode: string): boolean {
  const normalized = normalizePostcode(postcode);
  return REMOTE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}
`,
      'src/shipping.ts': code`
import { isRemotePostcode } from './regions.js';

export function shippingCents(postcode: string): number {
  return isRemotePostcode(postcode) ? 1_299 : 499;
}
`,
      'src/delivery.ts': code`
import { normalizePostcode } from './regions.js';

/** Business days until delivery. */
export function estimateDeliveryDays(postcode: string, express: boolean): number {
  if (!normalizePostcode(postcode)) throw new RangeError('A postcode is required.');
  return express ? 1 : 2;
}
`,
      'src/checkout-summary.ts': code`
import { estimateDeliveryDays } from './delivery.js';
import { shippingCents } from './shipping.js';

export function summary(postcode: string, express: boolean) {
  return { shippingCents: shippingCents(postcode), days: estimateDeliveryDays(postcode, express) };
}
`,
      'test/delivery.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateDeliveryDays } from '../src/delivery.js';

test('standard delivery takes two days', () => {
  assert.equal(estimateDeliveryDays('SW1A 1AA', false), 2);
});
`,
    },
    defect: {
      'src/delivery.ts': code`
import { normalizePostcode } from './regions.js';

const REMOTE_AREAS = ['HS', 'KW', 'ZE', 'IV4', 'PA2', 'PH4'];

/** Business days until delivery. Remote areas take longer. */
export function estimateDeliveryDays(postcode: string, express: boolean): number {
  const normalized = normalizePostcode(postcode);
  if (!normalized) throw new RangeError('A postcode is required.');
  if (REMOTE_AREAS.some(prefix => normalized.startsWith(prefix))) return express ? 3 : 5;
  return express ? 1 : 2;
}
`,
    },
    clean: {
      'src/delivery.ts': code`
import { isRemotePostcode, normalizePostcode } from './regions.js';

/** Business days until delivery. Remote areas take longer. */
export function estimateDeliveryDays(postcode: string, express: boolean): number {
  if (!normalizePostcode(postcode)) throw new RangeError('A postcode is required.');
  if (isRemotePostcode(postcode)) return express ? 3 : 5;
  return express ? 1 : 2;
}
`,
    },
  }),
  pair({
    id: 'q-client-compat', family: 'quality-only', split: 'development',
    task: "Let callers optionally expand a user's teams (GET /users/:id?expand=teams). The admin console and the billing service call getUser today and must keep working without changes.",
    quality: { relevant: ['correctness', 'compatibility'], irrelevant: ['performance', 'scalability', 'observability'], lowerOnDefect: ['correctness', 'compatibility'] },
    base: {
      'src/api-client.ts': code`
export interface Http { get<T>(path: string): Promise<T> }
export type User = { id: string; name: string; email: string; teams?: string[] };

/** Fetches a user by ID. */
export async function getUser(http: Http, id: string): Promise<User> {
  return http.get<User>('/users/' + encodeURIComponent(id));
}
`,
      'src/admin/user-page.ts': code`
import { getUser, type Http } from '../api-client.js';

export async function loadUserPage(http: Http, params: { id: string }) {
  const user = await getUser(http, params.id);
  return { title: user.name, email: user.email };
}
`,
      'src/billing/invoice-recipient.ts': code`
import { getUser, type Http } from '../api-client.js';

export async function invoiceRecipient(http: Http, invoice: { userId: string }): Promise<string> {
  return (await getUser(http, invoice.userId)).email;
}
`,
      'test/api-client.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUser } from '../src/api-client.js';

test('requests the user by ID', async () => {
  const paths: string[] = [];
  await getUser({ get: async <T>(path: string) => { paths.push(path); return {} as T; } }, 'u 1');
  assert.deepEqual(paths, ['/users/u%201']);
});
`,
    },
    defect: {
      'src/api-client.ts': code`
export interface Http { get<T>(path: string): Promise<T> }
export type User = { id: string; name: string; email: string; teams?: string[] };
export type GetUserOptions = { id: string; expand?: Array<'teams'> };

/** Fetches a user by ID, optionally expanding related records. */
export async function getUser(http: Http, options: GetUserOptions): Promise<User> {
  const query = options.expand?.length ? '?expand=' + options.expand.join(',') : '';
  return http.get<User>('/users/' + encodeURIComponent(options.id) + query);
}
`,
    },
    clean: {
      'src/api-client.ts': code`
export interface Http { get<T>(path: string): Promise<T> }
export type User = { id: string; name: string; email: string; teams?: string[] };
export type GetUserOptions = { expand?: Array<'teams'> };

/** Fetches a user by ID, optionally expanding related records. */
export async function getUser(http: Http, id: string, options: GetUserOptions = {}): Promise<User> {
  const query = options.expand?.length ? '?expand=' + options.expand.join(',') : '';
  return http.get<User>('/users/' + encodeURIComponent(id) + query);
}
`,
    },
  }),

  // Quality only, holdout.
  pair({
    id: 'q-export-path', family: 'quality-only', split: 'holdout',
    task: 'Allow exports in per-team folders, for example team-42/report.csv. The name comes from the request URL, and a request must never read a file outside EXPORT_ROOT.',
    quality: { relevant: ['correctness', 'security'], irrelevant: ['performance', 'scalability'], lowerOnDefect: ['correctness', 'security'] },
    base: {
      'src/downloads.ts': code`
import { join } from 'node:path';

export const EXPORT_ROOT = '/srv/app/exports';

/** Resolves the file for GET /exports/:name, or null when the name is not an export. */
export function exportPath(name: string): string | null {
  if (!/^[\w-]+\.csv$/.test(name)) return null;
  return join(EXPORT_ROOT, name);
}
`,
      'src/routes/exports.ts': code`
import { exportPath } from '../downloads.js';

export function downloadExport(params: { name: string }, sendFile: (path: string) => void) {
  const path = exportPath(params.name);
  if (!path) return { status: 404 };
  sendFile(path);
  return { status: 200 };
}
`,
      'test/downloads.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportPath } from '../src/downloads.js';

test('resolves an export by name', () => {
  assert.equal(exportPath('report.csv'), '/srv/app/exports/report.csv');
});
`,
    },
    defect: {
      'src/downloads.ts': code`
import { join } from 'node:path';

export const EXPORT_ROOT = '/srv/app/exports';

/** Resolves the file for GET /exports/*name, or null when the name is not an export. */
export function exportPath(name: string): string | null {
  if (!name.endsWith('.csv')) return null;
  return join(EXPORT_ROOT, name);
}
`,
    },
    clean: {
      'src/downloads.ts': code`
import { resolve, sep } from 'node:path';

export const EXPORT_ROOT = '/srv/app/exports';

/** Resolves the file for GET /exports/*name, or null when the name is not an export inside EXPORT_ROOT. */
export function exportPath(name: string): string | null {
  if (!name.endsWith('.csv')) return null;
  const target = resolve(EXPORT_ROOT, name);
  return target.startsWith(EXPORT_ROOT + sep) ? target : null;
}
`,
    },
  }),
  pair({
    id: 'q-customer-totals', family: 'quality-only', split: 'holdout',
    task: 'List only customers who have placed at least one order, highest lifetime spend first. The dashboard request processes up to 50,000 customers and 2,000,000 orders and must respond within 2 seconds.',
    quality: { relevant: ['correctness', 'performance', 'scalability'], irrelevant: ['security', 'observability'], lowerOnDefect: ['performance', 'scalability'] },
    base: {
      'src/reports/customer-totals.ts': code`
export type Order = { customerId: string; totalCents: number };
export type Customer = { id: string; name: string };

/** Lifetime spend per customer for the account-manager dashboard. */
export function customerTotals(customers: Customer[], orders: Order[]) {
  const totals = new Map<string, number>();
  for (const order of orders) totals.set(order.customerId, (totals.get(order.customerId) ?? 0) + order.totalCents);
  return customers.map(customer => ({ ...customer, totalCents: totals.get(customer.id) ?? 0 }));
}
`,
      'src/routes/dashboard.ts': code`
import { customerTotals, type Customer, type Order } from '../reports/customer-totals.js';

export async function dashboard(db: { customers(): Promise<Customer[]>; orders(): Promise<Order[]> }) {
  return { rows: customerTotals(await db.customers(), await db.orders()) };
}
`,
      'test/reports/customer-totals.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerTotals } from '../../src/reports/customer-totals.js';

test('sums orders per customer', () => {
  const rows = customerTotals([{ id: 'c1', name: 'A' }], [{ customerId: 'c1', totalCents: 5 }, { customerId: 'c1', totalCents: 7 }]);
  assert.equal(rows[0]?.totalCents, 12);
});
`,
    },
    defect: {
      'src/reports/customer-totals.ts': code`
export type Order = { customerId: string; totalCents: number };
export type Customer = { id: string; name: string };

/** Lifetime spend per customer with at least one order, highest first, for the account-manager dashboard. */
export function customerTotals(customers: Customer[], orders: Order[]) {
  return customers
    .map(customer => {
      const placed = orders.filter(order => order.customerId === customer.id);
      return { ...customer, orderCount: placed.length, totalCents: placed.reduce((sum, order) => sum + order.totalCents, 0) };
    })
    .filter(row => row.orderCount > 0)
    .sort((a, b) => b.totalCents - a.totalCents);
}
`,
    },
    clean: {
      'src/reports/customer-totals.ts': code`
export type Order = { customerId: string; totalCents: number };
export type Customer = { id: string; name: string };

/** Lifetime spend per customer with at least one order, highest first, for the account-manager dashboard. */
export function customerTotals(customers: Customer[], orders: Order[]) {
  const totals = new Map<string, { orderCount: number; totalCents: number }>();
  for (const order of orders) {
    const entry = totals.get(order.customerId) ?? { orderCount: 0, totalCents: 0 };
    entry.orderCount++;
    entry.totalCents += order.totalCents;
    totals.set(order.customerId, entry);
  }
  return customers
    .flatMap(customer => {
      const entry = totals.get(customer.id);
      return entry ? [{ ...customer, ...entry }] : [];
    })
    .sort((a, b) => b.totalCents - a.totalCents);
}
`,
    },
  }),
  pair({
    id: 'q-tax-rates', family: 'quality-only', split: 'holdout',
    task: 'Look up tax rates by region code; unknown regions are untaxed. Rates must be passed in by the caller, because checkout loads them per tenant and tests supply their own tables.',
    quality: { relevant: ['correctness', 'coupling'], irrelevant: ['performance', 'scalability', 'security', 'observability'], lowerOnDefect: ['correctness', 'coupling'] },
    base: {
      'src/tax.ts': code`
export type TaxRates = Record<string, number>;

/** Price in cents including tax at the given rate. */
export function priceWithTax(amountCents: number, rate: number): number {
  return Math.round(amountCents * (1 + rate));
}
`,
      'src/config.ts': code`
/** Process-wide defaults for the single-tenant deployment. */
export const config = { taxRates: { GB: 0.2, DE: 0.19 } as Record<string, number> };
`,
      'src/checkout.ts': code`
import { priceWithTax } from './tax.js';

export function lineTotal(tenant: { taxRate: number }, line: { amountCents: number }): number {
  return priceWithTax(line.amountCents, tenant.taxRate);
}
`,
      'test/tax.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceWithTax } from '../src/tax.js';

test('adds tax', () => {
  assert.equal(priceWithTax(1_000, 0.2), 1_200);
});
`,
    },
    defect: {
      'src/tax.ts': code`
import { config } from './config.js';

export type TaxRates = Record<string, number>;

/** Price in cents including the region's tax. Unknown regions are untaxed. */
export function priceWithTax(amountCents: number, region: string): number {
  const rate = config.taxRates[region] ?? 0;
  return Math.round(amountCents * (1 + rate));
}
`,
      'src/checkout.ts': code`
import { priceWithTax } from './tax.js';

export function lineTotal(tenant: { region: string }, line: { amountCents: number }): number {
  return priceWithTax(line.amountCents, tenant.region);
}
`,
      'test/tax.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceWithTax } from '../src/tax.js';

test('adds the region tax', () => {
  assert.equal(priceWithTax(1_000, 'GB'), 1_200);
});
`,
    },
    clean: {
      'src/tax.ts': code`
export type TaxRates = Record<string, number>;

/** Price in cents including the region's tax from the caller's rate table. Unknown regions are untaxed. */
export function priceWithTax(amountCents: number, region: string, rates: TaxRates): number {
  const rate = rates[region] ?? 0;
  return Math.round(amountCents * (1 + rate));
}
`,
      'src/checkout.ts': code`
import { priceWithTax, type TaxRates } from './tax.js';

export function lineTotal(tenant: { region: string; taxRates: TaxRates }, line: { amountCents: number }): number {
  return priceWithTax(line.amountCents, tenant.region, tenant.taxRates);
}
`,
      'test/tax.test.ts': code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceWithTax } from '../src/tax.js';

test('adds the region tax from the supplied table', () => {
  assert.equal(priceWithTax(1_000, 'GB', { GB: 0.2 }), 1_200);
});

test('leaves unknown regions untaxed', () => {
  assert.equal(priceWithTax(1_000, 'US', { GB: 0.2 }), 1_000);
});
`,
    },
  }),
];
