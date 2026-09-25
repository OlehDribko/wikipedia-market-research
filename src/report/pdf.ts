import PDFDocument from 'pdfkit';
import type { ChartScene, SceneElement } from './chart.ts';
import { INK } from './chart.ts';
import { FONT_FILES } from './fonts.ts';
import type { ReportModel, Table, TableCell } from './model.ts';

/** A4 in points. */
const PAGE = { width: 595.28, height: 841.89, margin: 36, bottomLimit: 841.89 - 28 } as const;
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;

/** Layout attempts from roomiest to most compact; the first that fits one page is used. */
export const LAYOUT_ATTEMPTS = [
  { scale: 1, chartHeight: 215 },
  { scale: 1, chartHeight: 185 },
  { scale: 0.94, chartHeight: 170 },
  { scale: 0.88, chartHeight: 155 },
  { scale: 0.82, chartHeight: 145 },
  { scale: 0.76, chartHeight: 135 },
] as const;

export type Layout = (typeof LAYOUT_ATTEMPTS)[number];

export class ReportDoesNotFitError extends Error {
  readonly overflow: number;

  constructor(overflow: number) {
    super(`The report needs ${Math.ceil(overflow)} more points than one A4 page provides, even at the most compact layout.`);
    this.name = 'ReportDoesNotFitError';
    this.overflow = overflow;
  }
}

type Doc = PDFKit.PDFDocument;

function createDocument(model: ReportModel, generatedAt: Date): Doc {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.margin, left: PAGE.margin, right: PAGE.margin, bottom: 20 },
    bufferPages: true,
    autoFirstPage: true,
    lang: model.language,
    info: { Title: model.title, Author: 'wikipedia-market-research', Subject: model.headline, CreationDate: generatedAt },
  });
  doc.registerFont('regular', FONT_FILES.regular);
  doc.registerFont('bold', FONT_FILES.bold);
  return doc;
}

/** Draws a chart scene with its top-left corner at (x, y). */
export function drawScene(doc: Doc, scene: ChartScene, x: number, y: number): void {
  doc.save();
  doc.translate(x, y);
  for (const element of scene.elements) drawElement(doc, element);
  doc.restore();
}

function drawElement(doc: Doc, element: SceneElement): void {
  switch (element.kind) {
    case 'rect':
      doc.rect(element.x, element.y, element.w, element.h).fill(element.fill);
      return;
    case 'line':
    case 'polyline': {
      const points: [number, number][] = element.kind === 'line' ? [[element.x1, element.y1], [element.x2, element.y2]] : element.points;
      const [first, ...rest] = points;
      if (!first) return;
      doc.save().lineWidth(element.width).lineCap('round').lineJoin('round').strokeColor(element.stroke);
      if (element.dash) doc.dash(element.dash[0], { space: element.dash[1] });
      doc.moveTo(first[0], first[1]);
      for (const [px, py] of rest) doc.lineTo(px, py);
      doc.stroke();
      doc.restore();
      return;
    }
    case 'circle':
      doc.save().lineWidth(element.width);
      doc.circle(element.cx, element.cy, element.r);
      if (element.fill && element.stroke) doc.fillAndStroke(element.fill, element.stroke);
      else if (element.fill) doc.fill(element.fill);
      else if (element.stroke) doc.stroke(element.stroke);
      doc.restore();
      return;
    case 'text': {
      doc.font(element.weight).fontSize(element.size).fillColor(element.fill);
      const width = doc.widthOfString(element.text);
      const left = element.anchor === 'start' ? element.x : element.anchor === 'middle' ? element.x - width / 2 : element.x - width;
      doc.text(element.text, left, element.y, { baseline: 'alphabetic', lineBreak: false });
      return;
    }
  }
}

/**
 * One layout routine for both measuring (draw = false) and drawing (draw = true),
 * so the fit check and the rendered page can never disagree.
 */
class Flow {
  y = PAGE.margin;
  readonly #doc: Doc;
  readonly #draw: boolean;
  readonly #scale: number;

  constructor(doc: Doc, draw: boolean, scale: number) {
    this.#doc = doc;
    this.#draw = draw;
    this.#scale = scale;
  }

  size(points: number): number {
    return points * this.#scale;
  }

  space(points: number): void {
    this.y += points * this.#scale;
  }

  text(text: string, options: { size: number; weight?: 'regular' | 'bold'; color?: string; indent?: number; link?: string; gap?: number }): void {
    const doc = this.#doc;
    const indent = options.indent ?? 0;
    const width = CONTENT_WIDTH - indent;
    doc.font(options.weight ?? 'regular').fontSize(this.size(options.size));
    const lineGap = this.size(1.2);
    const height = doc.heightOfString(text, { width, lineGap });
    if (this.#draw) {
      doc.fillColor(options.color ?? INK.primary);
      doc.text(text, PAGE.margin + indent, this.y, { width, lineGap, ...(options.link && { link: options.link, underline: false }) });
    }
    this.y += height + this.size(options.gap ?? 0);
  }

  bullet(text: string, options: { size: number; color?: string }): void {
    if (this.#draw) {
      this.#doc.font('regular').fontSize(this.size(options.size)).fillColor(INK.secondary);
      this.#doc.text('•', PAGE.margin + 2, this.y, { lineBreak: false });
    }
    this.text(text, { ...options, indent: 10 });
  }

  heading(text: string): void {
    this.space(5);
    this.text(text.toUpperCase(), { size: 7.6, weight: 'bold', color: INK.secondary, gap: 2 });
  }

  rule(): void {
    if (this.#draw) this.#doc.save().lineWidth(0.5).strokeColor(INK.grid).moveTo(PAGE.margin, this.y).lineTo(PAGE.width - PAGE.margin, this.y).stroke().restore();
    this.space(4);
  }

  chart(scene: ChartScene): void {
    if (this.#draw) drawScene(this.#doc, scene, PAGE.margin, this.y);
    this.y += scene.height;
  }

  table(table: Table): void {
    const doc = this.#doc;
    // Shrink the table font until all columns fit the content width.
    let size = this.size(7);
    const padding = 8;
    const widthsAt = (fontSize: number) =>
      table.headers.map((header, column) => {
        doc.font('bold').fontSize(fontSize);
        let width = doc.widthOfString(header);
        for (const row of table.rows) {
          const cell = row[column];
          if (!cell) continue;
          doc.font(cell.bold ? 'bold' : 'regular').fontSize(fontSize);
          width = Math.max(width, doc.widthOfString(cell.text));
        }
        return width + padding;
      });
    let widths = widthsAt(size);
    while (widths.reduce((a, b) => a + b, 0) > CONTENT_WIDTH && size > 5) {
      size -= 0.25;
      widths = widthsAt(size);
    }
    const rowHeight = size * 1.55;

    const drawRow = (cells: TableCell[], bold: boolean, color: string) => {
      let x = PAGE.margin;
      cells.forEach((cell, column) => {
        const width = widths[column] as number;
        if (this.#draw) {
          doc.font(bold || cell.bold ? 'bold' : 'regular').fontSize(size).fillColor(color);
          const textWidth = doc.widthOfString(cell.text);
          const left = table.align[column] === 'right' ? x + width - padding / 2 - textWidth : x + (column === 0 ? 0 : padding / 2);
          doc.text(cell.text, left, this.y + size * 0.2, { lineBreak: false });
        }
        x += width;
      });
      this.y += rowHeight;
    };

    drawRow(table.headers.map((text) => ({ text })), true, INK.secondary);
    if (this.#draw) doc.save().lineWidth(0.5).strokeColor(INK.axis).moveTo(PAGE.margin, this.y - 1).lineTo(PAGE.margin + widths.reduce((a, b) => a + b, 0), this.y - 1).stroke().restore();
    for (const row of table.rows) drawRow(row, false, INK.primary);
  }
}

function layout(model: ReportModel, chart: ChartScene, flow: Flow): void {
  const { labels } = model;
  flow.text(model.title, { size: 15, weight: 'bold', gap: 2 });
  flow.text(model.headline, { size: 10, color: INK.primary, gap: 4 });
  flow.rule();
  flow.text(model.meta, { size: 7, color: INK.secondary, gap: 1.5 });
  flow.text(`${labels.articles}:`, { size: 7, weight: 'bold', color: INK.secondary });
  for (const article of model.articles) flow.text(`${article.text} — ${decodeURI(article.url)}`, { size: 7, color: INK.secondary, indent: 8, link: article.url });
  for (const line of model.unavailable) flow.text(line, { size: 7, color: INK.secondary, indent: 8 });
  flow.space(6);
  flow.chart(chart);

  flow.heading(labels.metrics);
  flow.table(model.metrics);
  if (model.comparisons) {
    flow.heading(labels.comparisons);
    flow.table(model.comparisons);
  }

  flow.heading(labels.findings);
  for (const finding of model.findings) {
    flow.bullet(finding.statement, { size: 8.2 });
    flow.text(finding.evidence, { size: 6.4, color: INK.muted, indent: 10, gap: 2 });
  }
  if (model.hypotheses.length > 0) {
    flow.heading(labels.hypotheses);
    for (const hypothesis of model.hypotheses) {
      flow.bullet(hypothesis.hypothesis, { size: 8.2 });
      flow.text(hypothesis.validation, { size: 7, color: INK.secondary, indent: 10, gap: 2 });
    }
  }
  flow.heading(labels.limitations);
  for (const limitation of model.limitations) flow.bullet(limitation, { size: 7.4, color: INK.primary });
  flow.heading(labels.dataQuality);
  for (const line of model.dataQuality) flow.text(line, { size: 6.8, color: INK.secondary });
  flow.space(6);
  flow.rule();
  flow.text(model.footer, { size: 6.2, color: INK.muted });
}

/**
 * Renders the one-page report. Tries progressively more compact layouts; if none fits, throws
 * ReportDoesNotFitError instead of truncating content.
 */
export async function renderReportPdf(
  model: ReportModel,
  chartFor: (layout: Layout) => ChartScene,
  generatedAt: Date,
): Promise<{ pdf: Buffer; layout: Layout; pages: number }> {
  let smallestOverflow = Infinity;
  for (const attempt of LAYOUT_ATTEMPTS) {
    const measureDoc = createDocument(model, generatedAt);
    const chart = chartFor(attempt);
    const measure = new Flow(measureDoc, false, attempt.scale);
    layout(model, chart, measure);
    measureDoc.end();
    const overflow = measure.y - PAGE.bottomLimit;
    if (overflow > 0) {
      smallestOverflow = Math.min(smallestOverflow, overflow);
      continue;
    }

    const doc = createDocument(model, generatedAt);
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });
    layout(model, chart, new Flow(doc, true, attempt.scale));
    const pages = doc.bufferedPageRange().count;
    doc.end();
    await finished;
    if (pages !== 1) throw new Error(`Report layout produced ${pages} pages; expected exactly one.`);
    return { pdf: Buffer.concat(chunks), layout: attempt, pages };
  }
  throw new ReportDoesNotFitError(smallestOverflow);
}
