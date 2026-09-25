import type { Conclusions } from '../schemas/conclusions.ts';

/**
 * Static report labels for the languages the MVP targets. Other languages fall back to English, and the
 * conclusions may override the section headings (`labels`). This is deliberately not a localization framework.
 */
const EN = {
  defaultTitle: 'Wikipedia audience interest report',
  sourceArticle: 'Source article',
  articles: 'Verified articles',
  noArticle: 'no verified article',
  periods: 'Periods',
  daily: 'daily data',
  monthly: 'monthly data',
  generated: 'Generated',
  chartTitle: 'Pageviews over time',
  viewsPerDay: 'Views per day',
  viewsPerMonth: 'Views per month',
  legendGap: 'gap = no data',
  legendInferred: 'inferred zero',
  legendSpike: 'flagged spike',
  legendIncomplete: 'incomplete period',
  noChartData: 'No pageview data to chart.',
  metrics: 'Key metrics',
  language: 'Language',
  period: 'Period',
  total: 'Total views',
  perDay: 'Per day',
  perMonth: 'Per month',
  trend: 'Trend',
  coverage: 'Coverage',
  spikes: 'Spikes',
  comparisons: 'Period comparison',
  versus: 'vs',
  changeTotal: 'Change (total)',
  changePerDay: 'Change (per day)',
  reliability: 'Reliability',
  findings: 'Findings',
  evidence: 'Evidence',
  hypotheses: 'Hypotheses to validate',
  validation: 'How to validate',
  limitations: 'Limitations',
  dataQuality: 'Data quality',
  observed: 'observed',
  inferredZeros: 'inferred zeros',
  missing: 'missing',
  incomplete: 'incomplete',
  beforeCreation: 'before creation',
  warnings: 'Warnings (details in the research file)',
  sources: 'Sources',
  sourceText: 'Wikimedia Pageviews API (agent=user, access=all-access) and MediaWiki API. Research file {id}, methodology v{methodology}, wikipedia-market-research {version}.',
  notAvailable: 'n/a',
  trendLabels: { increasing: 'increasing', decreasing: 'decreasing', stable: 'stable', no_clear_trend: 'no clear trend', insufficient_data: 'insufficient data' },
  statusLabels: { comparable: 'comparable', comparable_with_limitations: 'with limitations', insufficient_data: 'insufficient data' },
  mandatoryLimitations: [
    'Pageviews count visits to a page, not unique people or customers.',
    'A Wikipedia language edition is not a country; its readers live in many countries.',
    'Absolute views are not comparable across language editions of different size.',
    'The statistics describe the selected past periods; they are not forecasts.',
  ],
};

export type Labels = typeof EN;

const UK: Labels = {
  defaultTitle: 'Звіт про інтерес аудиторії у Вікіпедії',
  sourceArticle: 'Вихідна стаття',
  articles: 'Перевірені статті',
  noArticle: 'немає перевіреної статті',
  periods: 'Періоди',
  daily: 'щоденні дані',
  monthly: 'щомісячні дані',
  generated: 'Створено',
  chartTitle: 'Перегляди в часі',
  viewsPerDay: 'Переглядів за день',
  viewsPerMonth: 'Переглядів за місяць',
  legendGap: 'розрив = немає даних',
  legendInferred: 'імовірний нуль',
  legendSpike: 'виявлений сплеск',
  legendIncomplete: 'незавершений період',
  noChartData: 'Немає даних для графіка.',
  metrics: 'Ключові показники',
  language: 'Мова',
  period: 'Період',
  total: 'Усього переглядів',
  perDay: 'За день',
  perMonth: 'За місяць',
  trend: 'Тренд',
  coverage: 'Покриття',
  spikes: 'Сплески',
  comparisons: 'Порівняння періодів',
  versus: 'проти',
  changeTotal: 'Зміна (усього)',
  changePerDay: 'Зміна (за день)',
  reliability: 'Надійність',
  findings: 'Висновки',
  evidence: 'Підстава',
  hypotheses: 'Гіпотези для перевірки',
  validation: 'Як перевірити',
  limitations: 'Обмеження',
  dataQuality: 'Якість даних',
  observed: 'спостережено',
  inferredZeros: 'імовірні нулі',
  missing: 'бракує',
  incomplete: 'незавершено',
  beforeCreation: 'до створення статті',
  warnings: 'Попередження (подробиці у файлі дослідження)',
  sources: 'Джерела',
  sourceText: 'Wikimedia Pageviews API (agent=user, access=all-access) і MediaWiki API. Файл дослідження {id}, методологія v{methodology}, wikipedia-market-research {version}.',
  notAvailable: 'н/д',
  trendLabels: { increasing: 'зростання', decreasing: 'спадання', stable: 'стабільно', no_clear_trend: 'без чіткого тренду', insufficient_data: 'недостатньо даних' },
  statusLabels: { comparable: 'порівнянні', comparable_with_limitations: 'з обмеженнями', insufficient_data: 'недостатньо даних' },
  mandatoryLimitations: [
    'Перегляди сторінки — це відвідування, а не унікальні люди чи клієнти.',
    'Мовний розділ Вікіпедії не дорівнює країні; його читачі живуть у різних країнах.',
    'Абсолютні перегляди не можна порівнювати між мовними розділами різного розміру.',
    'Статистика описує вибрані минулі періоди й не є прогнозом.',
  ],
};

const PL: Labels = {
  defaultTitle: 'Raport zainteresowania odbiorców w Wikipedii',
  sourceArticle: 'Artykuł źródłowy',
  articles: 'Zweryfikowane artykuły',
  noArticle: 'brak zweryfikowanego artykułu',
  periods: 'Okresy',
  daily: 'dane dzienne',
  monthly: 'dane miesięczne',
  generated: 'Wygenerowano',
  chartTitle: 'Odsłony w czasie',
  viewsPerDay: 'Odsłony dziennie',
  viewsPerMonth: 'Odsłony miesięcznie',
  legendGap: 'przerwa = brak danych',
  legendInferred: 'domniemane zero',
  legendSpike: 'wykryty skok',
  legendIncomplete: 'niepełny okres',
  noChartData: 'Brak danych do wykresu.',
  metrics: 'Kluczowe wskaźniki',
  language: 'Język',
  period: 'Okres',
  total: 'Łącznie odsłon',
  perDay: 'Dziennie',
  perMonth: 'Miesięcznie',
  trend: 'Trend',
  coverage: 'Pokrycie',
  spikes: 'Skoki',
  comparisons: 'Porównanie okresów',
  versus: 'wobec',
  changeTotal: 'Zmiana (łącznie)',
  changePerDay: 'Zmiana (dziennie)',
  reliability: 'Wiarygodność',
  findings: 'Wnioski',
  evidence: 'Podstawa',
  hypotheses: 'Hipotezy do weryfikacji',
  validation: 'Jak zweryfikować',
  limitations: 'Ograniczenia',
  dataQuality: 'Jakość danych',
  observed: 'zaobserwowane',
  inferredZeros: 'domniemane zera',
  missing: 'brakujące',
  incomplete: 'niepełne',
  beforeCreation: 'przed utworzeniem',
  warnings: 'Ostrzeżenia (szczegóły w pliku badania)',
  sources: 'Źródła',
  sourceText: 'Wikimedia Pageviews API (agent=user, access=all-access) oraz MediaWiki API. Plik badania {id}, metodologia v{methodology}, wikipedia-market-research {version}.',
  notAvailable: 'b/d',
  trendLabels: { increasing: 'wzrost', decreasing: 'spadek', stable: 'stabilnie', no_clear_trend: 'brak wyraźnego trendu', insufficient_data: 'za mało danych' },
  statusLabels: { comparable: 'porównywalne', comparable_with_limitations: 'z ograniczeniami', insufficient_data: 'za mało danych' },
  mandatoryLimitations: [
    'Odsłony to wizyty na stronie, a nie unikalne osoby ani klienci.',
    'Wersja językowa Wikipedii to nie kraj; jej czytelnicy mieszkają w wielu krajach.',
    'Bezwzględnych odsłon nie można porównywać między wersjami językowymi o różnej wielkości.',
    'Statystyki opisują wybrane okresy z przeszłości i nie są prognozą.',
  ],
};

const BUILT_IN: Record<string, Labels> = { en: EN, uk: UK, pl: PL };

/** Translates a metric label value (trend direction or comparison status); unknown values pass through. */
export function translateLabel(labels: Labels, value: string): string {
  return (labels.trendLabels as Record<string, string>)[value] ?? (labels.statusLabels as Record<string, string>)[value] ?? value;
}

export const BUILT_IN_LABEL_LANGUAGES = Object.keys(BUILT_IN);

/** Labels for the report language: built-in set (by primary subtag) or English, plus heading overrides. */
export function labelsFor(language: string, overrides: Conclusions['labels']): { labels: Labels; builtIn: boolean } {
  const primary = language.toLowerCase().split('-')[0] ?? 'en';
  const base = BUILT_IN[primary];
  const labels: Labels = { ...(base ?? EN) };
  if (overrides?.title) labels.defaultTitle = overrides.title;
  if (overrides?.findings) labels.findings = overrides.findings;
  if (overrides?.hypotheses) labels.hypotheses = overrides.hypotheses;
  if (overrides?.limitations) labels.limitations = overrides.limitations;
  if (overrides?.metrics) labels.metrics = overrides.metrics;
  if (overrides?.dataQuality) labels.dataQuality = overrides.dataQuality;
  return { labels, builtIn: base !== undefined };
}
