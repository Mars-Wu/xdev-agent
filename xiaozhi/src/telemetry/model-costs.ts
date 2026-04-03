// src/telemetry/model-costs.ts
// 模型成本配置

/**
 * 模型成本配置（每百万 tokens，单位：元）
 */
export interface ModelCost {
  /** 模型 ID */
  id: string;
  /** 模型名称 */
  name: string;
  /** 提供商 */
  provider: string;
  /** 输入成本（元/MTok） */
  inputCostPerMTok: number;
  /** 输出成本（元/MTok） */
  outputCostPerMTok: number;
  /** 缓存读取成本（元/MTok，可选） */
  cacheReadCostPerMTok?: number;
  /** 缓存写入成本（元/MTok，可选） */
  cacheWriteCostPerMTok?: number;
  /** 上下文窗口 */
  contextWindow: number;
  /** 最大输出 */
  maxOutput: number;
}

/**
 * 模型成本配置表
 */
export const MODEL_COSTS: Record<string, ModelCost> = {
  // 智谱 GLM 系列
  'glm-5': {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'zhipu',
    inputCostPerMTok: 1,    // 智谱编程计划
    outputCostPerMTok: 1,
    contextWindow: 200_000,
    maxOutput: 128_000,
  },
  'glm-5-turbo': {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'zhipu',
    inputCostPerMTok: 1,
    outputCostPerMTok: 1,
    contextWindow: 200_000,
    maxOutput: 128_000,
  },

  // Claude 系列（参考价格）
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    inputCostPerMTok: 75,
    outputCostPerMTok: 300,
    cacheReadCostPerMTok: 7.5,
    cacheWriteCostPerMTok: 100,
    contextWindow: 200_000,
    maxOutput: 32_000,
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    inputCostPerMTok: 15,
    outputCostPerMTok: 75,
    cacheReadCostPerMTok: 1.5,
    cacheWriteCostPerMTok: 20,
    contextWindow: 200_000,
    maxOutput: 32_000,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    inputCostPerMTok: 4,
    outputCostPerMTok: 20,
    cacheReadCostPerMTok: 0.4,
    cacheWriteCostPerMTok: 5,
    contextWindow: 200_000,
    maxOutput: 32_000,
  },
};

/**
 * 获取模型成本配置
 */
export function getModelCost(modelId: string): ModelCost | undefined {
  return MODEL_COSTS[modelId];
}

/**
 * 获取所有模型成本配置
 */
export function getAllModelCosts(): ModelCost[] {
  return Object.values(MODEL_COSTS);
}

/**
 * 计算成本
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const cost = getModelCost(modelId);
  if (!cost) {
    // 使用默认成本（GLM-5）
    return (inputTokens + outputTokens) / 1_000_000;
  }

  const inputCost = (inputTokens / 1_000_000) * cost.inputCostPerMTok;
  const outputCost = (outputTokens / 1_000_000) * cost.outputCostPerMTok;
  const cacheReadCost = cost.cacheReadCostPerMTok
    ? (cacheReadTokens / 1_000_000) * cost.cacheReadCostPerMTok
    : 0;
  const cacheWriteCost = cost.cacheWriteCostPerMTok
    ? (cacheWriteTokens / 1_000_000) * cost.cacheWriteCostPerMTok
    : 0;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * 格式化成本
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `${(cost * 1000).toFixed(2)} 毫`;
  } else if (cost < 1) {
    return `${cost.toFixed(3)} 元`;
  } else {
    return `${cost.toFixed(2)} 元`;
  }
}
