// src/telemetry/model-costs.ts
// 模型成本配置：从统一模型目录派生

import { listTextCatalogModels } from '../core/model-catalog';

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
export const MODEL_COSTS: Record<string, ModelCost> = Object.fromEntries(
  listTextCatalogModels().map((entry) => [
    entry.id,
    {
      id: entry.id,
      name: entry.name,
      provider: 'zhipu',
      inputCostPerMTok: entry.costPerMtok.input,
      outputCostPerMTok: entry.costPerMtok.output,
      contextWindow: entry.contextWindow,
      maxOutput: entry.maxOutput,
    },
  ]),
);

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
