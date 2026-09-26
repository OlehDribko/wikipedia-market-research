import { ModelError, type Message, type ModelClient } from './model.ts';
import { executeTool, type ToolContext } from './tools.ts';
import type { Transcript } from './transcript.ts';

/** Report outcomes that the model can fix by correcting its conclusions. */
const CORRECTABLE_REPORT_ERRORS = new Set(['INVALID_CONCLUSIONS', 'REPORT_DOES_NOT_FIT', 'INVALID_TOOL_ARGUMENTS']);
const MAX_TOOL_RESULT_CHARS = 24_000;

export interface ToolCallRecord {
  name: string;
  arguments: string;
  ok: boolean;
  errorCode?: string;
  result: unknown;
}

export interface ModelCallRecord {
  httpStatus: number | null;
  servedModel: string | null;
  latencyMs: number | null;
  finishReason: string | null;
  toolCalls: number;
}

export interface TurnResult {
  status: 'answered' | 'report_validation_failed' | 'max_model_calls' | 'model_error';
  answer: string;
  modelCalls: number;
  toolCalls: ToolCallRecord[];
  reportAttempts: number;
  reportFailures: { errorCode: string; details: unknown }[];
  calls: ModelCallRecord[];
  error?: string;
}

export function buildSystemPrompt(skillMarkdown: string, today: string): string {
  return [
    'You are a market research assistant. You use the Agent Skill below. Follow its instructions exactly.',
    `Today is ${today} (UTC).`,
    '',
    'In this environment you cannot run shell commands. Each CLI command of the skill is available as a tool instead:',
    '- resolve → `node scripts/wmr.ts resolve` (topic, lang, langs)',
    '- research → `node scripts/wmr.ts research` (article or topic+lang, langs, start/end or compare). Files are saved automatically.',
    '- report → `node scripts/wmr.ts report`. Pass the conclusions object directly; do not write files.',
    '- research_metrics → reads analysis.metrics of a research file. Use it before writing report findings to cite exact metric IDs and values.',
    'Call report only when the user asks for a report, PDF or similar deliverable.',
    'Answer in the language of the user. Use only numbers returned by the tools.',
    '',
    '---- SKILL.md ----',
    skillMarkdown,
  ].join('\n');
}

/** A tool-calling conversation that keeps its full context across user turns. */
export class Agent {
  readonly messages: Message[];
  readonly #model: ModelClient;
  readonly #context: ToolContext;
  readonly #transcript: Transcript;
  readonly #limits: { maxModelCallsPerTurn: number; maxReportAttempts: number };

  constructor(options: {
    model: ModelClient;
    context: ToolContext;
    transcript: Transcript;
    systemPrompt: string;
    limits: { maxModelCallsPerTurn: number; maxReportAttempts: number };
  }) {
    this.#model = options.model;
    this.#context = options.context;
    this.#transcript = options.transcript;
    this.#limits = options.limits;
    this.messages = [{ role: 'system', content: options.systemPrompt }];
  }

  async ask(turn: string, text: string): Promise<TurnResult> {
    const result: TurnResult = { status: 'max_model_calls', answer: '', modelCalls: 0, toolCalls: [], reportAttempts: 0, reportFailures: [], calls: [] };
    this.messages.push({ role: 'user', content: text });
    this.#transcript.record({ kind: 'user', turn, text });

    try {
      while (result.modelCalls < this.#limits.maxModelCallsPerTurn) {
        const reply = await this.#model.complete(this.messages);
        result.modelCalls++;
        result.calls.push({
          httpStatus: reply.httpStatus ?? null,
          servedModel: reply.servedModel ?? null,
          latencyMs: reply.latencyMs ?? null,
          finishReason: reply.finishReason,
          toolCalls: reply.toolCalls.length,
        });
        this.#transcript.record({
          kind: 'assistant',
          turn,
          call: result.modelCalls,
          content: reply.content,
          toolCalls: reply.toolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })),
          finishReason: reply.finishReason,
          ...(reply.httpStatus !== undefined && { httpStatus: reply.httpStatus }),
          ...(reply.servedModel !== undefined && { servedModel: reply.servedModel }),
          ...(reply.latencyMs !== undefined && { latencyMs: reply.latencyMs }),
        });
        this.messages.push({
          role: 'assistant',
          content: reply.content || null,
          ...(reply.toolCalls.length > 0 && {
            toolCalls: reply.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })),
          }),
        });

        if (reply.toolCalls.length === 0) {
          result.status = 'answered';
          result.answer = reply.content;
          break;
        }

        let reportStillInvalid = false;
        for (const call of reply.toolCalls) {
          const outcome = await executeTool(call.name, call.arguments, this.#context);
          result.toolCalls.push({ name: call.name, arguments: call.arguments, ok: outcome.ok, ...(outcome.errorCode && { errorCode: outcome.errorCode }), result: outcome.content });
          this.#transcript.record({
            kind: 'tool',
            turn,
            name: call.name,
            ok: outcome.ok,
            ...(outcome.errorCode && { errorCode: outcome.errorCode }),
            ...(outcome.cliArgs && { cliArgs: outcome.cliArgs }),
            result: outcome.content,
          });
          if (call.name === 'report') {
            result.reportAttempts++;
            reportStillInvalid = !outcome.ok && CORRECTABLE_REPORT_ERRORS.has(outcome.errorCode ?? '');
            if (reportStillInvalid) {
              result.reportFailures.push({ errorCode: outcome.errorCode ?? 'UNKNOWN', details: (outcome.content as { error?: { details?: unknown } }).error?.details ?? null });
            }
          }
          const content = JSON.stringify(outcome.content);
          this.messages.push({ role: 'tool', toolCallId: call.id, content: content.length > MAX_TOOL_RESULT_CHARS ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}…` : content });
        }

        // Explicit retry limit: after N invalid report attempts the turn stops; validation is never bypassed.
        if (reportStillInvalid && result.reportAttempts >= this.#limits.maxReportAttempts) {
          result.status = 'report_validation_failed';
          result.error = `The conclusions were still invalid after ${result.reportAttempts} report attempts.`;
          break;
        }
      }
    } catch (error) {
      result.status = 'model_error';
      result.error = error instanceof ModelError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      this.#transcript.record({ kind: 'error', turn, message: result.error });
    }

    this.#transcript.record({
      kind: 'turn_end',
      turn,
      status: result.status,
      modelCalls: result.modelCalls,
      toolCalls: result.toolCalls.map((call) => `${call.name}${call.ok ? '' : `(${call.errorCode})`}`),
      reportAttempts: result.reportAttempts,
      reportFailures: result.reportFailures.length,
    });
    return result;
  }
}
