import { existsSync } from 'node:fs';
import type { ToolCallRecord, TurnResult } from './agent.ts';

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
  /** Informational checks are reported but do not fail the turn. */
  informational?: boolean;
}

export interface Turn {
  id: string;
  prompt: string;
  checks: (result: TurnResult, state: SessionState) => Check[];
}

export interface Session {
  id: string;
  description: string;
  turns: Turn[];
}

/** Facts carried between turns of one conversation (e.g. the research file from scenario A). */
export interface SessionState {
  researchFiles: string[];
}

function args(call: ToolCallRecord): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function langsOf(call: ToolCallRecord): string[] {
  return String(args(call).langs ?? '')
    .split(',')
    .map((lang) => lang.trim().toLowerCase())
    .filter(Boolean);
}

function data(call: ToolCallRecord): Record<string, unknown> {
  return ((call.result as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
}

const successful = (result: TurnResult, name: string) => result.toolCalls.filter((call) => call.name === name && call.ok);
const called = (result: TurnResult, name: string) => result.toolCalls.some((call) => call.name === name);
const check = (name: string, passed: boolean, detail: string, informational = false): Check => ({ name, passed, detail, ...(informational && { informational }) });

/** Ordered-list markers at the start of a line ("1. ", "## 2) "): structure, not factual numbers. */
const LIST_MARKER = /^(\s*(?:#{1,6}\s*)?(?:[-*]\s+)?)\d{1,2}[.)](?=\s)/gm;

/** Numbers in the answer that do not appear (after rounding) in any tool result of the conversation so far. */
export function ungroundedNumbers(answer: string, toolResults: readonly unknown[]): string[] {
  const known: number[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'number') known.push(Math.abs(value), Math.abs(value) * 100);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  toolResults.forEach(collect);
  const withoutMarkers = answer.replace(LIST_MARKER, '$1');
  const tokens = withoutMarkers.replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, ' ').match(/\d+(?:[.,\u00a0\u202f ]\d+)*/g) ?? [];
  return tokens.filter((raw) => {
    const compact = raw.replace(/[\u00a0\u202f ]/g, '');
    const readings = new Set<number>();
    readings.add(Number(compact.replace(/,/g, '')));
    readings.add(Number(compact.replace(/\./g, '').replace(',', '.')));
    readings.add(Number(compact.replace(',', '.')));
    const decimals = (compact.split(/[.,]/)[1] ?? '').length;
    const values = [...readings].filter(Number.isFinite);
    if (values.some((value) => value >= 2000 && value <= 2100 && Number.isInteger(value))) return false; // years
    return !values.some((value) => known.some((candidate) => Math.abs(Math.round(candidate * 10 ** decimals) / 10 ** decimals - value) < 1e-9 || Math.abs(Math.round(candidate) - value) < 1e-9));
  });
}

// ---------------------------------------------------------------------------
// Interpretation safeguards (heuristics; flagged sentences are shown for manual review)
// ---------------------------------------------------------------------------

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function mentionsPageviewsNotPeople(text: string): boolean {
  return /(not|n't)[^.]{0,80}(people|person|visitor|unique|individual)|(people|unique|individuals)[^.]{0,80}(not|cannot|can't)/i.test(text);
}

const LANGUAGE_NOT_COUNTRY = [
  // "the Polish edition is not a country", "Polish Wikipedia does not equal Poland"
  /(language edition|language version|Polish Wikipedia|Ukrainian Wikipedia|Polish-language|edition)[^.]{0,120}(not|n't)[^.]{0,60}(country|countries|Poland|Ukraine)/i,
  // "country/Poland … cannot be inferred"
  /(country|countries|Poland|geograph)[^.]{0,120}(not|cannot|can't)/i,
  // "languages are not countries"
  /\blanguages?\s+(are|is)\s+not\s+(a\s+)?countr(y|ies)\b/i,
  // "language editions include readers from many countries", "readers live in many countries"
  /(editions?|readers|audience)[^.]{0,60}\b(many|multiple|different|various)\s+countries\b/i,
];

export function mentionsLanguageNotCountry(text: string): boolean {
  return LANGUAGE_NOT_COUNTRY.some((pattern) => pattern.test(text));
}

export function mentionsSizeCaveat(text: string): boolean {
  return /(differ(s|ent)?[^.]{0,20}size|size[^.]{0,40}differ|different(ly)? sized|not directly comparable|editions? (of different|vary in) size)/i.test(text);
}

/** Explicit causal connectives; what follows them is checked against METHODOLOGICAL. */
const CAUSAL_CONNECTIVE = /\b(because of|because|due to|caused by|driven by|as a result of|attributable to|owing to|explained by|resulted from|thanks to|the reason (for|is|was))\b/gi;
/** Interpretive verbs followed by a cause-like noun ("suggesting … accessibility issues"). */
const CAUSAL_INTERPRETATION =
  /\b(suggest|suggests|suggesting|indicate|indicates|indicating|reflect|reflects|reflecting)\b[^.]{0,60}\b(interest|demand|surge|issue|problem|event|news|campaign|shift|popularity|accessib|algorithm|behaviou?r|audience)/i;
/** Causes that describe the analysis itself, not the observed data ("limitations due to unequal period lengths"). */
const METHODOLOGICAL =
  /^\s*(the\s+|an?\s+|its\s+)?(unequal|different|differing)?\s*(period|periods|period lengths?|leap year|coverage|missing (data|units|days|months)|incomplete (data|periods?)|data (quality|gaps)|rounding|methodolog\w*|spikes? (present|in the data)|the (analysis|method|comparison))/i;

function assertsCause(sentence: string): boolean {
  if (CAUSAL_INTERPRETATION.test(sentence)) return true;
  for (const match of sentence.matchAll(CAUSAL_CONNECTIVE)) {
    const following = sentence.slice((match.index ?? 0) + match[0].length);
    if (!METHODOLOGICAL.test(following)) return true;
  }
  return false;
}
const HEDGED = /\b(unknown|not known|unclear|cannot|can't|could|may|might|possibl\w*|hypothes\w*|not (be )?(determined|inferred|attributed)|no (evidence|data))\b/i;

/** Sentences that assert a cause without tool support (not hedged, not framed as unknown or as a hypothesis). */
export function unsupportedCausalClaims(text: string): string[] {
  return sentences(text).filter((sentence) => assertsCause(sentence) && !HEDGED.test(sentence));
}

/** p-values returned by the tools (e.g. trendPValue, trend.pValue). */
function toolPValues(toolResults: readonly unknown[]): number[] {
  const values: number[] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'number' && /pvalue/i.test(key)) values.push(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  toolResults.forEach((result) => walk(result, ''));
  return values;
}

/** "p = 0.021", "p=0.021", "p < 0.05", "p-value 0.021", "trendPValue: 0.021", "pValue: 0.021". */
const P_VALUE = /(?:\btrend\.?p-?value|\bp-?value|\bp)\s*(?:=|<|≤|:|of|is)?\s*(0?[.,](\d+))/gi;

/**
 * Sentences calling something "significant" without statistical support. Supported means:
 * the sentence quotes a p-value below 0.05 that a tool returned, or it is about a trend and an earlier
 * sentence of the same answer already quoted such a p-value. Only trends have a significance test;
 * period comparisons never do, so "significant declines" without a trend p-value stays unsupported.
 */
export function unsupportedSignificance(text: string, toolResults: readonly unknown[]): string[] {
  const pValues = toolPValues(toolResults);
  const valid = (sentence: string) =>
    [...sentence.matchAll(P_VALUE)].some((match) => {
      const value = Number((match[1] ?? '').replace(',', '.'));
      const decimals = (match[2] ?? '').length;
      return value < 0.05 && pValues.some((pValue) => Math.abs(Number(pValue.toFixed(decimals)) - value) < 1e-9);
    });
  let validEarlier = false;
  const flagged: string[] = [];
  for (const sentence of sentences(text)) {
    const quotesValid = valid(sentence);
    const claims = /significan/i.test(sentence) && !/\b(not|no|without|cannot|can't|isn't|aren't)\b[^.]{0,30}significan|insignifican/i.test(sentence);
    if (claims && !quotesValid && !(validEarlier && /\btrend/i.test(sentence))) flagged.push(sentence);
    validEarlier ||= quotesValid;
  }
  return flagged;
}

function safeguardChecks(result: TurnResult, options: { crossLanguage: boolean }): Check[] {
  const toolResults = result.toolCalls.map((call) => call.result);
  const causal = unsupportedCausalClaims(result.answer);
  const significance = unsupportedSignificance(result.answer, toolResults);
  const quote = (list: string[]) => list.map((sentence) => `"${sentence.slice(0, 140)}"`).join(' | ');
  return [
    check('states pageviews are not people', mentionsPageviewsNotPeople(result.answer), 'required limitation'),
    check('states language editions are not countries', mentionsLanguageNotCountry(result.answer), 'required limitation'),
    ...(options.crossLanguage ? [check('size caveat for cross-language comparison', mentionsSizeCaveat(result.answer), 'required when comparing languages')] : []),
    check('no unsupported causal claims', causal.length === 0, causal.length ? `flagged: ${quote(causal)}` : 'none'),
    check('"significant" only with p < 0.05 from tools', significance.length === 0, significance.length ? `flagged: ${quote(significance)}` : 'none'),
  ];
}

export const PING: Session = {
  id: 'ping',
  description: 'Simple tool call: can the configured model call one tool and use its result?',
  turns: [
    {
      id: 'ping',
      prompt: 'Use the resolve tool to look up the topic "Astronomy" in English Wikipedia (lang "en"). Then tell me the exact article title it returned.',
      checks: (result) => {
        const resolves = successful(result, 'resolve');
        const first = result.calls[0];
        const second = result.calls[1];
        return [
          check('first call produced a tool call', (first?.toolCalls ?? 0) > 0 && result.toolCalls[0]?.name === 'resolve', `first call tool calls: ${first?.toolCalls ?? 0}, name: ${result.toolCalls[0]?.name ?? 'none'}`),
          check('arguments passed Zod validation', result.toolCalls.length > 0 && result.toolCalls.every((call) => call.errorCode !== 'INVALID_TOOL_ARGUMENTS'), result.toolCalls.map((call) => call.arguments).join(' | ')),
          check('tool executed successfully', resolves.length > 0, `tool results: ${result.toolCalls.map((call) => (call.ok ? 'ok' : call.errorCode)).join(', ') || 'none'}`),
          check('second call after tool result succeeded', second !== undefined && second.toolCalls === 0 && result.status === 'answered', `second call: ${JSON.stringify(second ?? null)}`),
          check('answer uses the tool result', /Astronomy/.test(result.answer), result.answer.slice(0, 160)),
        ];
      },
    },
  ],
};

export const SHORT: Session = {
  id: 'short',
  description: 'Short live conversation (about 4 model calls): one research question and a context-dependent follow-up.',
  turns: [
    {
      id: 'short-1-research',
      prompt: 'What was the average number of daily pageviews of the Astronomy article in Polish Wikipedia in 2025?',
      checks: (result) => {
        const research = successful(result, 'research');
        const last = research.at(-1);
        return [
          check('research succeeded', research.length > 0, `research calls: ${result.toolCalls.filter((call) => call.name === 'research').map((call) => (call.ok ? 'ok' : call.errorCode)).join(', ') || 'none'}`),
          check('Polish language', last ? langsOf(last).includes('pl') : false, last ? last.arguments : 'none'),
          check('period 2025 only', last ? JSON.stringify(args(last)).includes('2025') && !JSON.stringify(args(last)).includes('2024') : false, last ? last.arguments : 'none'),
          check('answered', result.status === 'answered' && result.answer.trim().length > 0, `status ${result.status}`),
          check('numbers grounded in tool results', true, `ungrounded numbers: ${ungroundedNumbers(result.answer, result.toolCalls.map((call) => call.result)).join(', ') || 'none'}`, true),
        ];
      },
    },
    {
      id: 'short-2-follow-up',
      prompt: 'And in Ukrainian Wikipedia?',
      checks: (result) => {
        const research = successful(result, 'research');
        const last = research.at(-1);
        const text = last ? JSON.stringify(args(last)) : '';
        return [
          check('research succeeded', research.length > 0, `research calls: ${research.length}`),
          check('context kept (astronomy, 2025)', /astronom/i.test(text) && text.includes('2025'), text),
          check('Ukrainian language', last ? langsOf(last).includes('uk') : false, text),
          check('answered', result.status === 'answered' && result.answer.trim().length > 0, `status ${result.status}`),
          check('numbers grounded in tool results', true, `ungrounded numbers: ${ungroundedNumbers(result.answer, result.toolCalls.map((call) => call.result)).join(', ') || 'none'}`, true),
        ];
      },
    },
  ],
};

export const CONVERSATION: Session = {
  id: 'conversation',
  description: 'Scenarios A (research), B (report in Ukrainian), C (follow-up with German, 2025 only), E (data limitations) in one conversation.',
  turns: [
    {
      id: 'A-basic-research',
      prompt: 'Compare interest in astronomy in Ukrainian and Polish Wikipedia during 2024 and 2025. Focus on changes in pageview activity.',
      checks: (result, state) => {
        const research = successful(result, 'research');
        const last = research.at(-1);
        const langs = last ? langsOf(last) : [];
        const compare = String(last ? (args(last).compare ?? '') : '');
        const artifactPath = last ? String(data(last).artifactPath ?? '') : '';
        if (artifactPath) state.researchFiles.push(artifactPath);
        return [
          check('research succeeded', research.length > 0, `research calls: ${result.toolCalls.filter((call) => call.name === 'research').map((call) => (call.ok ? 'ok' : call.errorCode)).join(', ') || 'none'}`),
          check('languages uk and pl', langs.includes('uk') && langs.includes('pl'), `langs: ${langs.join(',')}`),
          check('compares 2024 with 2025', compare.includes('2024') && compare.includes('2025'), `compare: ${compare || '(none)'}`),
          check('no PDF without request', !called(result, 'report'), `report called: ${called(result, 'report')}`),
          check('answered', result.status === 'answered' && result.answer.trim().length > 0, `status ${result.status}`),
          check('numbers grounded in tool results', true, `ungrounded numbers: ${ungroundedNumbers(result.answer, result.toolCalls.map((call) => call.result)).join(', ') || 'none'}`, true),
          ...safeguardChecks(result, { crossLanguage: true }),
        ];
      },
    },
    {
      id: 'B-report-ukrainian',
      prompt: 'Generate a one-page PDF report in Ukrainian based on this research.',
      checks: (result, state) => {
        const reports = result.toolCalls.filter((call) => call.name === 'report');
        const final = reports.at(-1);
        const reportData = final?.ok ? data(final) : {};
        const pdf = String(reportData.reportPath ?? '');
        const svg = String(reportData.chartPath ?? '');
        const usedFile = final ? String(args(final).research_file ?? '') : '';
        return [
          check('report succeeded', final?.ok === true, `report attempts: ${reports.map((call) => (call.ok ? 'ok' : call.errorCode)).join(', ') || 'none'}`),
          check('reused the research file', state.researchFiles.some((file) => usedFile && file.endsWith(usedFile.split('/').pop() ?? '\u0000')), `used: ${usedFile}`),
          check('no new research', !called(result, 'research'), `research called: ${called(result, 'research')}`, true),
          check('Ukrainian conclusions', final ? (args(final).conclusions as { language?: string } | undefined)?.language === 'uk' : false, 'conclusions.language'),
          check('PDF and SVG exist', Boolean(pdf && svg && existsSync(pdf) && existsSync(svg)), `${pdf} | ${svg}`),
          check('validation retries within limit', result.status !== 'report_validation_failed', `failed validations: ${result.reportFailures.length}`),
        ];
      },
    },
    {
      id: 'C-follow-up-german-2025',
      prompt: 'Now include German Wikipedia and compare only 2025.',
      checks: (result, state) => {
        const research = successful(result, 'research');
        const last = research.at(-1);
        const langs = last ? langsOf(last) : [];
        const argumentText = last ? JSON.stringify(args(last)) : '';
        const cache = (last ? data(last).cache : undefined) as { hits?: number } | undefined;
        const artifactPath = last ? String(data(last).artifactPath ?? '') : '';
        if (artifactPath) state.researchFiles.push(artifactPath);
        return [
          check('research called again', research.length > 0, `research calls: ${research.length}`),
          check('topic preserved (astronomy)', /astronom/i.test(argumentText), argumentText),
          check('languages include de, uk, pl', ['de', 'uk', 'pl'].every((lang) => langs.includes(lang)), `langs: ${langs.join(',')}`),
          check('only 2025', argumentText.includes('2025') && !argumentText.includes('2024'), argumentText),
          check('cache reused', (cache?.hits ?? 0) > 0, `cache: ${JSON.stringify(cache ?? null)}`),
          check('no PDF without request', !called(result, 'report'), `report called: ${called(result, 'report')}`),
          check('answered', result.status === 'answered' && result.answer.trim().length > 0, `status ${result.status}`),
          check('numbers grounded in tool results', true, `ungrounded numbers: ${ungroundedNumbers(result.answer, result.toolCalls.map((call) => call.result)).join(', ') || 'none'}`, true),
        ];
      },
    },
    {
      id: 'E-data-limitations',
      prompt: 'How many people in Poland are interested in astronomy based on these statistics?',
      checks: (result) => [
        check('no PDF without request', !called(result, 'report'), `report called: ${called(result, 'report')}`),
        check('answered', result.status === 'answered' && result.answer.trim().length > 0, `status ${result.status}`),
        ...safeguardChecks(result, { crossLanguage: false }),
        check('no people estimate', !/\d[\d\s,.]*\s*(thousand|million)?\s*(people|persons|Poles|residents|users|individuals)\b(?![^.]{0,40}(not|cannot))/i.test(result.answer), 'no "<number> people"', false),
      ],
    },
  ],
};

export const MERCURY: Session = {
  id: 'mercury',
  description: 'Scenario D: ambiguous topic in a fresh conversation.',
  turns: [
    {
      id: 'D-ambiguous-mercury',
      prompt: 'Research Mercury.',
      checks: (result) => {
        const lookups = result.toolCalls.filter((call) => call.name === 'resolve' || call.name === 'research');
        const sawAmbiguity = lookups.some((call) => JSON.stringify(call.result).includes('ambiguous') || JSON.stringify(call.result).includes('AMBIGUOUS_TOPIC'));
        const researchedSpecific = successful(result, 'research').some((call) => /mercury/i.test(JSON.stringify(args(call))));
        return [
          check('looked the topic up', lookups.length > 0, `tool calls: ${result.toolCalls.map((call) => call.name).join(', ') || 'none'}`),
          check('received ambiguity candidates', sawAmbiguity, 'resolve status ambiguous or AMBIGUOUS_TOPIC'),
          check('did not silently pick a meaning', !researchedSpecific, `successful research on a Mercury article: ${researchedSpecific}`),
          check('asks a clarification question', result.answer.includes('?'), result.answer.slice(0, 200)),
          check('offers planet and element', /planet/i.test(result.answer) && /element/i.test(result.answer), 'mentions planet and element'),
        ];
      },
    },
  ],
};

/** Scenario A alone, for controlled re-runs; same turn definition as in CONVERSATION. */
export const SCENARIO_A: Session = {
  id: 'scenario-a',
  description: 'Scenario A (basic research) as a single-turn conversation.',
  turns: [CONVERSATION.turns[0] as Turn],
};

export const SESSIONS = {
  ping: [PING],
  short: [SHORT],
  'scenario-a': [SCENARIO_A],
  conversation: [CONVERSATION],
  mercury: [MERCURY],
  all: [PING, CONVERSATION, MERCURY],
} as const;
