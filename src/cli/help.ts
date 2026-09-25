import type { Command } from './commands.ts';
import { VERSION } from '../version.ts';

const INVOCATION = 'node scripts/wmr.ts';

export function generalHelp(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  return [
    `wmr ${VERSION} - Wikipedia Market Research`,
    '',
    `Usage: ${INVOCATION} <command> [options]`,
    '',
    'Commands:',
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Global options:',
    '  -h, --help     Show help (also: <command> --help)',
    '  --version      Show version',
    '',
    'Output: every command prints one JSON object to stdout:',
    '  { "ok": true, "command", "data", "warnings", "limitations", "meta" }',
    '  { "ok": false, "command", "error": { "code", "message", "hint", "details" }, "meta" }',
    'Exit codes: 0 ok, 1 invalid usage/input, 2 resolution failure, 3 upstream API failure,',
    '            4 internal error or not implemented.',
    '',
  ].join('\n');
}

export function commandHelp(command: Command): string {
  const labels = command.options.map((option) => `--${option.name}${option.type === 'string' ? ' <value>' : ''}`);
  const width = Math.max(...labels.map((label) => label.length));
  const optionLines = command.options.map((option, index) => {
    const notes = [option.required ? 'required' : null, option.defaultText ? `default: ${option.defaultText}` : null]
      .filter((note) => note !== null)
      .join(', ');
    return `  ${labels[index]?.padEnd(width)}  ${option.description}${notes ? ` (${notes})` : ''}`;
  });

  return [
    `${INVOCATION} ${command.usage}`,
    '',
    command.summary,
    '',
    'Options:',
    ...optionLines,
    '',
    'Examples:',
    ...command.examples.map((example) => `  ${INVOCATION} ${example}`),
    '',
  ].join('\n');
}
