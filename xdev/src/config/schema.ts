// src/config/schema.ts
// 配置 Schema 定义和验证
// 使用原生 TypeScript 类型验证（无需 zod 依赖）

import {
  XdevConfig,
  ModelConfig,
  TimeoutConfig,
  QueueConfig,
  ExpertConfig,
  SecurityConfig,
  LogConfig,
  SessionContextConfig,
  VALID_MODEL_PRESETS,
  VALID_MODEL_PROVIDERS,
} from '../config';

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export interface ValidationWarning {
  path: string;
  message: string;
  suggestion?: string;
}

// ==================== 配置 Schema 定义 ====================

/**
 * 模型配置 Schema
 */
export const ModelConfigSchema = {
  validate: (value: unknown): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!value || typeof value !== 'object') {
      return { valid: false, errors: [{ path: 'model', message: '模型配置必须是一个对象' }], warnings: [] };
    }

    const config = value as Partial<ModelConfig>;

    if (config.provider !== undefined && !VALID_MODEL_PROVIDERS.includes(config.provider)) {
      errors.push({ path: 'model.provider', message: `provider 必须是: ${VALID_MODEL_PROVIDERS.join(', ')}` });
    }

    if (config.preset !== undefined && !VALID_MODEL_PRESETS.includes(config.preset)) {
      errors.push({ path: 'model.preset', message: `preset 必须是: ${VALID_MODEL_PRESETS.join(', ')}` });
    }

    // defaultModel 必须是非空字符串
    if (!config.defaultModel || typeof config.defaultModel !== 'string') {
      errors.push({ path: 'model.defaultModel', message: '默认模型名称不能为空' });
    }

    // fallbackModel 如果存在必须是字符串
    if (config.fallbackModel !== undefined && typeof config.fallbackModel !== 'string') {
      errors.push({ path: 'model.fallbackModel', message: '备用模型名称必须是字符串' });
    }

    // maxTokens 如果存在必须是正整数
    if (config.maxTokens !== undefined) {
      if (typeof config.maxTokens !== 'number' || config.maxTokens <= 0) {
        errors.push({ path: 'model.maxTokens', message: 'maxTokens 必须是正整数' });
      } else if (config.maxTokens > 1000000) {
        warnings.push({ path: 'model.maxTokens', message: 'maxTokens 值非常大', suggestion: '通常不超过 1000000' });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },
};

/**
 * 超时配置 Schema
 */
export const TimeoutConfigSchema = {
  validate: (value: unknown): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!value || typeof value !== 'object') {
      return { valid: false, errors: [{ path: 'timeout', message: '超时配置必须是一个对象' }], warnings: [] };
    }

    const config = value as Partial<TimeoutConfig>;

    // apiTimeout: 1000 - 600000
    if (config.apiTimeout !== undefined) {
      if (typeof config.apiTimeout !== 'number' || config.apiTimeout < 1000) {
        errors.push({ path: 'timeout.apiTimeout', message: 'apiTimeout 必须至少 1000ms' });
      } else if (config.apiTimeout > 600000) {
        warnings.push({ path: 'timeout.apiTimeout', message: 'apiTimeout 超过 10 分钟', suggestion: '考虑使用较短的超时时间' });
      }
    }

    // expertTimeout: 60000 - 7200000
    if (config.expertTimeout !== undefined) {
      if (typeof config.expertTimeout !== 'number' || config.expertTimeout < 60000) {
        errors.push({ path: 'timeout.expertTimeout', message: 'expertTimeout 必须至少 60000ms (1分钟)' });
      } else if (config.expertTimeout > 7200000) {
        warnings.push({ path: 'timeout.expertTimeout', message: 'expertTimeout 超过 2 小时' });
      }
    }

    // queueTimeout: 1000 - 300000
    if (config.queueTimeout !== undefined) {
      if (typeof config.queueTimeout !== 'number' || config.queueTimeout < 1000 || config.queueTimeout > 300000) {
        errors.push({ path: 'timeout.queueTimeout', message: 'queueTimeout 必须在 1000-300000ms 之间' });
      }
    }

    // healthCheckInterval: 10000 - 600000
    if (config.healthCheckInterval !== undefined) {
      if (typeof config.healthCheckInterval !== 'number' || config.healthCheckInterval < 10000) {
        warnings.push({ path: 'timeout.healthCheckInterval', message: 'healthCheckInterval 建议至少 10000ms' });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },
};

/**
 * 队列配置 Schema
 */
export const QueueConfigSchema = {
  validate: (value: unknown): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!value || typeof value !== 'object') {
      return { valid: false, errors: [{ path: 'queue', message: '队列配置必须是一个对象' }], warnings: [] };
    }

    const config = value as Partial<QueueConfig>;

    // maxSize: 1 - 10000
    if (config.maxSize !== undefined) {
      if (typeof config.maxSize !== 'number' || config.maxSize < 1 || config.maxSize > 10000) {
        errors.push({ path: 'queue.maxSize', message: 'maxSize 必须在 1-10000 之间' });
      }
    }

    // fullBehavior: 枚举值
    if (config.fullBehavior !== undefined) {
      const validBehaviors = ['reject', 'drop_oldest', 'drop_newest'];
      if (!validBehaviors.includes(config.fullBehavior)) {
        errors.push({ path: 'queue.fullBehavior', message: `fullBehavior 必须是: ${validBehaviors.join(', ')}` });
      }
    }

    // maxRetries: 0 - 10
    if (config.maxRetries !== undefined) {
      if (typeof config.maxRetries !== 'number' || config.maxRetries < 0 || config.maxRetries > 10) {
        warnings.push({ path: 'queue.maxRetries', message: 'maxRetries 建议在 0-10 之间' });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },
};

/**
 * 会话上下文配置 Schema
 */
export const SessionContextConfigSchema = {
  validate: (value: unknown): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!value || typeof value !== 'object') {
      return { valid: false, errors: [{ path: 'sessionContext', message: '会话上下文配置必须是一个对象' }], warnings: [] };
    }

    const config = value as Partial<SessionContextConfig>;

    // autoCompact: boolean
    if (config.autoCompact !== undefined && typeof config.autoCompact !== 'boolean') {
      errors.push({ path: 'sessionContext.autoCompact', message: 'autoCompact 必须是布尔值' });
    }

    // compactThreshold: 0.05 - 0.5
    if (config.compactThreshold !== undefined) {
      if (typeof config.compactThreshold !== 'number' || config.compactThreshold < 0.05 || config.compactThreshold > 0.5) {
        warnings.push({ path: 'sessionContext.compactThreshold', message: 'compactThreshold 建议在 0.05-0.5 之间' });
      }
    }

    // maxContextTokens: 1000 - 200000
    if (config.maxContextTokens !== undefined) {
      if (typeof config.maxContextTokens !== 'number' || config.maxContextTokens < 1000) {
        errors.push({ path: 'sessionContext.maxContextTokens', message: 'maxContextTokens 必须至少 1000' });
      } else if (config.maxContextTokens > 200000) {
        warnings.push({ path: 'sessionContext.maxContextTokens', message: 'maxContextTokens 超过常见模型上下文窗口' });
      }
    }

    // preserveRecent: 1 - 50
    if (config.preserveRecent !== undefined) {
      if (typeof config.preserveRecent !== 'number' || config.preserveRecent < 1 || config.preserveRecent > 50) {
        warnings.push({ path: 'sessionContext.preserveRecent', message: 'preserveRecent 建议在 1-50 之间' });
      }
    }

    // compactStrategy: 枚举值
    if (config.compactStrategy !== undefined) {
      const validStrategies = ['sliding', 'summary', 'priority'];
      if (!validStrategies.includes(config.compactStrategy)) {
        errors.push({ path: 'sessionContext.compactStrategy', message: `compactStrategy 必须是: ${validStrategies.join(', ')}` });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },
};

// ==================== 完整配置验证 ====================

/**
 * 验证完整配置
 */
export function validateConfig(config: unknown): ValidationResult {
  const allErrors: ValidationError[] = [];
  const allWarnings: ValidationWarning[] = [];

  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      errors: [{ path: '', message: '配置必须是一个对象' }],
      warnings: [],
    };
  }

  const cfg = config as Partial<XdevConfig>;

  // 验证各个子配置
  if (cfg.model) {
    const result = ModelConfigSchema.validate(cfg.model);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (cfg.timeout) {
    const result = TimeoutConfigSchema.validate(cfg.timeout);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (cfg.queue) {
    const result = QueueConfigSchema.validate(cfg.queue);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (cfg.sessionContext) {
    const result = SessionContextConfigSchema.validate(cfg.sessionContext);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * 格式化验证结果为字符串
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push('✅ 配置验证通过');
  } else {
    lines.push('❌ 配置验证失败');
  }

  if (result.errors.length > 0) {
    lines.push('\n错误:');
    for (const error of result.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\n警告:');
    for (const warning of result.warnings) {
      let msg = `  - ${warning.path}: ${warning.message}`;
      if (warning.suggestion) {
        msg += ` (建议: ${warning.suggestion})`;
      }
      lines.push(msg);
    }
  }

  return lines.join('\n');
}
