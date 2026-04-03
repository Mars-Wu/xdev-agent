// src/core/retry.ts
// 重试工具

import { createLogger } from '../utils/logger';
import { APIError, APIErrorHandler, getErrorHandler } from './error-handler';

const logger = createLogger('retry');

/**
 * 重试选项
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  onRetry?: (attempt: number, error: APIError) => void;
  onGiveUp?: (error: APIError) => void;
}

/**
 * 带重试的异步操作
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const errorHandler = getErrorHandler();
  const maxRetries = options.maxRetries ?? 3;
  let lastError: APIError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      // 成功后清除错误记录
      errorHandler.clearErrors();
      return result;
    } catch (error) {
      const apiError = errorHandler.classifyError(error);
      lastError = apiError;

      errorHandler.recordError(apiError);

      // 检查是否应该重试
      if (!errorHandler.shouldRetry(apiError, attempt)) {
        logger.error(`操作失败，不再重试: ${errorHandler.formatError(apiError)}`);
        options.onGiveUp?.(apiError);
        throw apiError;
      }

      // 计算延迟
      const delay = errorHandler.calculateDelay(attempt, apiError);

      logger.warn(
        `操作失败，${delay}ms 后重试 (第 ${attempt + 1}/${maxRetries} 次): ${errorHandler.formatError(apiError)}`
      );

      options.onRetry?.(attempt + 1, apiError);

      // 等待
      await sleep(delay);
    }
  }

  throw lastError || new Error('重试次数耗尽');
}

/**
 * 睡眠
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的异步操作
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string = '操作超时'
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${message} (${timeoutMs}ms)`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * 带超时和重试的异步操作
 */
export async function withTimeoutAndRetry<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  retryOptions?: RetryOptions
): Promise<T> {
  return withRetry(
    () => withTimeout(operation(), timeoutMs),
    retryOptions
  );
}
