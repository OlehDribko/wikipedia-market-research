import { enumerateDays, enumerateMonths } from '../periods/dates.ts';
import type { ResearchArtifact } from '../schemas/research.ts';
import { textWidth, type FontWeight } from './fonts.ts';
import type { NumberFormatter } from './format.ts';
import type { Labels } from './labels.ts';

/**
 * Chart layout as plain shapes, rendered identically to SVG and to PDF.
 * Small multiples: one panel per research period, a shared y-axis, one line per language edition.
 * Missing units break the line; inferred zeros are hollow markers on dashed segments; spikes are ringed.
 */

export type SceneElement =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number; dash?: [number, number] }
  | { kind: 'polyline'; points: [number, number][]; stroke: string; width: number; dash?: [number, number] }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string | null; stroke: string | null; width: number }
  | { kind: 'text'; x: number; y: number; text: string; size: number; fill: string; anchor: 'start' | 'middle' | 'end'; weight: FontWeight };

export interface ChartScene {
  width: number;
  height: number;
  title: string;
  elements: SceneElement[];
}

/** Validated categorical palette (dataviz reference instance), assigned in fixed order. */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;
export const MAX_CHART_SERIES = SERIES_COLORS.length;

export const INK = {
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#8a8984',
  grid: '#e6e5e1',
  axis: '#b4b3ad',
  band: '#efeee9',
  surface: '#ffffff',
} as const;

const FONT = { tick: 6.5, label: 7, legend: 7 } as const;
const LINE_WIDTH = 1.5;
const DASH: [number, number] = [2, 2];

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return nice * magnitude;
}

function unitsOf(period: { start: string; end: string }, granularity: 'daily' | 'monthly'): string[] {
  return granularity === 'daily' ? enumerateDays(period) : enumerateMonths(period);
}

interface LegendItem {
  draw: (x: number, y: number) => SceneElement[];
  swatchWidth: number;
  text: string;
}

/** Positions legend items left to right, wrapping into rows. Returns elements and the height used. */
function layoutLegend(items: readonly LegendItem[], left: number, top: number, width: number): { elements: SceneElement[]; height: number } {
  const elements: SceneElement[] = [];
  const rowHeight = 10;
  let x = left;
  let y = top + 7;
  let rows = items.length > 0 ? 1 : 0;
  for (const item of items) {
    const itemWidth = item.swatchWidth + 3 + textWidth(item.text, FONT.legend) + 12;
    if (x > left && x + itemWidth > left + width) {
      x = left;
      y += rowHeight;
      rows++;
    }
    elements.push(...item.draw(x, y - 2.3));
    elements.push({ kind: 'text', x: x + item.swatchWidth + 3, y, text: item.text, size: FONT.legend, fill: INK.secondary, anchor: 'start', weight: 'regular' });
    x += itemWidth;
  }
  return { elements, height: rows * rowHeight };
}

export function buildChart(artifact: ResearchArtifact, options: { width: number; height: number; labels: Labels; format: NumberFormatter }): ChartScene {
  const { width, height, labels, format } = options;
  const { granularity, periods } = artifact.plan;
  const datasets = artifact.datasets;
  if (datasets.length > MAX_CHART_SERIES) throw new Error(`The chart supports at most ${MAX_CHART_SERIES} language editions.`);

  const title = `${labels.chartTitle} (${granularity === 'daily' ? labels.viewsPerDay : labels.viewsPerMonth})`;
  const elements: SceneElement[] = [{ kind: 'rect', x: 0, y: 0, w: width, h: height, fill: INK.surface }];
  const observation = datasets.map((dataset) => new Map(dataset.observations.map((item) => [item.period, item])));
  const anomalyUnits = new Set(
    artifact.analysis.languages.flatMap((language) =>
      language.periods.flatMap((period) => period.anomalies.anomalies.map((anomaly) => `${language.lang}|${anomaly.period}`)),
    ),
  );

  const panelUnits = periods.map((period) => unitsOf(period, granularity));
  let maxValue = 0;
  let anyInferred = false;
  let anyGap = false;
  let anyIncomplete = false;
  datasets.forEach((dataset, index) => {
    for (const units of panelUnits) {
      for (const unit of units) {
        const item = observation[index]?.get(unit);
        if (item?.status === 'observed' || item?.status === 'zero_omitted') maxValue = Math.max(maxValue, item.views ?? 0);
        if (item?.status === 'zero_omitted') anyInferred = true;
        else if (item?.status === 'incomplete') anyIncomplete = true;
        else if (!item || item.status !== 'observed') anyGap = true;
      }
    }
  });
  const anySpike = anomalyUnits.size > 0;

  // Legend first: its height decides the plot area.
  const legendItems: LegendItem[] = datasets.map((dataset, index) => ({
    swatchWidth: 12,
    text: `${dataset.lang} · ${dataset.title}`,
    draw: (x, y) => [{ kind: 'line', x1: x, y1: y, x2: x + 12, y2: y, stroke: SERIES_COLORS[index] as string, width: 2 }],
  }));
  if (anyInferred) {
    legendItems.push({ swatchWidth: 6, text: labels.legendInferred, draw: (x, y) => [{ kind: 'circle', cx: x + 3, cy: y, r: 2.2, fill: INK.surface, stroke: INK.secondary, width: 1 }] });
  }
  if (anySpike) {
    legendItems.push({ swatchWidth: 8, text: labels.legendSpike, draw: (x, y) => [{ kind: 'circle', cx: x + 4, cy: y, r: 3.5, fill: null, stroke: INK.primary, width: 0.8 }] });
  }
  if (anyIncomplete) {
    legendItems.push({ swatchWidth: 10, text: labels.legendIncomplete, draw: (x, y) => [{ kind: 'rect', x, y: y - 3.5, w: 10, h: 7, fill: INK.band }] });
  }
  if (anyGap) {
    legendItems.push({
      swatchWidth: 14,
      text: labels.legendGap,
      draw: (x, y) => [
        { kind: 'line', x1: x, y1: y, x2: x + 5, y2: y, stroke: INK.secondary, width: 1.5 },
        { kind: 'line', x1: x + 9, y1: y, x2: x + 14, y2: y, stroke: INK.secondary, width: 1.5 },
      ],
    });
  }
  const legend = layoutLegend(legendItems, 0, 0, width);

  // Y scale shared by all panels.
  const step = maxValue > 0 ? niceStep(maxValue / 4) : 1;
  const yMax = maxValue > 0 ? Math.ceil(maxValue / step) * step : 4;
  const ticks: number[] = [];
  for (let value = 0; value <= yMax + step / 2; value += step) ticks.push(value);
  const tickLabels = ticks.map((value) => format.decimal(value));
  const yLabelWidth = Math.max(...tickLabels.map((label) => textWidth(label, FONT.tick)));

  const directLabels = datasets.length <= 4;
  const directLabelWidth = directLabels ? Math.max(0, ...datasets.map((dataset) => textWidth(dataset.lang, FONT.label, 'bold'))) + 8 : 0;

  const plotLeft = yLabelWidth + 5;
  const plotRight = width - directLabelWidth - 2;
  const plotTop = 22;
  const plotBottom = height - legend.height - 18;
  const plotHeight = plotBottom - plotTop;
  const y = (value: number) => plotBottom - (value / yMax) * plotHeight;

  elements.push({ kind: 'text', x: 0, y: 7, text: title, size: FONT.label, fill: INK.secondary, anchor: 'start', weight: 'bold' });

  // Gridlines and y tick labels.
  ticks.forEach((value, index) => {
    elements.push({ kind: 'line', x1: plotLeft, y1: y(value), x2: plotRight, y2: y(value), stroke: value === 0 ? INK.axis : INK.grid, width: value === 0 ? 0.8 : 0.5 });
    elements.push({ kind: 'text', x: yLabelWidth, y: y(value) + 2.3, text: tickLabels[index] as string, size: FONT.tick, fill: INK.muted, anchor: 'end', weight: 'regular' });
  });

  if (maxValue === 0 && !datasets.some((_, index) => panelUnits.flat().some((unit) => observation[index]?.get(unit)?.status === 'observed'))) {
    elements.push({ kind: 'text', x: (plotLeft + plotRight) / 2, y: (plotTop + plotBottom) / 2, text: labels.noChartData, size: FONT.label, fill: INK.muted, anchor: 'middle', weight: 'regular' });
  }

  const gap = periods.length > 1 ? 10 : 0;
  const panelWidth = (plotRight - plotLeft - gap * (periods.length - 1)) / periods.length;
  const lastPoints: { index: number; x: number; y: number }[] = [];

  periods.forEach((period, panelIndex) => {
    const units = panelUnits[panelIndex] as string[];
    const left = plotLeft + panelIndex * (panelWidth + gap);
    const slot = units.length > 1 ? panelWidth / (units.length - 1) : 0;
    const x = (unitIndex: number) => (units.length > 1 ? left + unitIndex * slot : left + panelWidth / 2);

    // Period caption above the panel.
    const caption = `${period.start} – ${period.end}`;
    elements.push({ kind: 'text', x: left + panelWidth / 2, y: plotTop - 4, text: caption, size: FONT.tick, fill: INK.secondary, anchor: 'middle', weight: 'regular' });

    // Incomplete units: shaded band.
    const incomplete = units.map((unit) => datasets.some((_, index) => observation[index]?.get(unit)?.status === 'incomplete'));
    for (let start = 0; start < units.length; start++) {
      if (!incomplete[start]) continue;
      let end = start;
      while (end + 1 < units.length && incomplete[end + 1]) end++;
      const half = slot / 2;
      const bandLeft = Math.max(left, x(start) - half);
      const bandRight = Math.min(left + panelWidth, x(end) + half);
      elements.push({ kind: 'rect', x: bandLeft, y: plotTop, w: Math.max(bandRight - bandLeft, 1), h: plotHeight, fill: INK.band });
      start = end;
    }

    // X ticks: evenly spaced, as many as fit.
    const labelSample = granularity === 'daily' ? '2025-01-01' : '2025-01';
    const maxTicks = Math.max(2, Math.floor(panelWidth / (textWidth(labelSample, FONT.tick) + 10)));
    // Regular interval from the first unit (e.g. every 2nd month), never more ticks than fit.
    const interval = Math.max(1, Math.ceil((units.length - 1) / Math.max(maxTicks - 1, 1)));
    const tickIndexes: number[] = [];
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += interval) tickIndexes.push(unitIndex);
    for (const unitIndex of tickIndexes) {
      const unit = units[unitIndex] as string;
      const label = granularity === 'daily' ? unit : unit.slice(0, 7);
      const anchor = tickIndexes.length === 1 ? 'middle' : unitIndex === 0 ? 'start' : unitIndex === units.length - 1 ? 'end' : 'middle';
      elements.push({ kind: 'line', x1: x(unitIndex), y1: plotBottom, x2: x(unitIndex), y2: plotBottom + 2.5, stroke: INK.axis, width: 0.5 });
      elements.push({ kind: 'text', x: x(unitIndex), y: plotBottom + 9, text: label, size: FONT.tick, fill: INK.muted, anchor, weight: 'regular' });
    }

    // Series.
    datasets.forEach((dataset, index) => {
      const color = SERIES_COLORS[index] as string;
      const points = units.map((unit, unitIndex) => {
        const item = observation[index]?.get(unit);
        const counted = item?.status === 'observed' || item?.status === 'zero_omitted';
        return counted ? { unit, x: x(unitIndex), y: y(item.views ?? 0), inferred: item.status === 'zero_omitted' } : null;
      });

      // Consecutive counted points form runs; a pair touching an inferred zero is dashed.
      let run: [number, number][] = [];
      let runDashed = false;
      const flush = () => {
        if (run.length > 1) elements.push({ kind: 'polyline', points: run, stroke: color, width: LINE_WIDTH, ...(runDashed && { dash: DASH }) });
        run = [];
      };
      for (let unitIndex = 0; unitIndex < points.length; unitIndex++) {
        const point = points[unitIndex];
        const previous = unitIndex > 0 ? points[unitIndex - 1] : null;
        if (!point) {
          flush();
          continue;
        }
        if (previous) {
          const dashed = previous.inferred || point.inferred;
          if (run.length > 0 && dashed !== runDashed) {
            const last = run[run.length - 1] as [number, number];
            flush();
            run = [last];
          }
          runDashed = dashed;
        } else {
          flush();
          runDashed = false;
        }
        run.push([point.x, point.y]);
      }
      flush();

      points.forEach((point, unitIndex) => {
        if (!point) return;
        const isolated = !points[unitIndex - 1] && !points[unitIndex + 1];
        if (point.inferred) {
          elements.push({ kind: 'circle', cx: point.x, cy: point.y, r: 1.8, fill: INK.surface, stroke: color, width: 0.9 });
        } else if (granularity === 'monthly' || isolated) {
          elements.push({ kind: 'circle', cx: point.x, cy: point.y, r: 1.6, fill: color, stroke: INK.surface, width: 0.5 });
        }
        if (anomalyUnits.has(`${dataset.lang}|${point.unit}`)) {
          elements.push({ kind: 'circle', cx: point.x, cy: point.y, r: 3.8, fill: null, stroke: INK.primary, width: 0.8 });
        }
      });

      if (panelIndex === periods.length - 1) {
        const last = [...points].reverse().find((point) => point !== null);
        if (last) lastPoints.push({ index, x: last.x, y: last.y });
      }
    });
  });

  // Direct labels (≤ 4 series), spread vertically to avoid collisions, joined to line ends by leader lines.
  if (directLabels) {
    const placed = [...lastPoints].sort((a, b) => a.y - b.y);
    let previousY = -Infinity;
    for (const point of placed) {
      const labelY = Math.min(Math.max(point.y, previousY + 8), plotBottom);
      previousY = labelY;
      const labelX = plotRight + 6;
      elements.push({ kind: 'line', x1: point.x + 1.5, y1: point.y, x2: labelX - 1.5, y2: labelY, stroke: INK.axis, width: 0.5 });
      elements.push({ kind: 'text', x: labelX, y: labelY + 2.4, text: datasets[point.index]?.lang ?? '', size: FONT.label, fill: INK.primary, anchor: 'start', weight: 'bold' });
    }
  }

  for (const element of legend.elements) elements.push(offset(element, 0, height - legend.height));
  return { width, height, title, elements };
}

function offset(element: SceneElement, dx: number, dy: number): SceneElement {
  switch (element.kind) {
    case 'line':
      return { ...element, x1: element.x1 + dx, y1: element.y1 + dy, x2: element.x2 + dx, y2: element.y2 + dy };
    case 'polyline':
      return { ...element, points: element.points.map(([px, py]) => [px + dx, py + dy]) };
    case 'rect':
      return { ...element, x: element.x + dx, y: element.y + dy };
    case 'circle':
      return { ...element, cx: element.cx + dx, cy: element.cy + dy };
    case 'text':
      return { ...element, x: element.x + dx, y: element.y + dy };
  }
}
