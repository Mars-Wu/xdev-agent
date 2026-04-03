// src/memory/memory-retriever.ts
// 记忆检索器 - LLM 相关性检索

import { createLogger } from '../utils/logger';
import { getLLMClient } from '../core';
import {
  MemoryEntry,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  MemoryType,
  MemoryScope,
  MemoryCategory,
} from './types';
import { getMemoryManager } from './memory-manager';

const logger = createLogger('memory-retriever');

/**
 * LLM 相关性检索提示词
 */
const RELEVANCE_PROMPT = `# 记忆相关性评估

你是一个记忆检索专家，负责从候选记忆中选择与当前查询最相关的记忆。

## 任务
根据用户查询，从给定的候选记忆中选择最相关的记忆。

## 评估标准
1. **直接相关性**: 记忆内容直接回答或关联查询
2. **上下文相关**: 提供有用的背景信息
3. **时效性**: 最近更新的记忆可能更相关
4. **重要性**: 高重要性记忆可能更有价值

## 输出格式
返回 JSON 数组，包含选中的记忆编号（从 1 开始），最多 5 个：
\`\`\`json
{
  "selected": [1, 3, 5],
  "reasons": {
    "1": "直接回答了用户的技术栈问题",
    "3": "提供了项目背景信息",
    "5": "相关的决策记录"
  }
}
\`\`\`

如果没有相关记忆，返回空数组 {"selected": [], "reasons": {}}`;

/**
 * 记忆检索器
 */
export class MemoryRetriever {
  private llmClient = getLLMClient();
  private memoryManager = getMemoryManager();

  /**
   * 检索相关记忆
   */
  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult[]> {
    const { query, limit = 5, types, categories, scopes, minImportance = 3 } = request;

    // 1. 关键词快速过滤
    const candidates = await this.keywordFilter(query, {
      types,
      categories,
      scopes,
      minImportance,
      limit: 20, // 获取更多候选，供 LLM 筛选
    });

    if (candidates.length === 0) {
      return [];
    }

    // 2. 如果候选数量少，直接返回
    if (candidates.length <= limit) {
      return candidates.map(entry => ({
        entry,
        relevanceScore: 0.7,
        matchReason: '关键词匹配',
      }));
    }

    // 3. LLM 相关性筛选
    const selected = await this.llmSelectRelevant(query, candidates, limit);

    // 4. 更新访问统计
    for (const result of selected) {
      await this.memoryManager.updateAccessStats(result.entry.id);
    }

    return selected;
  }

  /**
   * 关键词快速过滤
   */
  private async keywordFilter(
    query: string,
    options: {
      types?: MemoryType[];
      categories?: MemoryCategory[];
      scopes?: MemoryScope[];
      minImportance: number;
      limit: number;
    }
  ): Promise<MemoryEntry[]> {
    // 获取所有记忆
    const allMemories = await this.memoryManager.loadMemories();

    // 过滤
    let filtered = allMemories.filter(memory => {
      // 重要性过滤
      if (memory.importance < options.minImportance) return false;

      // 类型过滤
      if (options.types && !options.types.includes(memory.type)) return false;

      // 分类过滤
      if (options.categories && !options.categories.includes(memory.category)) return false;

      // 作用域过滤
      if (options.scopes && !options.scopes.includes(memory.scope)) return false;

      return true;
    });

    // 关键词匹配评分
    const queryWords = query.toLowerCase().split(/\s+/);

    const scored = filtered.map(memory => {
      const contentLower = memory.content.toLowerCase();
      const tagsLower = memory.tags.map(t => t.toLowerCase());

      let score = 0;

      // 内容匹配
      for (const word of queryWords) {
        if (contentLower.includes(word)) {
          score += 2;
        }
      }

      // 标签匹配
      for (const tag of tagsLower) {
        for (const word of queryWords) {
          if (tag.includes(word)) {
            score += 1;
          }
        }
      }

      // 重要性加成
      score += memory.importance * 0.1;

      // 新鲜度加成
      const ageInDays = (Date.now() - memory.lastAccessedAt) / (1000 * 60 * 60 * 24);
      if (ageInDays < 1) {
        score += 1;
      } else if (ageInDays < 7) {
        score += 0.5;
      }

      return { memory, score };
    });

    // 排序并返回
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit).map(s => s.memory);
  }

  /**
   * LLM 相关性筛选
   */
  private async llmSelectRelevant(
    query: string,
    candidates: MemoryEntry[],
    maxCount: number
  ): Promise<MemoryRetrievalResult[]> {
    // 构建候选列表
    const candidateList = candidates
      .map((m, i) => `${i + 1}. [${m.category}] ${m.content}`)
      .join('\n');

    const prompt = `## 用户查询
${query}

## 候选记忆
${candidateList}

请选择与查询最相关的记忆（最多 ${maxCount} 个）。`;

    try {
      const response = await this.llmClient.chatSync({
        model: process.env.XIAOZHI_MODEL || 'glm-5',
        maxTokens: 500,
        messages: [{ role: 'user', content: prompt }],
        system: RELEVANCE_PROMPT,
      });

      // 解析结果
      const parsed = this.parseSelectionResult(response.content);

      // 构建返回结果
      const results: MemoryRetrievalResult[] = [];

      for (const index of parsed.selected) {
        if (index >= 1 && index <= candidates.length) {
          results.push({
            entry: candidates[index - 1],
            relevanceScore: 0.8,
            matchReason: parsed.reasons[index.toString()] || 'LLM 相关性匹配',
          });
        }
      }

      return results.slice(0, maxCount);
    } catch (error) {
      logger.error('LLM 相关性筛选失败:', error);

      // 降级：返回前 N 个
      return candidates.slice(0, maxCount).map(entry => ({
        entry,
        relevanceScore: 0.5,
        matchReason: '关键词匹配（LLM 筛选失败）',
      }));
    }
  }

  /**
   * 解析选择结果
   */
  private parseSelectionResult(content: string): {
    selected: number[];
    reasons: Record<string, string>;
  } {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { selected: [], reasons: {} };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        selected: Array.isArray(parsed.selected) ? parsed.selected : [],
        reasons: parsed.reasons || {},
      };
    } catch {
      return { selected: [], reasons: {} };
    }
  }

  /**
   * 按主题检索
   */
  async retrieveByTopic(topic: string, limit: number = 10): Promise<MemoryEntry[]> {
    const allMemories = await this.memoryManager.loadMemories();

    return allMemories
      .filter(m => m.tags.some(t => t.toLowerCase().includes(topic.toLowerCase())))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * 按时间范围检索
   */
  async retrieveByTimeRange(
    startTime: number,
    endTime: number,
    limit: number = 20
  ): Promise<MemoryEntry[]> {
    const allMemories = await this.memoryManager.loadMemories();

    return allMemories
      .filter(m => m.createdAt >= startTime && m.createdAt <= endTime)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * 获取最近记忆
   */
  async getRecentMemories(limit: number = 10): Promise<MemoryEntry[]> {
    const allMemories = await this.memoryManager.loadMemories();

    return allMemories
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, limit);
  }

  /**
   * 获取重要记忆
   */
  async getImportantMemories(limit: number = 10): Promise<MemoryEntry[]> {
    const allMemories = await this.memoryManager.loadMemories();

    return allMemories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * 构建记忆注入 Prompt
   */
  async buildMemoryPrompt(query: string): Promise<string> {
    const results = await this.retrieve({ query, limit: 15 });

    if (results.length === 0) {
      return '';
    }

    const lines: string[] = ['## 相关记忆', ''];

    // 按类型分组
    const grouped = this.groupByCategory(results);

    const categoryNames: Record<string, string> = {
      preference: '用户偏好',
      convention: '项目约定',
      decision: '历史决策',
      feedback: '用户反馈',
      fact: '重要事实',
      procedure: '操作流程',
    };

    for (const [category, memories] of Object.entries(grouped)) {
      const name = categoryNames[category] || category;
      lines.push(`### ${name}`);

      for (const result of memories) {
        lines.push(`- ${result.entry.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 按分类分组
   */
  private groupByCategory(
    results: MemoryRetrievalResult[]
  ): Record<string, MemoryRetrievalResult[]> {
    const grouped: Record<string, MemoryRetrievalResult[]> = {};

    for (const result of results) {
      const category = result.entry.category;
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(result);
    }

    return grouped;
  }
}

// 单例
let memoryRetriever: MemoryRetriever | null = null;

/**
 * 获取记忆检索器
 */
export function getMemoryRetriever(): MemoryRetriever {
  if (!memoryRetriever) {
    memoryRetriever = new MemoryRetriever();
  }
  return memoryRetriever;
}
