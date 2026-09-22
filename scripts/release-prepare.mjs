import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/;

const targets = [
  { path: 'package.json', getVersion: value => value.version, setVersion: (value, version) => { value.version = version; } },
  { path: 'package-lock.json', getVersion: value => value.version, setVersion: (value, version) => { value.version = version; value.packages[''].version = version; } },
  { path: 'plugin.json', getVersion: value => value.version, setVersion: (value, version) => { value.version = version; } },
  { path: '.codex-plugin/plugin.json', getVersion: value => value.version, setVersion: (value, version) => { value.version = version; } },
  { path: '.claude-plugin/plugin.json', getVersion: value => value.version, setVersion: (value, version) => { value.version = version; } },
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

  const versions = values.map(({ path, value, target }) => ({ path, version: target.getVersion(value) }));
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

  const suffix = `.release-prepare-${process.pid}-${randomUUID()}`;
  const staged = [...values, ...(stable ? catalogs : [])].map(({ path, value }) => ({
    path,
    backup: `${path}${suffix}.backup`,
    temporary: `${path}${suffix}.next`,
    content: `${JSON.stringify(value, null, 2)}\n`,
  }));
  const replaced = [];
  let preserveBackups = false;
  try {
    for (const file of staged) {
      await writeFile(file.backup, await readFile(file.path));
      await writeFile(file.temporary, file.content);
    }
    for (const file of staged) {
      await rename(file.temporary, file.path);
      replaced.push(file);
    }
  } catch (error) {
    let rollbackFailure;
    for (const file of [...replaced].reverse()) {
      try {
        await rename(file.backup, file.path);
      } catch (cause) {
        rollbackFailure ??= cause;
      }
    }
    if (rollbackFailure) {
      preserveBackups = true;
      throw new AggregateError([error, rollbackFailure], `Release metadata update failed and rollback is incomplete. Inspect retained *${suffix}.backup files before retrying.`);
    }
    throw error;
  } finally {
    await Promise.all(staged.map(file => rm(file.temporary, { force: true })));
    if (!preserveBackups) await Promise.all(staged.map(file => rm(file.backup, { force: true })));
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
