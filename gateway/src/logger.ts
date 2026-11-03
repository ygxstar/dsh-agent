import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** 令牌只记哈希，收货码只记前缀（backend-design §9） */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function codePrefix(code: string): string {
  return code.slice(0, 4) + '***';
}

export function createLogger(minLevel: LogLevel = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}
