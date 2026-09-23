import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const prepare = resolve('scripts/release-prepare.mjs');
const gates = resolve('scripts/release-gates.mjs');
const metadataPaths = ['package.json', 'package-lock.json', 'plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'];
const catalogPaths = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'] as const;

async function writeJson(directory: string, path: string, value: unknown) {
  await mkdir(join(directory, path, '..'), { recursive: true });
  await writeFile(join(directory, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function seed(directory: string, version = '0.2.0', catalogRef = `v${version}`) {
  await writeJson(directory, 'package.json', { name: '@bmccarn/tracecheck', version });
  await writeJson(directory, 'package-lock.json', { name: '@bmccarn/tracecheck', version, packages: { '': { name: '@bmccarn/tracecheck', version } } });
  for (const path of metadataPaths.slice(2)) await writeJson(directory, path, { name: 'tracecheck', version });
  for (const path of catalogPaths) await writeCatalog(directory, path, catalogRef);
}

async function writeCatalog(directory: string, path: string, ref: string) {
  await writeJson(directory, path, { name: 'tracecheck-plugins', plugins: [{ name: 'tracecheck', source: { source: 'url', url: 'https://github.com/bmccarn/tracecheck.git', ref }, category: 'Developer Tools' }] });
}

async function run(directory: string, script: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, [script, ...args], { cwd: directory });
    return { code: 0, stdout: result.stdout };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? '' };
  }
}

async function initializeRepository(directory: string, ...tags: string[]) {
  await exec('git', ['init', '--quiet'], { cwd: directory });
  await exec('git', ['-c', 'user.name=Tracecheck test', '-c', 'user.email=tracecheck@example.com', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: directory });
  for (const tag of tags) await exec('git', ['tag', tag], { cwd: directory });
}

async function contents(directory: string) {
  return Promise.all([...metadataPaths, ...catalogPaths].map(path => readFile(join(directory, path), 'utf8')));
}

test('release preparation rejects malformed versions without changing metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory);
  const before = await contents(directory);

  const result = await run(directory, prepare, '1.02.3');

  assert.notEqual(result.code, 0);
  assert.deepEqual(await contents(directory), before);
});

test('release preparation rejects build metadata without changing metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory);
  const before = await contents(directory);

  const result = await run(directory, prepare, '1.2.3+hot-fix');

  assert.notEqual(result.code, 0);
  assert.deepEqual(await contents(directory), before);
});

test('release preparation refuses existing version drift before changing metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory);
  await writeJson(directory, 'plugin.json', { name: 'tracecheck', version: '0.1.0' });
  const before = await contents(directory);

  const result = await run(directory, prepare, '0.3.0-rc.1');

  assert.notEqual(result.code, 0);
  assert.deepEqual(await contents(directory), before);
});

test('release preparation synchronizes all release metadata including lock package entry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory);
  const catalogsBefore = (await contents(directory)).slice(metadataPaths.length);

  assert.equal((await run(directory, prepare, '0.3.0-rc.1')).code, 0);
  const metadata = await Promise.all(metadataPaths.map(async path => JSON.parse(await readFile(join(directory, path), 'utf8'))));
  assert.equal(metadata[0].version, '0.3.0-rc.1');
  assert.equal(metadata[1].version, '0.3.0-rc.1');
  assert.equal(metadata[1].packages[''].version, '0.3.0-rc.1');
  assert.deepEqual(metadata.slice(2).map(value => value.version), ['0.3.0-rc.1', '0.3.0-rc.1', '0.3.0-rc.1']);
  assert.deepEqual((await contents(directory)).slice(metadataPaths.length), catalogsBefore, 'a prerelease leaves the marketplace catalogs on the stable tag');
});

test('stable release preparation points every marketplace catalog at the new release tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory);

  assert.equal((await run(directory, prepare, '0.3.0')).code, 0);
  const catalogs = await Promise.all(catalogPaths.map(async path => JSON.parse(await readFile(join(directory, path), 'utf8'))));
  for (const catalog of catalogs) {
    assert.deepEqual(catalog, { name: 'tracecheck-plugins', plugins: [{ name: 'tracecheck', source: { source: 'url', url: 'https://github.com/bmccarn/tracecheck.git', ref: 'v0.3.0' }, category: 'Developer Tools' }] });
  }
  assert.deepEqual((await run(directory, gates)).stdout.trim().split('\n'), ['version=0.3.0', 'channel=latest']);
});

test('release gates reject a marketplace catalog that does not pin the stable release tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '1.2.3');
  await initializeRepository(directory, 'v1.2.3');
  await writeCatalog(directory, catalogPaths[1], 'v1.2.2');

  assert.notEqual((await run(directory, gates, 'v1.2.3')).code, 0);
  assert.notEqual((await run(directory, gates)).code, 0);
});

test('release gates reject a marketplace catalog that some clients would clone over SSH', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '1.2.3');
  await writeJson(directory, catalogPaths[1], { name: 'tracecheck-plugins', plugins: [{ name: 'tracecheck', source: { source: 'github', repo: 'bmccarn/tracecheck', ref: 'v1.2.3' } }] });

  assert.notEqual((await run(directory, gates)).code, 0);
  await writeCatalog(directory, catalogPaths[1], 'v1.2.3');
  assert.equal((await run(directory, gates)).code, 0);
});

test('release gates require prerelease catalogs to pin an earlier stable release tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await seed(directory, '0.4.0-rc.1', 'v0.4.0');
  assert.notEqual((await run(directory, gates, 'v0.4.0-rc.1')).code, 0, 'the stable tag does not exist yet');
  await seed(directory, '0.4.0-rc.1', 'v0.4.0-rc.1');
  assert.notEqual((await run(directory, gates, 'v0.4.0-rc.1')).code, 0, 'prereleases never reach the marketplaces');
  await seed(directory, '0.4.0-rc.1', 'v0.3.0');
  assert.deepEqual((await run(directory, gates, 'v0.4.0-rc.1')).stdout.trim().split('\n'), ['version=0.4.0-rc.1', 'channel=next']);
});

test('release gates require an exact tag and select prerelease or stable channels', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '1.2.3');
  await initializeRepository(directory, 'v1.2.3');

  assert.deepEqual((await run(directory, gates, 'v1.2.3')).stdout.trim().split('\n'), ['version=1.2.3', 'channel=latest']);
  assert.notEqual((await run(directory, gates, 'v1.2.4')).code, 0);
  assert.equal((await run(directory, prepare, '1.2.4-rc.1')).code, 0);
  assert.deepEqual((await run(directory, gates, 'v1.2.4-rc.1')).stdout.trim().split('\n'), ['version=1.2.4-rc.1', 'channel=next']);
});

test('release gates retain local metadata checks without Git when no publication tag is provided', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '1.2.3');

  assert.deepEqual((await run(directory, gates)).stdout.trim().split('\n'), ['version=1.2.3', 'channel=latest']);
});

test('release gates reject stable tags older than an existing stable tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '0.2.1');
  await initializeRepository(directory, 'v0.3.0');

  assert.notEqual((await run(directory, gates, 'v0.2.1')).code, 0);
});

test('release gates allow stable tags newer than existing stable tags', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '0.3.1');
  await initializeRepository(directory, 'v0.3.0');

  assert.deepEqual((await run(directory, gates, 'v0.3.1')).stdout.trim().split('\n'), ['version=0.3.1', 'channel=latest']);
});

test('release gates ignore prerelease tags when ordering stable publications', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed(directory, '0.2.1');
  await initializeRepository(directory, 'v0.3.0-rc.1');

  assert.deepEqual((await run(directory, gates, 'v0.2.1')).stdout.trim().split('\n'), ['version=0.2.1', 'channel=latest']);
});
