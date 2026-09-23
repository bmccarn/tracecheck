// Human-readable output quotes repository paths, source, and provider text. C0 controls, DEL, and C1 controls reach a
// terminal as commands: ESC, CSI, and OSC sequences can clear the screen, set the window title, or write the clipboard.
// JSON and SARIF output escape them already and do not use these helpers.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const CONTROL_EXCEPT_LINE_BREAK_AND_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// An underscore between two letters or digits cannot open or close emphasis, so paths such as `foo_bar.ts` stay unescaped.
const MARKDOWN = /[\\`*[\]<|~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;

const visible = (character: string) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;

/** Text for one line of output. Every control character, including newline and tab, is shown as `\xNN`. */
export function terminalText(text: string): string {
  return text.replace(CONTROL, visible);
}

/** Text that may span lines, such as source or an error message. Newline and tab stay; CRLF becomes one newline. */
export function terminalLines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(CONTROL_EXCEPT_LINE_BREAK_AND_TAB, visible);
}

/** Text inside one line of Markdown. Markdown-significant characters are backslash-escaped, then controls shown as `\xNN`. */
export function markdownText(text: string): string {
  return terminalText(text.replace(MARKDOWN, '\\$&'));
}
