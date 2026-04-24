// src/utils/logger.ts
// 日志工具 - 支持请求追踪、动态日志级别、格式化输出

import * as crypto from 'crypto';
import { redactSecrets } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  traceId?: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  withTraceId(traceId: string): Logger;
  withData(data: Record<string, unknown>): Logger;
}

// 日志级别优先级
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isLogLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && LOG_LEVELS.includes(value as LogLevel);
}

function resolveInitialLogLevel(): LogLevel {
  const requested = process.env.XDEV_LOG_LEVEL || process.env.LOG_LEVEL;
  return isLogLevel(requested) ? requested : 'info';
}

// 全局配置
let globalLogLevel: LogLevel = resolveInitialLogLevel();
let globalTraceId: string | undefined;

/**
 * 设置全局日志级别
 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
  return globalLogLevel;
}

/**
 * 设置全局追踪 ID
 */
export function setGlobalTraceId(traceId: string | undefined): void {
  globalTraceId = traceId;
}

/**
 * 获取全局追踪 ID
 */
export function getGlobalTraceId(): string | undefined {
  return globalTraceId;
}

/**
 * 生成新的追踪 ID
 */
export function generateTraceId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 创建追踪上下文
 */
export function withTraceContext<T>(fn: (traceId: string) => T): T {
  const traceId = generateTraceId();
  const previousTraceId = globalTraceId;
  try {
    globalTraceId = traceId;
    return fn(traceId);
  } finally {
    globalTraceId = previousTraceId;
  }
}

/**
 * 格式化日志参数
 */
function formatArgs(args: unknown[]): { data?: Record<string, unknown>; error?: Error } {
  const result: { data?: Record<string, unknown>; error?: Error } = {};

  for (const arg of args) {
    if (arg instanceof Error) {
      result.error = arg;
    } else if (typeof arg === 'object' && arg !== null) {
      result.data = { ...result.data, ...arg as Record<string, unknown> };
    } else if (arg !== undefined) {
      result.data = { ...result.data, value: arg };
    }
  }

  return result;
}

/**
 * 格式化日志输出
 */
function formatOutput(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase().padEnd(5)}]`,
    `[${entry.module}]`,
  ];

  if (entry.traceId) {
    parts.push(`[${entry.traceId}]`);
  }

  parts.push(entry.message);

  if (entry.data && Object.keys(entry.data).length > 0) {
    parts.push(JSON.stringify(entry.data));
  }

  if (entry.error) {
    parts.push(`\n  Error: ${entry.error.name}: ${entry.error.message}`);
    if (entry.error.stack) {
      parts.push(`\n  ${entry.error.stack.split('\n').slice(1, 4).join('\n  ')}`);
    }
  }

  return parts.join(' ');
}

/**
 * 创建日志记录器
 */
export function createLogger(name: string, options?: { traceId?: string; data?: Record<string, unknown> }): Logger {
  const contextTraceId = options?.traceId;
  const contextData = options?.data;

  const log = (level: LogLevel, message: string, args: unknown[]) => {
    // 检查日志级别
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(globalLogLevel)) {
      return;
    }

    // 格式化参数
    const { data: argsData, error } = formatArgs(args);

    // 构建日志条目
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: name,
      message,
    };

    // 添加追踪 ID
    const traceId = contextTraceId || globalTraceId;
    if (traceId) {
      entry.traceId = traceId;
    }

    // 合并数据
    const mergedData = { ...contextData, ...argsData };
    if (Object.keys(mergedData).length > 0) {
      entry.data = mergedData;
    }

    // 添加错误信息
    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    // 输出日志（T4: 脱敏处理）
    const output = redactSecrets(formatOutput(entry));

    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  };

  const baseLogger: Logger = {
    debug: (message: string, ...args: unknown[]) => log('debug', message, args),
    info: (message: string, ...args: unknown[]) => log('info', message, args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, args),
    error: (message: string, ...args: unknown[]) => log('error', message, args),
    withTraceId: (traceId: string) => createLogger(name, { traceId, data: contextData }),
    withData: (data: Record<string, unknown>) => createLogger(name, { traceId: contextTraceId, data: { ...contextData, ...data } }),
  };

  return baseLogger;
}

/**
 * 模块日志级别覆盖
 */
const moduleLogLevels: Map<string, LogLevel> = new Map();

/**
 * 设置模块日志级别
 */
export function setModuleLogLevel(moduleName: string, level: LogLevel): void {
  moduleLogLevels.set(moduleName, level);
}

/**
 * 获取模块日志级别
 */
export function getModuleLogLevel(moduleName: string): LogLevel | undefined {
  return moduleLogLevels.get(moduleName);
}

/**
 * 创建支持模块级别日志覆盖的记录器
 */
export function createModuleLogger(name: string): Logger {
  const baseLogger = createLogger(name);

  // 包装日志方法以支持模块级别覆盖
  const wrapLog = (level: LogLevel, originalFn: (message: string, ...args: unknown[]) => void) => {
    return (message: string, ...args: unknown[]) => {
      const moduleLevel = moduleLogLevels.get(name);
      const effectiveLevel = moduleLevel || globalLogLevel;

      if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(effectiveLevel)) {
        originalFn(message, ...args);
      }
    };
  };

  return {
    debug: wrapLog('debug', baseLogger.debug.bind(baseLogger)),
    info: wrapLog('info', baseLogger.info.bind(baseLogger)),
    warn: wrapLog('warn', baseLogger.warn.bind(baseLogger)),
    error: wrapLog('error', baseLogger.error.bind(baseLogger)),
    withTraceId: baseLogger.withTraceId.bind(baseLogger),
    withData: baseLogger.withData.bind(baseLogger),
  };
}
