import { readFileSync } from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Conclusions } from '../../src/schemas/conclusions.ts';
import { ResearchArtifactSchema, type ResearchArtifact } from '../../src/schemas/research.ts';

/** Real research result: Astronomy (uk, pl), 2024 vs 2025, fetched from Wikimedia on 2026-09-25. */
export const REAL_ARTIFACT_PATH = new URL('../fixtures/research-astronomy-uk-pl-2024-vs-2025.json', import.meta.url);

export function realArtifact(): ResearchArtifact {
  return ResearchArtifactSchema.parse(JSON.parse(readFileSync(REAL_ARTIFACT_PATH, 'utf8')));
}

/** Conclusions that only use numbers and IDs present in the real artifact. */
export function ukrainianConclusions(): Conclusions {
  return {
    language: 'uk',
    headline: 'Інтерес до астрономії у Вікіпедії у 2025 році знизився порівняно з 2024 роком',
    findings: [
      {
        statement: 'В українському розділі перегляди за день впали з 69,6 до 28,02 (−59,74 %).',
        evidence: ['uk.compare-1.averageDaily', 'uk.compare-2.averageDaily', 'uk.compare-1_vs_compare-2.averageDailyPercentChange'],
      },
      { statement: 'Польський розділ: −24,2 % переглядів за день.', evidence: ['pl.compare-1_vs_compare-2.averageDailyPercentChange'] },
    ],
    hypotheses: [{ hypothesis: 'Аудиторія шукає астрономію поза Вікіпедією.', validationIdea: 'Опитати 15–20 потенційних користувачів.' }],
    limitations: ['Одна стаття на мовний розділ; суміжні статті не враховано.'],
  };
}

export function polishConclusions(): Conclusions {
  return {
    language: 'pl',
    headline: 'Zainteresowanie astronomią w Wikipedii spadło w 2025 roku',
    findings: [
      {
        statement: 'W polskiej Wikipedii dzienna liczba odsłon spadła o 24,2 % (z 73,59 do 55,79).',
        evidence: ['pl.compare-1_vs_compare-2.averageDailyPercentChange', 'pl.compare-1.averageDaily', 'pl.compare-2.averageDaily'],
      },
    ],
    hypotheses: [],
    limitations: ['Zażółć gęślą jaźń: jeden artykuł na wersję językową.'],
  };
}

export async function pdfText(pdf: Uint8Array): Promise<{ pages: number; text: string }> {
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(document, { mergePages: true });
  return { pages: totalPages, text };
}
