// src/utils/logger.ts
// 日志工具

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

let globalLogLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

export function createLogger(name: string): Logger {
  const log = (level: LogLevel, message: string, args: unknown[]) => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (levels.indexOf(level) < levels.indexOf(globalLogLevel)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${name}]`;

    switch (level) {
      case 'error':
        console.error(prefix, message, ...args);
        break;
      case 'warn':
        console.warn(prefix, message, ...args);
        break;
      default:
        console.log(prefix, message, ...args);
    }
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, args),
    info: (message: string, ...args: unknown[]) => log('info', message, args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, args),
    error: (message: string, ...args: unknown[]) => log('error', message, args),
  };
}
