import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/;
const catalogPaths = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'];

function compareStableVersions(left, right) {
  const leftParts = left.split('.').map(part => BigInt(part));
  const rightParts = right.split('.').map(part => BigInt(part));
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

async function ensureStableVersionIsCurrent(version) {
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execFile('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
    });
  } catch {
    fail('Cannot list existing release tags.');
  }

  const newerVersion = stdout
    .trim()
    .split('\n')
    .map(tag => tag.slice(1))
    .filter(tagVersion => versionPattern.test(tagVersion) && !tagVersion.includes('-'))
    .find(tagVersion => compareStableVersions(version, tagVersion) < 0);
  if (newerVersion) fail(`Stable release ${version} is older than existing stable release ${newerVersion}.`);
}

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

function catalogRef(path, value) {
  const entries = Array.isArray(value?.plugins) ? value.plugins.filter(entry => entry?.name === 'tracecheck') : [];
  if (entries.length !== 1) fail(`${path} must list the tracecheck plugin once.`);
  return entries[0].source?.ref;
}

// Users who add this repository as a marketplace get the catalog ref, so it must name a published stable tag:
// the release tag for a stable release, and an earlier stable tag for a prerelease.
function ensureCatalogsMatch(version, catalogs) {
  const core = version.split('-')[0];
  for (const [index, catalog] of catalogs.entries()) {
    const path = catalogPaths[index];
    const ref = catalogRef(path, catalog);
    if (core === version) {
      if (ref !== `v${version}`) fail(`${path} pins ${JSON.stringify(ref)}, but release ${version} requires v${version}. Run the release preparation script.`);
      continue;
    }
    const refVersion = typeof ref === 'string' && ref.startsWith('v') ? ref.slice(1) : '';
    if (!versionPattern.test(refVersion) || refVersion.includes('-') || compareStableVersions(refVersion, core) >= 0) {
      fail(`${path} pins ${JSON.stringify(ref)}, but prerelease ${version} requires an earlier stable release tag.`);
    }
  }
}

async function main() {
  const [tag] = process.argv.slice(2);
  if (process.argv.length > 3) fail('Pass at most one release tag.');

  const [packageJson, packageLock, plugin, codexPlugin, claudePlugin, ...catalogs] = await Promise.all([
    readJson('package.json'),
    readJson('package-lock.json'),
    readJson('plugin.json'),
    readJson('.codex-plugin/plugin.json'),
    readJson('.claude-plugin/plugin.json'),
    ...catalogPaths.map(readJson),
  ]);
  if (packageJson.name !== '@bmccarn/tracecheck') fail('package.json has an unexpected package name.');
  if (packageLock.name !== packageJson.name || packageLock.packages?.['']?.name !== packageJson.name) fail('package-lock.json does not describe package.json.');
  if ([plugin, codexPlugin, claudePlugin].some(manifest => manifest.name !== 'tracecheck')) fail('A plugin manifest has an unexpected name.');

  const versions = [
    packageJson.version,
    packageLock.version,
    packageLock.packages?.['']?.version,
    plugin.version,
    codexPlugin.version,
    claudePlugin.version,
  ];
  if (versions.some(version => typeof version !== 'string' || !versionPattern.test(version))) fail('Release metadata contains an invalid SemVer version.');
  if (new Set(versions).size !== 1) fail('Release metadata versions differ.');

  const version = packageJson.version;
  if (tag !== undefined && tag !== `v${version}`) fail(`Tag ${tag} does not match package version ${version}.`);
  ensureCatalogsMatch(version, catalogs);
  const channel = version.includes('-') ? 'next' : 'latest';
  if (tag !== undefined && channel === 'latest') await ensureStableVersionIsCurrent(version);
  console.log(`version=${version}`);
  console.log(`channel=${channel}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
