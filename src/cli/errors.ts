export const ErrorCode = {
  MISSING_COMMAND: 'MISSING_COMMAND',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_LANGUAGE: 'INVALID_LANGUAGE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
  AMBIGUOUS_TOPIC: 'AMBIGUOUS_TOPIC',
  TOPIC_NOT_FOUND: 'TOPIC_NOT_FOUND',
  ARTICLE_NOT_FOUND: 'ARTICLE_NOT_FOUND',
  NO_VERIFIED_ARTICLES: 'NO_VERIFIED_ARTICLES',
  OUTPUT_ERROR: 'OUTPUT_ERROR',
  INVALID_RESEARCH_FILE: 'INVALID_RESEARCH_FILE',
  INVALID_CONCLUSIONS: 'INVALID_CONCLUSIONS',
  REPORT_DOES_NOT_FIT: 'REPORT_DOES_NOT_FIT',
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
  AMBIGUOUS_TOPIC: 2,
  TOPIC_NOT_FOUND: 2,
  ARTICLE_NOT_FOUND: 2,
  NO_VERIFIED_ARTICLES: 2,
  OUTPUT_ERROR: 1,
  INVALID_RESEARCH_FILE: 1,
  INVALID_CONCLUSIONS: 1,
  REPORT_DOES_NOT_FIT: 1,
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
