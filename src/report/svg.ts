import type { ChartScene, SceneElement } from './chart.ts';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const n = (value: number) => Number(value.toFixed(2));

function dash(value: [number, number] | undefined): string {
  return value ? ` stroke-dasharray="${value[0]} ${value[1]}"` : '';
}

function element(item: SceneElement): string {
  switch (item.kind) {
    case 'line':
      return `<line x1="${n(item.x1)}" y1="${n(item.y1)}" x2="${n(item.x2)}" y2="${n(item.y2)}" stroke="${item.stroke}" stroke-width="${item.width}" stroke-linecap="round"${dash(item.dash)}/>`;
    case 'polyline':
      return `<polyline points="${item.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="none" stroke="${item.stroke}" stroke-width="${item.width}" stroke-linejoin="round" stroke-linecap="round"${dash(item.dash)}/>`;
    case 'rect':
      return `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" fill="${item.fill}"/>`;
    case 'circle':
      return `<circle cx="${n(item.cx)}" cy="${n(item.cy)}" r="${item.r}" fill="${item.fill ?? 'none'}" stroke="${item.stroke ?? 'none'}" stroke-width="${item.width}"/>`;
    case 'text':
      return `<text x="${n(item.x)}" y="${n(item.y)}" font-size="${item.size}" font-weight="${item.weight === 'bold' ? 700 : 400}" fill="${item.fill}" text-anchor="${item.anchor}">${escape(item.text)}</text>`;
  }
}

/** Standalone SVG document for the chart (the same scene the PDF draws). */
export function renderSvg(scene: ChartScene): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${escape(scene.title)}" font-family="'Noto Sans', Arial, sans-serif">`,
    `<title>${escape(scene.title)}</title>`,
    ...scene.elements.map(element),
    '</svg>',
    '',
  ].join('\n');
}
