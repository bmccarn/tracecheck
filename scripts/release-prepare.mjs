import { readFile, writeFile } from 'node:fs/promises';

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/;

const targets = [
  { path: 'package.json', setVersion: (value, version) => { value.version = version; } },
  { path: 'package-lock.json', setVersion: (value, version) => { value.version = version; value.packages[''].version = version; } },
  { path: 'plugin.json', setVersion: (value, version) => { value.version = version; } },
  { path: '.codex-plugin/plugin.json', setVersion: (value, version) => { value.version = version; } },
  { path: '.claude-plugin/plugin.json', setVersion: (value, version) => { value.version = version; } },
];

// Catalogs that let users add this repository itself as a marketplace. They pin a stable release tag.
const catalogPaths = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`Cannot read valid JSON from ${path}.`);
  }
}

function catalogSource(path, value) {
  const entries = Array.isArray(value?.plugins) ? value.plugins.filter(entry => entry?.name === 'tracecheck') : [];
  const source = entries[0]?.source;
  if (entries.length !== 1 || typeof source !== 'object' || source === null) fail(`${path} must list the tracecheck plugin once with a source object.`);
  return source;
}


function validateMetadata(values) {
  const packageJson = values[0]?.value;
  const packageLock = values[1]?.value;
  if (packageJson?.name !== '@bmccarn/tracecheck') fail('package.json has an unexpected package name.');
  if (packageLock?.name !== packageJson.name || packageLock?.packages?.['']?.name !== packageJson.name) fail('package-lock.json does not describe package.json.');
  for (const { path, value } of values.slice(2)) {
    if (value.name !== 'tracecheck') fail(`${path} has an unexpected plugin name.`);
  }

  const versions = values.map(({ path, value }) => ({ path, version: value.version }));
  if (versions.some(({ version }) => typeof version !== 'string' || !versionPattern.test(version))) fail('Release metadata contains an invalid SemVer version.');
  if (packageLock?.packages?.['']?.version !== packageLock.version) fail('package-lock.json root and package entry versions differ.');
  if (new Set(versions.map(({ version }) => version)).size !== 1) fail('Release metadata versions differ; repair the existing drift before preparing a release.');
}

async function main() {
  const [version] = process.argv.slice(2);
  if (process.argv.length !== 3 || !versionPattern.test(version ?? '')) fail('Pass exactly one strict SemVer version.');

  const values = [];
  for (const target of targets) {
    values.push({ target, path: target.path, value: await readJson(target.path) });
  }
  validateMetadata(values);

  const catalogs = [];
  for (const path of catalogPaths) {
    const value = await readJson(path);
    catalogs.push({ path, value, source: catalogSource(path, value) });
  }

  // Prereleases never reach the marketplaces, so the catalogs keep the current stable tag.
  const stable = !version.includes('-');
  for (const { value, target } of values) target.setVersion(value, version);
  if (stable) for (const { source } of catalogs) source.ref = `v${version}`;

  // Everything is validated above, so a write failure here can only come from the filesystem.
  for (const { path, value } of [...values, ...(stable ? catalogs : [])]) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  console.log(`Prepared release metadata for ${version}.`);
  console.log(stable
    ? `Marketplace catalogs now pin v${version}.`
    : `Marketplace catalogs keep ${catalogs.map(({ source }) => source.ref).join(', ')} for this prerelease.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
