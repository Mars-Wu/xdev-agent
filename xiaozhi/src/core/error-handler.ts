// src/core/error-handler.ts
// 错误处理增强 - 分类、重试、降级

import { createLogger } from '../utils/logger';

const logger = createLogger('error-handler');

/**
 * API 错误类型
 */
export enum APIErrorType {
  PROMPT_TOO_LONG = 'prompt_too_long',
  RATE_LIMIT = 'rate_limit',
  SERVER_OVERLOADED = 'server_overloaded',
  CONNECTION_TIMEOUT = 'connection_timeout',
  AUTH_ERROR = 'auth_error',
  NETWORK_ERROR = 'network_error',
  UNKNOWN = 'unknown',
}

/**
 * API 错误
 */
export class APIError extends Error {
  type: APIErrorType;
  retryable: boolean;
  retryAfter?: number;  // 毫秒
  originalError?: Error;

  constructor(
    type: APIErrorType,
    message: string,
    options: {
      retryable?: boolean;
      retryAfter?: number;
      originalError?: Error;
    } = {}
  ) {
    super(message);
    this.type = type;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
    this.originalError = options.originalError;
    this.name = 'APIError';
  }
}

/**
 * 错误处理器配置
 */
export interface ErrorHandlerConfig {
  maxRetries: number;
  baseDelay: number;  // 基础重试延迟（毫秒）
  maxDelay: number;   // 最大重试延迟（毫秒）
  jitterFactor: number;  // 抖动因子 (0-1)
}

const DEFAULT_CONFIG: ErrorHandlerConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 60000,
  jitterFactor: 0.2,
};

/**
 * 错误处理器
 */
export class APIErrorHandler {
  private config: ErrorHandlerConfig;
  private consecutiveErrors: Map<APIErrorType, number> = new Map();

  constructor(config: Partial<ErrorHandlerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 分类错误
   */
  classifyError(error: unknown): APIError {
    if (error instanceof APIError) {
      return error;
    }

    const err = error as Error;
    const message = err.message.toLowerCase();

    // Prompt 太长
    if (
      message.includes('prompt is too long') ||
      message.includes('context_length_exceeded') ||
      message.includes('token limit')
    ) {
      return new APIError(APIErrorType.PROMPT_TOO_LONG, err.message, {
        retryable: true,
        originalError: err,
      });
    }

    // 速率限制
    if (
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('too many requests')
    ) {
      return new APIError(APIErrorType.RATE_LIMIT, err.message, {
        retryable: true,
        retryAfter: 60000,  // 默认等待 1 分钟
        originalError: err,
      });
    }

    // 服务器过载
    if (
      message.includes('server overloaded') ||
      message.includes('529') ||
      message.includes('503') ||
      message.includes('service unavailable')
    ) {
      return new APIError(APIErrorType.SERVER_OVERLOADED, err.message, {
        retryable: true,
        retryAfter: 5000,
        originalError: err,
      });
    }

    // 连接超时
    if (
      message.includes('timeout') ||
      message.includes('etimedout') ||
      message.includes('econnrefused')
    ) {
      return new APIError(APIErrorType.CONNECTION_TIMEOUT, err.message, {
        retryable: true,
        retryAfter: 2000,
        originalError: err,
      });
    }

    // 认证错误
    if (
      message.includes('unauthorized') ||
      message.includes('401') ||
      message.includes('invalid api key') ||
      message.includes('authentication')
    ) {
      return new APIError(APIErrorType.AUTH_ERROR, err.message, {
        retryable: false,
        originalError: err,
      });
    }

    // 网络错误
    if (
      message.includes('network') ||
      message.includes('enotfound') ||
      message.includes('ehostunreach')
    ) {
      return new APIError(APIErrorType.NETWORK_ERROR, err.message, {
        retryable: true,
        retryAfter: 3000,
        originalError: err,
      });
    }

    return new APIError(APIErrorType.UNKNOWN, err.message, {
      retryable: false,
      originalError: err,
    });
  }

  /**
   * 计算重试延迟（带指数退避和抖动）
   */
  calculateDelay(attempt: number, error: APIError): number {
    // 如果错误指定了重试时间，使用它
    if (error.retryAfter) {
      return error.retryAfter;
    }

    // 指数退避
    const delay = Math.min(
      this.config.baseDelay * Math.pow(2, attempt),
      this.config.maxDelay
    );

    // 添加抖动
    const jitter = delay * this.config.jitterFactor * Math.random();

    return Math.floor(delay + jitter);
  }

  /**
   * 检查是否应该重试
   */
  shouldRetry(error: APIError, attempt: number): boolean {
    if (!error.retryable) {
      return false;
    }

    if (attempt >= this.config.maxRetries) {
      return false;
    }

    // 检查连续错误次数
    const consecutive = this.consecutiveErrors.get(error.type) || 0;

    // 服务器过载：连续 3 次后考虑降级
    if (error.type === APIErrorType.SERVER_OVERLOADED && consecutive >= 3) {
      logger.warn('服务器持续过载，建议降级到次级模型');
      return false;
    }

    return true;
  }

  /**
   * 记录错误
   */
  recordError(error: APIError): void {
    const count = this.consecutiveErrors.get(error.type) || 0;
    this.consecutiveErrors.set(error.type, count + 1);
  }

  /**
   * 清除错误记录
   */
  clearErrors(): void {
    this.consecutiveErrors.clear();
  }

  /**
   * 获取错误处理建议
   */
  getAction(error: APIError): 'retry' | 'compact' | 'fallback' | 'abort' {
    switch (error.type) {
      case APIErrorType.PROMPT_TOO_LONG:
        return 'compact';

      case APIErrorType.RATE_LIMIT:
      case APIErrorType.CONNECTION_TIMEOUT:
      case APIErrorType.NETWORK_ERROR:
        return 'retry';

      case APIErrorType.SERVER_OVERLOADED:
        const consecutive = this.consecutiveErrors.get(error.type) || 0;
        return consecutive >= 3 ? 'fallback' : 'retry';

      case APIErrorType.AUTH_ERROR:
      default:
        return 'abort';
    }
  }

  /**
   * 格式化错误信息
   */
  formatError(error: APIError): string {
    const typeNames: Record<APIErrorType, string> = {
      [APIErrorType.PROMPT_TOO_LONG]: '上下文过长',
      [APIErrorType.RATE_LIMIT]: '请求频率限制',
      [APIErrorType.SERVER_OVERLOADED]: '服务器繁忙',
      [APIErrorType.CONNECTION_TIMEOUT]: '连接超时',
      [APIErrorType.AUTH_ERROR]: '认证失败',
      [APIErrorType.NETWORK_ERROR]: '网络错误',
      [APIErrorType.UNKNOWN]: '未知错误',
    };

    let message = `[${typeNames[error.type]}] ${error.message}`;

    if (error.retryable) {
      message += ' (可重试)';
    }

    return message;
  }
}

// 单例
let errorHandler: APIErrorHandler | null = null;

/**
 * 获取错误处理器
 */
export function getErrorHandler(): APIErrorHandler {
  if (!errorHandler) {
    errorHandler = new APIErrorHandler();
  }
  return errorHandler;
}

/**
 * 重置错误处理器
 */
export function resetErrorHandler(): void {
  errorHandler = null;
}
