import type { LoggerContext } from "./types.js";
import { maskSecrets } from "./runninghub/errors.js";

export interface Logger {
  debug(message: string, context?: LoggerContext, detail?: unknown): void;
  info(message: string, context?: LoggerContext, detail?: unknown): void;
  warn(message: string, context?: LoggerContext, detail?: unknown): void;
  error(message: string, context?: LoggerContext, detail?: unknown): void;
}

function prefix(context: LoggerContext = {}): string {
  return [
    context.jobId && `[Job ${context.jobId}]`,
    context.accountId && `[Account ${context.accountId}]`,
    context.remoteTaskId && `[Task ${context.remoteTaskId}]`,
    context.phase && `[${context.phase}]`,
  ].filter(Boolean).join("");
}

function safeDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  const text = maskSecrets(typeof detail === "string" ? detail : JSON.stringify(detail));
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

export class ConsoleLogger implements Logger {
  debug(message: string, context?: LoggerContext, detail?: unknown): void {
    this.write("DEBUG", message, context, detail);
  }
  info(message: string, context?: LoggerContext, detail?: unknown): void {
    this.write("INFO", message, context, detail);
  }
  warn(message: string, context?: LoggerContext, detail?: unknown): void {
    this.write("WARN", message, context, detail);
  }
  error(message: string, context?: LoggerContext, detail?: unknown): void {
    this.write("ERROR", message, context, detail);
  }
  private write(level: string, message: string, context?: LoggerContext, detail?: unknown): void {
    const line = `${new Date().toISOString()} ${level} ${prefix(context)} ${maskSecrets(message)}`.trim();
    const safe = safeDetail(detail);
    if (level === "ERROR") console.error(line, safe ?? "");
    else if (level === "WARN") console.warn(line, safe ?? "");
    else console.log(line, safe ?? "");
  }
}

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
