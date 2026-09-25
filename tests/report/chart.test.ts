import { describe, expect, it } from 'vitest';
import { analyzeResearch } from '../../src/analysis/analyze.ts';
import { buildChart, MAX_CHART_SERIES, SERIES_COLORS, type SceneElement } from '../../src/report/chart.ts';
import { NumberFormatter } from '../../src/report/format.ts';
import { labelsFor } from '../../src/report/labels.ts';
import { renderSvg } from '../../src/report/svg.ts';
import type { ResearchArtifact } from '../../src/schemas/research.ts';
import { dailySeries, dataset, inferredZero, missing } from '../analysis/fixtures.ts';
import { realArtifact } from './helpers.ts';

const options = (language = 'uk') => ({ width: 520, height: 200, labels: labelsFor(language, undefined).labels, format: new NumberFormatter(language) });

function ofKind<K extends SceneElement['kind']>(elements: SceneElement[], kind: K) {
  return elements.filter((element): element is Extract<SceneElement, { kind: K }> => element.kind === kind);
}

/** Artifact built from fixtures (daily), analysed by the real analysis code. */
function syntheticArtifact(observationsByLang: Record<string, ReturnType<typeof dailySeries>>, period = { id: 'main', start: '2025-01-01', end: '2025-01-10' }): ResearchArtifact {
  const base = realArtifact();
  const datasets = Object.entries(observationsByLang).map(([lang, observations]) => dataset(lang, 'daily', observations, { title: `Стаття ${lang}` }));
  const { analysis } = analyzeResearch(datasets, { periods: [period] });
  return { ...base, plan: { ...base.plan, periods: [period], granularity: 'daily' }, datasets, analysis };
}

describe('buildChart with real data', () => {
  const scene = buildChart(realArtifact(), options());

  it('draws one colored line per language edition in every period panel', () => {
    const lines = ofKind(scene.elements, 'polyline');
    expect(new Set(lines.map((line) => line.stroke))).toEqual(new Set([SERIES_COLORS[0], SERIES_COLORS[1]]));
    // 2 languages × 2 panels, no gaps in the real data.
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.points.length === 12)).toBe(true);
  });

  it('labels axes, periods and the legend with Unicode titles', () => {
    const texts = ofKind(scene.elements, 'text').map((text) => text.text);
    expect(texts).toContain('Перегляди в часі (Переглядів за місяць)');
    expect(texts).toContain('2024-01-01 – 2024-12-31');
    expect(texts).toContain('uk · Астрономія');
    expect(texts).toContain('pl · Astronomia');
    expect(texts).toContain('виявлений сплеск');
    expect(texts).toContain('0');
  });

  it('rings the spikes found by the analysis', () => {
    // Plot rings (r = 3.8); the legend's spike symbol is a separate, smaller ring.
    const rings = ofKind(scene.elements, 'circle').filter((circle) => circle.fill === null && circle.r === 3.8);
    expect(rings).toHaveLength(2);
  });

  it('renders valid, escaped SVG', () => {
    const svg = renderSvg(scene);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<title>Перегляди в часі');
    expect(svg.match(/<polyline /g)).toHaveLength(4);
    expect(renderSvg({ ...scene, title: 'a<b&c' })).toContain('a&lt;b&amp;c');
  });
});

describe('buildChart with missing and uncertain data', () => {
  it('breaks lines at missing units instead of drawing zeros', () => {
    const artifact = syntheticArtifact({ uk: dailySeries('2025-01-01', [5, 6, null, null, 8, 9, 7, 6, 5, 4]) });
    const scene = buildChart(artifact, options());
    const lines = ofKind(scene.elements, 'polyline');
    expect(lines.map((line) => line.points.length)).toEqual([2, 6]);
    // The zero baseline is the heavier axis gridline; no value in this series is zero, so nothing may touch it.
    const baseline = ofKind(scene.elements, 'line').find((line) => line.width === 0.8);
    expect(baseline).toBeDefined();
    expect(lines.flatMap((line) => line.points).some(([, y]) => Math.abs(y - (baseline?.y1 ?? 0)) < 0.01)).toBe(false);
    expect(ofKind(scene.elements, 'text').map((text) => text.text)).toContain('розрив = немає даних');
  });

  it('shows inferred zeros as hollow markers on dashed segments, distinct from observed zeros', () => {
    const observations = dailySeries('2025-01-01', [5, 0, 5, 5, 5, 5, 5, 5, 5, 5]);
    observations[4] = inferredZero('2025-01-05');
    const scene = buildChart(syntheticArtifact({ uk: observations }), options());
    const dashed = ofKind(scene.elements, 'polyline').filter((line) => line.dash);
    expect(dashed).toHaveLength(1);
    expect(dashed[0]?.points).toHaveLength(3);
    const hollow = ofKind(scene.elements, 'circle').filter((circle) => circle.fill === '#ffffff' && circle.stroke === SERIES_COLORS[0]);
    expect(hollow).toHaveLength(1);
    expect(ofKind(scene.elements, 'text').map((text) => text.text)).toContain('імовірний нуль');
  });

  it('shades incomplete periods', () => {
    const observations = [...dailySeries('2025-01-01', [5, 6, 7, 8, 9]), ...['06', '07', '08', '09', '10'].map((day) => missing(`2025-01-${day}`, 'incomplete'))];
    const scene = buildChart(syntheticArtifact({ uk: observations }), options('en'));
    expect(ofKind(scene.elements, 'rect').filter((rect) => rect.fill === '#efeee9').length).toBeGreaterThanOrEqual(2);
    expect(ofKind(scene.elements, 'text').map((text) => text.text)).toContain('incomplete period');
  });

  it('refuses more language editions than the palette has colors', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CHART_SERIES + 1 }, (_, index) => [`l${index}`, dailySeries('2025-01-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]));
    expect(() => buildChart(syntheticArtifact(many), options())).toThrow(/at most 8/);
  });
});
