// src/utils/errors.ts
// 统一错误处理模块

import { createLogger } from './logger';

const logger = createLogger('errors');

/**
 * 错误代码枚举
 */
export enum ErrorCode {
  // 系统级错误 (1xxx)
  INTERNAL_ERROR = 'ERR_1000',
  CONFIG_ERROR = 'ERR_1001',
  DATABASE_ERROR = 'ERR_1002',
  FILE_SYSTEM_ERROR = 'ERR_1003',

  // 消息处理错误 (2xxx)
  MESSAGE_QUEUE_FULL = 'ERR_2000',
  MESSAGE_PROCESSING_FAILED = 'ERR_2001',
  MESSAGE_TIMEOUT = 'ERR_2002',
  MESSAGE_INVALID = 'ERR_2003',

  // 专家系统错误 (3xxx)
  EXPERT_NOT_FOUND = 'ERR_3000',
  EXPERT_BUSY = 'ERR_3001',
  EXPERT_SPAWN_FAILED = 'ERR_3002',
  EXPERT_TIMEOUT = 'ERR_3003',
  EXPERT_RECURSION_DENIED = 'ERR_3004',
  EXPERT_INVALID_WORKDIR = 'ERR_3005',

  // API 错误 (4xxx)
  API_UNAUTHORIZED = 'ERR_4000',
  API_INVALID_REQUEST = 'ERR_4001',
  API_NOT_FOUND = 'ERR_4002',
  API_RATE_LIMITED = 'ERR_4003',

  // Agent / model runtime errors (5xxx)
  AGENT_SPAWN_FAILED = 'ERR_5000',
  AGENT_TIMEOUT = 'ERR_5001',
  AGENT_RESPONSE_ERROR = 'ERR_5002',
  AGENT_SESSION_ERROR = 'ERR_5003',

  // 飞书错误 (6xxx)
  FEISHU_SEND_FAILED = 'ERR_6000',
  FEISHU_CONNECTION_ERROR = 'ERR_6001',
}

/**
 * 错误严重级别
 */
export enum ErrorSeverity {
  LOW = 'low',       // 可忽略，不影响功能
  MEDIUM = 'medium', // 需要关注，但不影响主流程
  HIGH = 'high',     // 严重错误，影响功能
  CRITICAL = 'critical', // 致命错误，需要立即处理
}

/**
 * 应用错误基类
 */
export class AppError extends Error {
  code: ErrorCode;
  severity: ErrorSeverity;
  details?: Record<string, unknown>;
  cause?: Error;
  timestamp: Date;
  recoverable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      details?: Record<string, unknown>;
      cause?: Error;
      recoverable?: boolean;
    }
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.severity = options?.severity ?? ErrorSeverity.MEDIUM;
    this.details = options?.details;
    this.cause = options?.cause;
    this.timestamp = new Date();
    this.recoverable = options?.recoverable ?? true;

    // 保持正确的堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * 转换为 JSON 格式（用于日志和 API 响应）
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      details: this.details,
      cause: this.cause?.message,
      timestamp: this.timestamp.toISOString(),
      recoverable: this.recoverable,
    };
  }

  /**
   * 获取用户友好的错误消息
   */
  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.MESSAGE_QUEUE_FULL:
        return '系统繁忙，请稍后重试';
      case ErrorCode.MESSAGE_TIMEOUT:
        return '请求超时，请重试';
      case ErrorCode.EXPERT_NOT_FOUND:
        return '找不到指定的专家';
      case ErrorCode.EXPERT_BUSY:
        return '专家正在处理其他任务';
      case ErrorCode.API_UNAUTHORIZED:
        return '认证失败';
      case ErrorCode.FEISHU_SEND_FAILED:
        return '发送消息失败';
      default:
        return '操作失败，请稍后重试';
    }
  }
}

/**
 * 消息队列错误
 */
export class QueueError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(code, message, { ...options, recoverable: true });
    this.name = 'QueueError';
  }
}

/**
 * 专家系统错误
 */
export class ExpertError extends AppError {
  expertName?: string;
  sessionId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      details?: Record<string, unknown>;
      cause?: Error;
      expertName?: string;
      sessionId?: string;
    }
  ) {
    super(code, message, options);
    this.name = 'ExpertError';
    this.expertName = options?.expertName;
    this.sessionId = options?.sessionId;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      expertName: this.expertName,
      sessionId: this.sessionId,
    };
  }
}

/**
 * API 错误
 */
export class ApiError extends AppError {
  statusCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    options?: {
      severity?: ErrorSeverity;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(code, message, { ...options, recoverable: statusCode < 500 });
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      statusCode: this.statusCode,
    };
  }
}

/**
 * 错误处理器
 */
export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorCounts: Map<ErrorCode, number> = new Map();
  private lastErrors: AppError[] = [];
  private maxLastErrors = 100;

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  /**
   * 处理错误
   */
  handle(error: unknown, context?: string): AppError {
    let appError: AppError;

    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof Error) {
      appError = new AppError(
        ErrorCode.INTERNAL_ERROR,
        error.message,
        { cause: error, severity: ErrorSeverity.HIGH }
      );
    } else {
      appError = new AppError(
        ErrorCode.INTERNAL_ERROR,
        String(error),
        { severity: ErrorSeverity.HIGH }
      );
    }

    // 记录错误统计
    this.recordError(appError);

    // 根据严重级别记录日志
    this.logError(appError, context);

    return appError;
  }

  /**
   * 记录错误统计
   */
  private recordError(error: AppError): void {
    const count = this.errorCounts.get(error.code) || 0;
    this.errorCounts.set(error.code, count + 1);

    // 保存最近的错误
    this.lastErrors.push(error);
    if (this.lastErrors.length > this.maxLastErrors) {
      this.lastErrors.shift();
    }
  }

  /**
   * 记录日志
   */
  private logError(error: AppError, context?: string): void {
    const contextStr = context ? `[${context}] ` : '';
    const errorInfo = error.toJSON();

    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        logger.error(`${contextStr}CRITICAL: ${error.message}`, errorInfo);
        break;
      case ErrorSeverity.HIGH:
        logger.error(`${contextStr}${error.message}`, errorInfo);
        break;
      case ErrorSeverity.MEDIUM:
        logger.warn(`${contextStr}${error.message}`, errorInfo);
        break;
      case ErrorSeverity.LOW:
        logger.debug(`${contextStr}${error.message}`, errorInfo);
        break;
    }
  }

  /**
   * 获取错误统计
   */
  getErrorStats(): Map<ErrorCode, number> {
    return new Map(this.errorCounts);
  }

  /**
   * 获取最近的错误
   */
  getLastErrors(count: number = 10): AppError[] {
    return this.lastErrors.slice(-count);
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.errorCounts.clear();
    this.lastErrors = [];
  }

  /**
   * 判断是否应该重试
   */
  shouldRetry(error: AppError, attemptCount: number, maxRetries: number = 3): boolean {
    if (attemptCount >= maxRetries) {
      return false;
    }

    // 不可恢复的错误不重试
    if (!error.recoverable) {
      return false;
    }

    // 根据错误代码判断
    const retryableCodes = [
      ErrorCode.MESSAGE_TIMEOUT,
      ErrorCode.AGENT_TIMEOUT,
      ErrorCode.EXPERT_TIMEOUT,
      ErrorCode.FEISHU_SEND_FAILED,
      ErrorCode.FEISHU_CONNECTION_ERROR,
    ];

    return retryableCodes.includes(error.code);
  }

  /**
   * 计算重试延迟（指数退避）
   */
  getRetryDelay(attemptCount: number, baseDelay: number = 1000, maxDelay: number = 30000): number {
    const delay = Math.min(baseDelay * Math.pow(2, attemptCount), maxDelay);
    // 添加抖动
    return delay + Math.random() * delay * 0.1;
  }
}

// 导出单例
export const errorHandler = ErrorHandler.getInstance();

/**
 * 辅助函数：包装异步函数以处理错误
 */
export function withErrorHandler<T>(
  fn: () => Promise<T>,
  context?: string
): Promise<T | AppError> {
  return fn().catch((error) => errorHandler.handle(error, context));
}

/**
 * 辅助函数：重试包装器
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelay?: number;
    context?: string;
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;
  let lastError: AppError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = errorHandler.handle(error, options?.context);

      if (!errorHandler.shouldRetry(lastError, attempt, maxRetries)) {
        throw lastError;
      }

      const delay = errorHandler.getRetryDelay(attempt, baseDelay);
      logger.debug(`重试 ${attempt + 1}/${maxRetries}，等待 ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
