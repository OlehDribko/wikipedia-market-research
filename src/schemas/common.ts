import { z } from 'zod';
import { parseDateBound, type DateRange, type DateRole } from '../periods/dates.ts';

export const MAX_LANGUAGES = 10;
export const MAX_COMPARISON_RANGES = 4;

/** Wikipedia language edition code (subdomain), e.g. "en", "uk", "zh-yue", "be-tarask". */
export const LanguageCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Language code is too short.')
  .max(20, 'Language code is too long.')
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    'Expected a Wikipedia language code such as "en", "uk" or "zh-yue".',
  );

/** Comma-separated language codes, deduplicated in the given order. */
export const LanguageListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0),
  )
  .pipe(
    z
      .array(LanguageCodeSchema)
      .min(1, 'At least one language code is required.')
      .max(MAX_LANGUAGES, `At most ${MAX_LANGUAGES} languages per run.`),
  )
  .transform((codes) => [...new Set(codes)]);

export const TopicSchema = z
  .string()
  .trim()
  .min(1, 'Topic must not be empty.')
  .max(200, 'Topic must be at most 200 characters.');

/** Characters MediaWiki forbids in page titles. */
const ILLEGAL_TITLE_CHARS = /[#<>[\]|{}]/;

export interface ArticleRef {
  lang: string;
  title: string;
}

/** `LANG:Title`, split at the first colon so titles may contain colons. */
export const ArticleRefSchema = z.string().transform((value, ctx): ArticleRef => {
  const separator = value.indexOf(':');
  const lang = LanguageCodeSchema.safeParse(separator > 0 ? value.slice(0, separator) : '');
  const title = separator > 0 ? value.slice(separator + 1).trim() : '';

  if (!lang.success || title.length === 0) {
    ctx.issues.push({
      code: 'custom',
      input: value,
      message: 'Expected LANG:Title, e.g. "en:Intermittent_fasting".',
    });
    return z.NEVER;
  }
  if (title.length > 255 || ILLEGAL_TITLE_CHARS.test(title)) {
    ctx.issues.push({
      code: 'custom',
      input: value,
      message: 'Article title is too long or contains characters not allowed in Wikipedia titles (# < > [ ] | { }).',
    });
    return z.NEVER;
  }
  return { lang: lang.data, title };
});

export const IsoDateSchema = z.iso.date();

export const DateRangeSchema = z.object({
  start: IsoDateSchema,
  end: IsoDateSchema,
});

function dateBoundSchema(role: DateRole) {
  return z.string().transform((value, ctx) => {
    const parsed = parseDateBound(value, role);
    if (parsed === null) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        message: `Invalid date "${value}". Use YYYY-MM-DD or YYYY-MM.`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

export const StartDateSchema = dateBoundSchema('start');
export const EndDateSchema = dateBoundSchema('end');

/** Comma-separated `START..END` ranges, each bound in YYYY-MM-DD or YYYY-MM form. */
export const ComparisonRangesSchema = z
  .string()
  .transform((value, ctx): DateRange[] => {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const ranges: DateRange[] = [];

    for (const part of parts) {
      const bounds = part.split('..');
      const start = bounds.length === 2 && bounds[0] ? parseDateBound(bounds[0], 'start') : null;
      const end = bounds.length === 2 && bounds[1] ? parseDateBound(bounds[1], 'end') : null;
      if (start === null || end === null) {
        ctx.issues.push({
          code: 'custom',
          input: value,
          message: `Invalid comparison range "${part}". Use START..END, e.g. 2024-01..2024-06 or 2024-01-15..2024-02-14.`,
        });
        return z.NEVER;
      }
      if (start > end) {
        ctx.issues.push({
          code: 'custom',
          input: value,
          message: `Comparison range "${part}" ends before it starts.`,
        });
        return z.NEVER;
      }
      ranges.push({ start, end });
    }
    return ranges;
  })
  .pipe(
    z
      .array(DateRangeSchema)
      .min(2, 'Provide at least 2 comparison ranges.')
      .max(MAX_COMPARISON_RANGES, `Provide at most ${MAX_COMPARISON_RANGES} comparison ranges.`),
  );

export const GranularitySchema = z.enum(['auto', 'daily', 'monthly']);
export type Granularity = z.infer<typeof GranularitySchema>;
