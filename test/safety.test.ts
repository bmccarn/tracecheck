import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeOutbound, hasSecret } from '../src/safety.js';

// Credential-shaped fixtures are assembled at runtime so the repository never contains a literal secret.
const join = (...parts: string[]) => parts.join('');
const random = join('q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd');
const padded = Buffer.from('fixture-credential-1').toString('base64');
const dashes = '-'.repeat(5);

test('detects credential shapes that assignments, tokens, key blocks, and URLs carry', () => {
  assert.ok(padded.endsWith('='));
  const shapes: Record<string, string> = {
    'unquoted YAML': `database:\n  password: ${random}\n`,
    'unquoted TOML or INI': `[service]\napi_key = ${random}\n`,
    'unquoted .env': `export GITHUB_TOKEN=${random}\n`,
    '.env with trailing comment': `DB_PASSWORD=${random} # local only\n`,
    'base64 with padding': `secret: "${padded}"\n`,
    'PGP private key block': `${dashes}BEGIN PGP PRIVATE KEY BLOCK${dashes}\n`,
    'DSA private key': `${dashes}BEGIN DSA PRIVATE KEY${dashes}\n`,
    'encrypted private key': `${dashes}BEGIN ENCRYPTED PRIVATE KEY${dashes}\n`,
    'Slack token': `const slack = connect(${join('"xo', 'xb-', '1234567890-', '0987654321-', random, '"')});`,
    'Slack webhook': `url = ${join('"https://hooks.', 'slack.com/services/', 'T0123ABCD/', 'B0456EFGH/', random, '"')}`,
    'Google API key': `fetch(url, { key: ${join('"AI', 'za', 'Sy', random, 'x9Kq2Lm7Pw3Vn', '"')} })`,
    'URL userinfo password': `DATABASE_URL=${join('postgres://app:', 'Pw4', '-kQ9z', '@db.internal:5432/app')}\n`,
    'high-entropy quoted value': `const token = '${random}';`,
    'high-entropy JSON value': `{ "access_token": "${random}" }`,
  };
  for (const [shape, text] of Object.entries(shapes)) assert.equal(hasSecret(text), true, shape);
});

test('does not flag identifier-shaped values, references, or placeholder passwords', () => {
  const ordinary: Record<string, string> = {
    'lexer token kind': "const token = 'StringLiteralExpressionToken';",
    'token kind in an object': "case 'paren': return { kind: 'token', token: 'LeftParenthesisToken' };",
    'field name': "password: 'passwordConfirmationField',",
    'snake-case constant': 'TOKEN = "_password_reset_token"',
    'kebab-case YAML value': 'secret: my-application-tls-secret\n',
    'bundler-renamed identifier': 'progressToken: ProgressTokenSchema$1\n',
    'environment reference': 'API_TOKEN=${GITHUB_TOKEN}\n',
    'workflow expression': 'token: ${{ secrets.GITHUB_TOKEN }}\n',
    'truncated example': "idToken: 'eyJhbGciOiJS...',",
    'local default URL password': 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n',
    'URL password reference': 'url: postgres://app:${DB_PASSWORD}@db/app\n',
  };
  for (const [shape, text] of Object.entries(ordinary)) assert.equal(hasSecret(text), false, shape);
});

test('screens a file-sized run of URL-like punctuation without quadratic backtracking', () => {
  // Collection screens files up to 256 KB; an unbounded scheme pattern took about 18 seconds here.
  const started = performance.now();
  assert.equal(hasSecret('a.'.repeat(125_000)), false);
  assert.ok(performance.now() - started < 1_000);
});

test('outbound errors name the file path and field without echoing the value', () => {
  assert.throws(() => assertSafeOutbound({ task: 'Review config', files: [{ path: 'ok.ts', content: 'export {};' }, { path: 'config/.env', content: `API_KEY=${random}\n` }] }),
    (error: Error) => error.message.includes('config/.env (field files[1].content)') && !error.message.includes(random));
  assert.throws(() => assertSafeOutbound({ contract: `token: ${random}` }),
    (error: Error) => error.message.includes('field contract') && !error.message.includes(random));
  // A credential-shaped path is named by its field only.
  const slack = join('xo', 'xb-', '1234567890-', random);
  assert.throws(() => assertSafeOutbound({ files: [{ path: `keys/${slack}.txt`, content: 'none' }] }),
    (error: Error) => error.message.includes('field files[0].path') && !error.message.includes(slack));
});
