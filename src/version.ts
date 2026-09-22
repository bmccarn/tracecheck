import { createRequire } from 'node:module';

declare const __TRACECHECK_VERSION__: string | undefined;

/** The package version; the bundle build inlines it, and source runs read package.json. */
export const releaseVersion: string = typeof __TRACECHECK_VERSION__ === 'string'
  ? __TRACECHECK_VERSION__
  : createRequire(import.meta.url)('../package.json').version;
