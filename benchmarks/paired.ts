import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { summarizePaired } from '../src/paired-benchmark.js';
const { values } = parseArgs({ options: { input: { type: 'string' } } });
if (!values.input) throw new Error('Pass --input paired-run.json; see docs/agent-evaluation.md.');
console.log(JSON.stringify(summarizePaired(JSON.parse(await readFile(values.input, 'utf8'))), null, 2));
