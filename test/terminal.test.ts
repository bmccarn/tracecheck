import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownText, terminalLines, terminalText } from '../src/terminal.js';

test('Markdown escaping leaves intraword underscores alone and escapes emphasis, links, code, and HTML', () => {
  assert.equal(markdownText('src/foo_bar.ts'), 'src/foo_bar.ts');
  assert.equal(markdownText('pkg/__init__.py'), 'pkg/\\_\\_init\\_\\_.py');
  assert.equal(markdownText('a*b*[c](d)`e`<f>|g~h\\i'), 'a\\*b\\*\\[c\\](d)\\`e\\`\\<f>\\|g\\~h\\\\i');
});

test('control characters print as visible escapes; only multi-line text keeps newline and tab', () => {
  assert.equal(terminalText('a\tb\nc\x1b[2J\x7f\x9b'), 'a\\x09b\\x0ac\\x1b[2J\\x7f\\x9b');
  assert.equal(terminalLines('one\r\ntwo\tthree\rfour\x07'), 'one\ntwo\tthree\\x0dfour\\x07');
});
