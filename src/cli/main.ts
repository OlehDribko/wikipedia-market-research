import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { FileCache, resolveCacheDir } from '../cache/fileCache.ts';
import { buildUserAgent, createAxiosTransport, createJsonClient } from '../wikimedia/http.ts';
import { COMMANDS, findCommand, type Command, type CommandDeps } from './commands.ts';
import { VERSION } from '../version.ts';
import { errorEnvelope, successEnvelope } from './envelope.ts';
import { CliError, ErrorCode } from './errors.ts';
import { commandHelp, generalHelp } from './help.ts';

export interface CliIO {
  write(text: string): void;
  now(): Date;
}

const defaultIO: CliIO = {
  write: (text) => process.stdout.write(text),
  now: () => new Date(),
};

const defaultDeps: CommandDeps = {
  wikimedia: () => createJsonClient({ transport: createAxiosTransport(buildUserAgent(process.env)) }),
  cache: () => new FileCache({ dir: resolveCacheDir(process.env) }),
  now: () => new Date(),
};

const HELP_FLAGS = new Set(['-h', '--help']);
const COMMAND_NAMES = COMMANDS.map((command) => command.name).join(', ');

/** Runs the CLI and returns the process exit code. Never throws. */
export async function main(argv: readonly string[], io: CliIO = defaultIO, deps: CommandDeps = defaultDeps): Promise<number> {
  const [first, ...rest] = argv;

  if (first !== undefined && HELP_FLAGS.has(first)) {
    io.write(generalHelp(COMMANDS));
    return 0;
  }
  if (first === '--version') {
    io.write(`${VERSION}\n`);
    return 0;
  }

  let commandName: string | null = null;
  try {
    const command = selectCommand(first);
    commandName = command.name;

    if (rest.some((arg) => HELP_FLAGS.has(arg))) {
      io.write(commandHelp(command));
      return 0;
    }

    const result = await command.run(parseFlags(command, rest), deps);
    writeJson(io, successEnvelope(command.name, result, io.now()));
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error), {
            hint: 'This is a bug in the skill. Please report it with the command you ran.',
          });
    writeJson(io, errorEnvelope(commandName, cliError, io.now()));
    return cliError.exitCode;
  }
}

function selectCommand(name: string | undefined): Command {
  if (name === undefined) {
    throw new CliError(ErrorCode.MISSING_COMMAND, 'No command given.', {
      hint: `Use one of: ${COMMAND_NAMES}. Run \`node scripts/wmr.ts --help\` for usage.`,
    });
  }
  if (name.startsWith('-')) {
    throw new CliError(ErrorCode.INVALID_ARGUMENTS, `Unexpected option "${name}" before the command.`, {
      hint: `Put options after the command: node scripts/wmr.ts <${COMMAND_NAMES.replaceAll(', ', '|')}> [options].`,
    });
  }
  const command = findCommand(name);
  if (!command) {
    throw new CliError(ErrorCode.UNKNOWN_COMMAND, `Unknown command "${name}".`, {
      hint: `Use one of: ${COMMAND_NAMES}.`,
    });
  }
  return command;
}

function parseFlags(command: Command, args: string[]): Record<string, unknown> {
  const options: ParseArgsOptionsConfig = Object.fromEntries(
    command.options.map((option) => [option.name, { type: option.type }]),
  );
  try {
    const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
    return { ...values };
  } catch (error) {
    throw new CliError(ErrorCode.INVALID_ARGUMENTS, error instanceof Error ? error.message : String(error), {
      hint: `Run \`node scripts/wmr.ts ${command.name} --help\` for the list of options.`,
    });
  }
}

function writeJson(io: CliIO, value: unknown): void {
  io.write(`${JSON.stringify(value, null, 2)}\n`);
}
