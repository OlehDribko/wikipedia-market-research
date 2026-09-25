import type { MetricEntry } from '../schemas/analysis.ts';

/** Locale-aware number formatting for report text. */
export class NumberFormatter {
  readonly #integer: Intl.NumberFormat;
  readonly #decimal: Intl.NumberFormat;
  readonly #signedPercent: Intl.NumberFormat;
  readonly #percent: Intl.NumberFormat;

  constructor(language: string) {
    const locale = NumberFormatter.#safeLocale(language);
    this.#integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    this.#decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    this.#signedPercent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2, signDisplay: 'exceptZero' });
    this.#percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  }

  static #safeLocale(language: string): string {
    try {
      return Intl.NumberFormat.supportedLocalesOf([language]).length > 0 ? language : 'en';
    } catch {
      return 'en';
    }
  }

  integer(value: number): string {
    return this.#integer.format(value);
  }

  decimal(value: number): string {
    return this.#decimal.format(value);
  }

  /** 12.5 → "+12.5%" (value already in percent). */
  signedPercent(value: number): string {
    return this.#signedPercent.format(value / 100);
  }

  /** 0.184 → "18.4%" (value is a ratio). */
  ratio(value: number): string {
    return this.#percent.format(value);
  }

  /** 0.02098 → "0,02098" in uk; p-values keep up to 6 decimals. */
  pValue(value: number): string {
    return new Intl.NumberFormat(this.#integer.resolvedOptions().locale, { maximumFractionDigits: 6 }).format(value);
  }

  /** Formats a metric for display; label values (trend directions, statuses) are translated via `translate`. */
  metric(entry: MetricEntry, notAvailable: string, translate: (label: string) => string = (label) => label): string {
    const { value, unit } = entry;
    if (value === null) return notAvailable;
    if (typeof value === 'string') return translate(value);
    switch (unit) {
      case 'percent':
        return this.signedPercent(value);
      case 'ratio':
        return this.ratio(value);
      case 'views':
      case 'count':
      case 'days':
        return this.integer(value);
      case 'p_value':
        return this.pValue(value);
      default:
        return this.decimal(value);
    }
  }
}
