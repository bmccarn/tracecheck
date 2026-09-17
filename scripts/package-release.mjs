import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, options = {}) => exec(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const release = resolve('release');
await mkdir(release, { recursive: true });
// Lifecycle scripts already ran in package:check. Pack exactly the distribution allowlist.
const { stdout } = await run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', release]);
const [pack] = JSON.parse(stdout);
const files = new Set(pack.files.map(file => file.path));
for (const path of ['dist/plugin.mjs', 'plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'skills/tracecheck/SKILL.md', 'skills/tracecheck/references/tool-usage.md', 'README.md']) {
  assert.ok(files.has(path), `Missing distribution file: ${path}`);
}
for (const path of files) {
  assert.ok(!/(^|\/)(?:\.env(?:\..*)?|\.tracecheck|node_modules|release|test|examples|src)(?:\/|$)/.test(path), `Unexpected distribution file: ${path}`);
}
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'Runtime must be bundled; avoid duplicate dependency installation.');
for (const path of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(manifest.version, pkg.version, `Version mismatch: ${path}`);
  assert.equal(manifest.name, 'tracecheck');
}
const archive = join(release, pack.filename);
const temporary = await mkdtemp(join(tmpdir(), 'tracecheck-release-'));
const client = new Client({ name: 'release-check', version: '1.0.0' });
try {
  // Empty npm cache and directory prove npx uses the tarball, not a checkout/global installation.
  const env = { ...process.env, npm_config_cache: join(temporary, 'cache') };
  const args = ['exec', '--offline', '--yes', `--package=${archive}`, '--', 'tracecheck'];
  const help = await run(npm, [...args, '--help'], { cwd: temporary, env });
  assert.match(help.stdout, /Tracecheck/);
  assert.match(help.stdout, /tracecheck assess/);
  await client.connect(new StdioClientTransport({ command: npm, args: [...args, 'mcp'], cwd: temporary, env, stderr: 'pipe' }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['tracecheck_assess', 'tracecheck_preview', 'tracecheck_review', 'tracecheck_verify']);
  const invalid = await client.callTool({ name: 'tracecheck_assess', arguments: {} });
  assert.equal(invalid.isError, true);
  await client.close();

  // Generate a self-contained catalog for both hosts from the exact npm payload.
  const marketplace = join(temporary, 'tracecheck-marketplace');
  const plugin = join(marketplace, 'plugins', 'tracecheck');
  await mkdir(plugin, { recursive: true });
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', plugin]);
  const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
  await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
  await writeJson(join(marketplace, '.agents', 'plugins', 'marketplace.json'), {
    name: 'tracecheck-plugins', interface: { displayName: 'Tracecheck' },
    plugins: [{ name: 'tracecheck', source: { source: 'local', path: './plugins/tracecheck' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
  });
  await writeJson(join(marketplace, '.claude-plugin', 'marketplace.json'), {
    name: 'tracecheck-plugins', owner: { name: 'bmccarn' }, description: pkg.description,
    plugins: [{ name: 'tracecheck', source: './plugins/tracecheck', description: pkg.description }],
  });
  const marketplaceArchive = join(release, `tracecheck-marketplace-${pkg.version}.tgz`);
  await run('tar', ['-czf', marketplaceArchive, '-C', temporary, 'tracecheck-marketplace']);
  console.log(`Package verified: ${archive}\nMarketplace bundle: ${marketplaceArchive}\n${files.size} files; ${(pack.size / 1024).toFixed(1)} KiB compressed.\nOffline npm exec: CLI and all four MCP tools passed. No Jev request made.`);
} finally {
  await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
