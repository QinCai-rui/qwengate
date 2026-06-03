
import { config } from '../services/configService.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): number {
  const logLevel = config.get('LOG_LEVEL', 'info');
  if (logLevel && logLevel in LOG_LEVELS) {
    return LOG_LEVELS[logLevel as LogLevel];
  }
  if (config.get('DEBUG')) return LOG_LEVELS.debug;
  return LOG_LEVELS.info;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  data?: unknown;
}

function formatEntry(entry: LogEntry): string {
  // In production/JSON mode, emit strict JSON lines
  if (config.get('LOG_FORMAT', 'text') === 'json') {
    return JSON.stringify(entry);
  }
  // Human-readable default: [LEVEL] [context] message + optional data
  const ctx = entry.context ? ` [${entry.context}]` : '';
  const ts = entry.timestamp.split('T')[1]?.replace('Z', '') || entry.timestamp;
  const prefix = `[${ts}] [${entry.level.toUpperCase().padEnd(5)}]${ctx}`;
  if (entry.data !== undefined) {
    const dataStr = typeof entry.data === 'string'
      ? entry.data
      : JSON.stringify(entry.data);
    return `${prefix} ${entry.message} ${dataStr}`;
  }
  return `${prefix} ${entry.message}`;
}

function writeEntry(entry: LogEntry): void {
  const minLevel = getMinLevel();
  if (LOG_LEVELS[entry.level] < minLevel) return;

  const formatted = formatEntry(entry);
  if (entry.level === 'error' || entry.level === 'warn') {
    process.stderr.write(formatted + '\n');
  } else {
    process.stdout.write(formatted + '\n');
  }
}

export function createLogger(context: string) {
  return {
    debug(message: string, data?: unknown): void {
      writeEntry({ timestamp: new Date().toISOString(), level: 'debug', message, context, data });
    },
    info(message: string, data?: unknown): void {
      writeEntry({ timestamp: new Date().toISOString(), level: 'info', message, context, data });
    },
    warn(message: string, data?: unknown): void {
      writeEntry({ timestamp: new Date().toISOString(), level: 'warn', message, context, data });
    },
    error(message: string, data?: unknown): void {
      writeEntry({ timestamp: new Date().toISOString(), level: 'error', message, context, data });
    },
  };
}

// Default logger for quick usage
export const logger = createLogger('app');
