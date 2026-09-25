import { describe, expect, it } from 'vitest';
import { validateConclusions } from '../../src/report/validate.ts';
import { realArtifact, ukrainianConclusions } from './helpers.ts';

const artifact = realArtifact();

describe('validateConclusions', () => {
  it('accepts conclusions whose IDs exist and whose numbers match cited metrics', () => {
    expect(validateConclusions(ukrainianConclusions(), artifact)).toEqual([]);
  });

  it('rejects unknown metric IDs and suggests close matches', () => {
    const conclusions = ukrainianConclusions();
    conclusions.findings[0]!.evidence = ['uk.compare-1.averageDayly'];
    const issues = validateConclusions(conclusions, artifact);
    expect(issues[0]).toMatchObject({ path: 'findings[0].evidence[0]', code: 'UNKNOWN_METRIC' });
    expect(issues[0]?.suggestions?.[0]).toBe('uk.compare-1.averageDaily');
  });

  it('rejects numbers that are not backed by the cited metrics', () => {
    const conclusions = ukrainianConclusions();
    // 73,59 is a real metric, but of another language and not cited by this finding.
    conclusions.findings[1]!.statement = 'Польський розділ: 73,59 переглядів за день.';
    const issues = validateConclusions(conclusions, artifact);
    expect(issues).toEqual([expect.objectContaining({ path: 'findings[1].statement', code: 'UNSUPPORTED_NUMBER' })]);
    expect(issues[0]?.message).toContain('"73,59"');
  });

  it('rejects statistical numbers outside findings, even when they round to some metric', () => {
    const conclusions = ukrainianConclusions();
    // 70 would round-match uk.compare-1.averageDaily (69.6), but the headline cites no evidence.
    conclusions.headline = 'Інтерес упав на 70 %';
    conclusions.hypotheses[0]!.hypothesis = 'Ринок зросте у 3 рази.';
    conclusions.limitations = ['Похибка приблизно 12,5 %.'];
    expect(validateConclusions(conclusions, artifact).map((issue) => issue.path)).toEqual(['headline', 'hypotheses[0].hypothesis', 'limitations[0]']);
  });

  it('allows planning numbers in validation ideas, years of the research and ratios as percentages', () => {
    const conclusions = ukrainianConclusions();
    conclusions.hypotheses[0]!.validationIdea = 'Провести 12 інтерв’ю за 2 тижні.';
    conclusions.findings.push({ statement: 'Покриття даних у 2024 році — 100 %.', evidence: ['uk.compare-1.coverage'] });
    expect(validateConclusions(conclusions, artifact)).toEqual([]);
  });

  it('rejects dates outside the research periods', () => {
    const conclusions = ukrainianConclusions();
    conclusions.limitations = ['Дані до 2019-01-01 не аналізувалися.'];
    expect(validateConclusions(conclusions, artifact)[0]).toMatchObject({ code: 'DATE_OUTSIDE_RESEARCH' });
  });

  it('rejects characters the report font cannot render', () => {
    const conclusions = ukrainianConclusions();
    conclusions.headline = 'Зростання 🚀';
    conclusions.limitations = ['数据有限'];
    const issues = validateConclusions(conclusions, artifact).filter((issue) => issue.code === 'UNSUPPORTED_CHARACTERS');
    expect(issues.map((issue) => issue.path)).toEqual(['headline', 'limitations[0]']);
  });
});
