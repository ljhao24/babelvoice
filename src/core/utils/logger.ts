/**
 * Lightweight logger facade. Main process replaces `sink` with electron-log;
 * renderer falls back to console.
 */
export interface LogSink {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

let sink: LogSink = console;

export const setLogSink = (newSink: LogSink): void => {
  sink = newSink;
};

export const log = {
  info: (...args: unknown[]) => sink.info(...args),
  warn: (...args: unknown[]) => sink.warn(...args),
  error: (...args: unknown[]) => sink.error(...args),
  debug: (...args: unknown[]) => sink.debug(...args)
};
