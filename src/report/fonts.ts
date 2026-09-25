import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

/** Noto Sans (SIL OFL 1.1, see assets/fonts/OFL.txt): Latin incl. Polish, Cyrillic incl. Ukrainian, Greek. */
export const FONT_FILES = {
  regular: fileURLToPath(new URL('../../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
  bold: fileURLToPath(new URL('../../assets/fonts/NotoSans-Bold.ttf', import.meta.url)),
} as const;

export type FontWeight = keyof typeof FONT_FILES;

let loaded: Record<FontWeight, fontkit.Font> | null = null;

function fonts(): Record<FontWeight, fontkit.Font> {
  if (!loaded) {
    const open = (path: string): fontkit.Font => {
      const font = fontkit.openSync(path);
      if ('fonts' in font) throw new Error(`${path} is a font collection, expected a single font.`);
      return font;
    };
    loaded = { regular: open(FONT_FILES.regular), bold: open(FONT_FILES.bold) };
  }
  return loaded;
}

/** Advance width of `text` in points at `size`, using the same font the PDF embeds. */
export function textWidth(text: string, size: number, weight: FontWeight = 'regular'): number {
  const font = fonts()[weight];
  return (font.layout(text).advanceWidth / font.unitsPerEm) * size;
}

/** Characters the report fonts cannot draw (they would render as empty boxes). */
export function unsupportedCharacters(text: string): string[] {
  const { regular, bold } = fonts();
  const missing = new Set<string>();
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint === 0x0a) continue;
    if (!regular.hasGlyphForCodePoint(codePoint) || !bold.hasGlyphForCodePoint(codePoint)) missing.add(character);
  }
  return [...missing];
}
