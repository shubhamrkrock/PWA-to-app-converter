/**
 * Build log: every line is redacted (known secret values plus token shapes) before it is kept or
 * sent, and lines are batched to the reporter. Logs carry stage and time (PRD §10.3).
 */

import { redactLine } from '@git2app/shared';

export type LogSink = (chunk: string) => Promise<void>;

export class Logger {
  private secrets: string[] = [];
  private buf: string[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly sink: LogSink;
  private readonly echo: boolean;
  stage = 'INIT';

  constructor(sink: LogSink, opts: { echo?: boolean; flushMs?: number } = {}) {
    this.sink = sink;
    this.echo = opts.echo ?? true;
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 2000);
    this.timer.unref?.();
  }

  /** Register a value that must never appear in logs (tokens, passwords, keys). */
  addSecret(v: string | null | undefined): void {
    if (!v || v.length < 4) return;
    this.secrets.push(v);
    // base64 forms of short secrets also leak easily in tool output
    try {
      this.secrets.push(Buffer.from(v).toString('base64'));
    } catch {}
    this.secrets.sort((a, b) => b.length - a.length); // longest first
  }

  line(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      if (raw === '') continue;
      const l = `${new Date().toISOString()} [${this.stage}] ${redactLine(raw, this.secrets)}`;
      if (this.echo) process.stdout.write(l + '\n');
      this.buf.push(l);
      this.bytes += l.length + 1;
    }
    if (this.bytes > 200_000) void this.flush();
  }

  flush(): Promise<void> {
    if (!this.buf.length) return this.flushing;
    const chunk = this.buf.join('\n') + '\n';
    this.buf = [];
    this.bytes = 0;
    this.flushing = this.flushing.then(() => this.sink(chunk).catch(() => {}));
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
