import { readFile, access } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const missing = [];
if (!pkg.repository?.url) missing.push('Set repository.url to the chosen public Git repository.');
if (!pkg.homepage || !pkg.bugs?.url) missing.push('Set homepage and bugs.url for the published project.');
if (!pkg.license) missing.push('Choose the distribution license and set package.json license.');
try { await access('LICENSE'); } catch { missing.push('Add the corresponding LICENSE file.'); }
if (pkg.private) missing.push('Remove private: true before publishing.');
if (missing.length) {
  console.error('Publication metadata still needed:\n' + missing.map(item => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else console.log('Publication metadata is present. Confirm registry ownership and review the release artifact before publishing.');
