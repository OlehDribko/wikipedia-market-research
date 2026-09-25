export const ErrorCode = {
  MISSING_COMMAND: 'MISSING_COMMAND',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_LANGUAGE: 'INVALID_LANGUAGE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 0 ok · 1 invalid usage/input · 2 resolution failure · 3 upstream API failure · 4 internal/not implemented. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  MISSING_COMMAND: 1,
  UNKNOWN_COMMAND: 1,
  INVALID_ARGUMENTS: 1,
  INVALID_INPUT: 1,
  INVALID_LANGUAGE: 1,
  UPSTREAM_ERROR: 3,
  UNEXPECTED_RESPONSE: 3,
  NOT_IMPLEMENTED: 4,
  INTERNAL_ERROR: 4,
};

export interface CliErrorOptions {
  hint?: string;
  details?: unknown;
}

/** An expected failure that is reported to the caller as a structured error envelope. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}
