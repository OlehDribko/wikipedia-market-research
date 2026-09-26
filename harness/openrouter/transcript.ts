import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type TranscriptEvent =
  | { kind: 'user'; turn: string; text: string }
  | {
      kind: 'assistant';
      turn: string;
      call: number;
      content: string;
      toolCalls: { name: string; arguments: string }[];
      finishReason: string | null;
      httpStatus?: number;
      servedModel?: string;
      latencyMs?: number;
    }
  | { kind: 'tool'; turn: string; name: string; ok: boolean; errorCode?: string; cliArgs?: string[]; result: unknown }
  | { kind: 'turn_end'; turn: string; status: string; modelCalls: number; toolCalls: string[]; reportAttempts: number; reportFailures: number }
  | { kind: 'error'; turn: string; message: string };

/** Records a harness session. Secrets are replaced before anything is written to disk. */
export class Transcript {
  readonly events: (TranscriptEvent & { at: string })[] = [];
  readonly meta: Record<string, unknown>;
  readonly #secrets: string[];

  constructor(meta: Record<string, unknown>, secrets: string[]) {
    this.meta = meta;
    this.#secrets = secrets.filter((secret) => secret.length >= 8);
  }

  record(event: TranscriptEvent): void {
    this.events.push({ ...event, at: new Date().toISOString() });
  }

  redact(text: string): string {
    return this.#secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  }

  toMarkdown(): string {
    const lines: string[] = ['# OpenRouter harness transcript', ''];
    for (const [key, value] of Object.entries(this.meta)) lines.push(`- **${key}:** ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    let currentTurn = '';
    for (const event of this.events) {
      if (event.turn !== currentTurn) {
        currentTurn = event.turn;
        lines.push('', `## ${currentTurn}`, '');
      }
      switch (event.kind) {
        case 'user':
          lines.push(`**User:** ${event.text}`, '');
          break;
        case 'assistant':
          lines.push(`_Model call ${event.call}: HTTP ${event.httpStatus ?? '?'}, served by \`${event.servedModel ?? '?'}\`, ${event.latencyMs ?? '?'} ms, finish: ${event.finishReason ?? '?'}_`, '');
          if (event.toolCalls.length > 0) {
            for (const call of event.toolCalls) lines.push(`**Model call ${event.call} → tool \`${call.name}\`**`, '', '```json', call.arguments, '```', '');
          }
          if (event.content.trim()) lines.push(`**Assistant (call ${event.call}):**`, '', event.content.trim(), '');
          break;
        case 'tool': {
          const summary = JSON.stringify(event.result);
          lines.push(`Tool \`${event.name}\` → ${event.ok ? 'ok' : `error ${event.errorCode}`}${event.cliArgs ? ` (CLI: \`${event.cliArgs.join(' ')}\`)` : ''}`, '');
          lines.push('<details><summary>result</summary>', '', '```json', summary.length > 6000 ? `${summary.slice(0, 6000)} …(truncated in transcript)` : summary, '```', '</details>', '');
          break;
        }
        case 'turn_end':
          lines.push(
            `> **Turn result:** ${event.status} · model calls: ${event.modelCalls} · tools: ${event.toolCalls.join(', ') || 'none'} · report attempts: ${event.reportAttempts} (failed validations: ${event.reportFailures})`,
            '',
          );
          break;
        case 'error':
          lines.push(`**Error:** ${event.message}`, '');
          break;
      }
    }
    return `${lines.join('\n')}\n`;
  }

  async save(directory: string): Promise<{ json: string; markdown: string }> {
    await mkdir(directory, { recursive: true });
    const json = join(directory, 'transcript.json');
    const markdown = join(directory, 'transcript.md');
    await writeFile(json, `${this.redact(JSON.stringify({ meta: this.meta, events: this.events }, null, 2))}\n`, 'utf8');
    await writeFile(markdown, this.redact(this.toMarkdown()), 'utf8');
    return { json, markdown };
  }
}
