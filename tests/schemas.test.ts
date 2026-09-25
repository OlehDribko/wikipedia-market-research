import { describe, expect, it } from 'vitest';
import { ArticleRefSchema, ComparisonRangesSchema, LanguageListSchema } from '../src/schemas/common.ts';
import { ConclusionsSchema } from '../src/schemas/conclusions.ts';
import { ReportInputSchema, ResearchInputSchema, ResolveInputSchema } from '../src/schemas/inputs.ts';
import { ObservationSchema } from '../src/schemas/observation.ts';

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe('LanguageListSchema', () => {
  it('normalizes, trims and deduplicates in order', () => {
    expect(LanguageListSchema.parse(' EN, uk ,en,zh-yue,')).toEqual(['en', 'uk', 'zh-yue']);
  });

  it('rejects empty lists and malformed codes', () => {
    expect(LanguageListSchema.safeParse(' , ').success).toBe(false);
    expect(LanguageListSchema.safeParse('en,english!').success).toBe(false);
    expect(LanguageListSchema.safeParse('e').success).toBe(false);
  });

  it('limits the number of languages', () => {
    const eleven = 'en,de,fr,es,it,pl,uk,nl,pt,sv,fi';
    expect(LanguageListSchema.safeParse(eleven).success).toBe(false);
  });
});

describe('ArticleRefSchema', () => {
  it('splits at the first colon only', () => {
    expect(ArticleRefSchema.parse('en:Star Wars: Episode IV')).toEqual({ lang: 'en', title: 'Star Wars: Episode IV' });
  });

  it('accepts non-Latin titles', () => {
    expect(ArticleRefSchema.parse('uk:Інтервальне голодування')).toEqual({ lang: 'uk', title: 'Інтервальне голодування' });
    expect(ArticleRefSchema.parse('pl:Post przerywany')).toEqual({ lang: 'pl', title: 'Post przerywany' });
  });

  it.each(['Pilates', ':Pilates', 'en:', 'en:A|B', 'en_GB:Pilates'])('rejects %j', (value) => {
    expect(ArticleRefSchema.safeParse(value).success).toBe(false);
  });
});

describe('ComparisonRangesSchema', () => {
  it('parses month and day ranges', () => {
    expect(ComparisonRangesSchema.parse('2024-01..2024-06, 2025-01-15..2025-02-14')).toEqual([
      { start: '2024-01-01', end: '2024-06-30' },
      { start: '2025-01-15', end: '2025-02-14' },
    ]);
  });

  it('rejects malformed, reversed, single and too many ranges', () => {
    expect(ComparisonRangesSchema.safeParse('2024-01-2024-06,2025-01..2025-06').success).toBe(false);
    expect(ComparisonRangesSchema.safeParse('2024-06..2024-01,2025-01..2025-06').success).toBe(false);
    expect(ComparisonRangesSchema.safeParse('2024-01..2024-06').success).toBe(false);
    expect(ComparisonRangesSchema.safeParse('2021-01..2021-02,2022-01..2022-02,2023-01..2023-02,2024-01..2024-02,2025-01..2025-02').success).toBe(false);
  });
});

describe('ResearchInputSchema', () => {
  it('normalizes a topic request with the default period', () => {
    expect(ResearchInputSchema.parse({ topic: ' Intermittent fasting ', lang: 'en', langs: 'en,de' })).toEqual({
      subject: { kind: 'topic', topic: 'Intermittent fasting', lang: 'en' },
      languages: ['en', 'de'],
      period: { mode: 'default' },
      comparisons: null,
      granularity: 'auto',
      outDir: 'output',
      useCache: true,
    });
  });

  it('normalizes an article request with an explicit period', () => {
    const request = ResearchInputSchema.parse({
      article: 'en:Pilates',
      langs: 'en',
      start: '2024-01',
      end: '2024-12',
      granularity: 'monthly',
      'no-cache': true,
    });
    expect(request.subject).toEqual({ kind: 'article', lang: 'en', title: 'Pilates' });
    expect(request.period).toEqual({ mode: 'explicit', range: { start: '2024-01-01', end: '2024-12-31' } });
    expect(request.useCache).toBe(false);
  });

  it('requires --langs explicitly', () => {
    const result = ResearchInputSchema.safeParse({ article: 'en:Pilates' });
    expect(messages(result)).toEqual(['--langs is required, e.g. --langs en,de,uk.']);
  });

  it.each([
    [{ langs: 'en' }, 'Provide --topic with --lang'],
    [{ topic: 'x', article: 'en:X', lang: 'en', langs: 'en' }, 'Use either --topic or --article'],
    [{ topic: 'x', langs: 'en' }, '--lang is required with --topic'],
    [{ article: 'en:X', lang: 'en', langs: 'en' }, '--lang is only used with --topic'],
    [{ article: 'en:X', langs: 'en', start: '2024-01' }, 'Provide both --start and --end'],
    [{ article: 'en:X', langs: 'en', start: '2024-06', end: '2024-01' }, '--end must not be earlier'],
    [{ article: 'en:X', langs: 'en', start: '2024-01-15', end: '2024-02-14', granularity: 'monthly' }, 'Monthly granularity requires'],
    [{ article: 'en:X', langs: 'en', granularity: 'weekly' }, 'Invalid option'],
  ])('rejects %j', (input, expected) => {
    const result = ResearchInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messages(result).join(' | ')).toContain(expected);
  });

  it('accepts monthly granularity for month-aligned comparisons', () => {
    const request = ResearchInputSchema.parse({
      article: 'en:X',
      langs: 'en',
      compare: '2024-01..2024-06,2025-01..2025-06',
      granularity: 'monthly',
    });
    expect(request.comparisons).toHaveLength(2);
    expect(request.period).toEqual({ mode: 'comparisons' });
  });

  it('keeps an explicit period alongside comparisons', () => {
    const request = ResearchInputSchema.parse({
      article: 'en:X',
      langs: 'en',
      start: '2024-01',
      end: '2025-06',
      compare: '2024-01..2024-06,2025-01..2025-06',
    });
    expect(request.period).toEqual({ mode: 'explicit', range: { start: '2024-01-01', end: '2025-06-30' } });
  });
});

describe('ResolveInputSchema', () => {
  it('applies defaults and parses --limit', () => {
    expect(ResolveInputSchema.parse({ topic: 'Mercury', lang: 'en' })).toEqual({
      topic: 'Mercury',
      lang: 'en',
      languages: null,
      limit: 5,
    });
    expect(ResolveInputSchema.parse({ topic: 'Mercury', lang: 'en', langs: 'de,uk', limit: '3' }).limit).toBe(3);
  });

  it.each(['0', '11', '2.5', 'many'])('rejects --limit %j', (limit) => {
    expect(ResolveInputSchema.safeParse({ topic: 'Mercury', lang: 'en', limit }).success).toBe(false);
  });

  it('requires topic and lang', () => {
    expect(messages(ResolveInputSchema.safeParse({}))).toEqual([
      '--topic is required, e.g. --topic "Intermittent fasting".',
      '--lang is required, e.g. --lang en.',
    ]);
  });
});

describe('ReportInputSchema', () => {
  it('normalizes paths', () => {
    expect(ReportInputSchema.parse({ research: 'output/r.json', conclusions: 'output/c.json' })).toEqual({
      researchPath: 'output/r.json',
      conclusionsPath: 'output/c.json',
      outPath: null,
    });
  });

  it('checks file extensions', () => {
    expect(ReportInputSchema.safeParse({ research: 'r.csv', conclusions: 'c.json' }).success).toBe(false);
    expect(ReportInputSchema.safeParse({ research: 'r.json', conclusions: 'c.json', out: 'report.png' }).success).toBe(false);
  });
});

describe('ObservationSchema', () => {
  const base = { period: '2025-01-01', certainty: 'established', reason: 'test' } as const;

  it('accepts consistent observations', () => {
    expect(ObservationSchema.safeParse({ ...base, status: 'observed', views: 120 }).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...base, status: 'zero_omitted', views: 0, certainty: 'uncertain' }).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...base, status: 'api_error', views: null }).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...base, status: 'unavailable', views: null, certainty: 'uncertain' }).success).toBe(true);
  });

  it('never allows a value for missing data or null for counted data', () => {
    expect(ObservationSchema.safeParse({ ...base, status: 'api_error', views: 0 }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...base, status: 'before_creation', views: 0 }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...base, status: 'observed', views: null }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...base, status: 'zero_omitted', views: 5 }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...base, status: 'observed', views: 5, certainty: 'uncertain' }).success).toBe(false);
  });
});

describe('ConclusionsSchema', () => {
  const valid = {
    language: 'uk',
    headline: 'Інтерес до теми стабільно зростає',
    findings: [{ statement: 'Перегляди зросли у 2025 році.', evidence: ['uk.compare.pctChange'] }],
    hypotheses: [{ hypothesis: 'Є попит на україномовний контент.', validationIdea: 'Опитування 20 користувачів.' }],
    limitations: ['Перегляди не дорівнюють унікальним користувачам.'],
    labels: { findings: 'Висновки' },
  };

  it('accepts Unicode conclusions in the user language', () => {
    expect(ConclusionsSchema.safeParse(valid).success).toBe(true);
  });

  it('requires evidence for every finding and at least one limitation', () => {
    expect(ConclusionsSchema.safeParse({ ...valid, findings: [{ statement: 'x', evidence: [] }] }).success).toBe(false);
    expect(ConclusionsSchema.safeParse({ ...valid, findings: [{ statement: 'x', evidence: ['total'] }] }).success).toBe(false);
    expect(ConclusionsSchema.safeParse({ ...valid, limitations: [] }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(ConclusionsSchema.safeParse({ ...valid, forecast: 'up' }).success).toBe(false);
  });
});
