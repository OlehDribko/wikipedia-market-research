import type { ErrorEnvelope, Meta, SuccessEnvelope, Warning } from '../schemas/envelope.ts';
import { VERSION } from '../version.ts';
import type { CliError } from './errors.ts';

export interface CommandResult {
  data: unknown;
  warnings?: Warning[];
  limitations?: string[];
}

export function createMeta(now: Date): Meta {
  return { version: VERSION, generatedAt: now.toISOString() };
}

export function successEnvelope(command: string, result: CommandResult, now: Date): SuccessEnvelope {
  return {
    ok: true,
    command,
    data: result.data,
    warnings: result.warnings ?? [],
    limitations: result.limitations ?? [],
    meta: createMeta(now),
  };
}

export function errorEnvelope(command: string | null, error: CliError, now: Date): ErrorEnvelope {
  return {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined && { hint: error.hint }),
      ...(error.details !== undefined && { details: error.details }),
    },
    meta: createMeta(now),
  };
}
