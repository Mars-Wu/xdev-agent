// src/memory/memory-extractor.ts
// 记忆提取器 - 后台 subagent 提取

import { createLogger } from '../utils/logger';
import { getLLMClient } from '../core';
import { configManager } from '../config';
import {
  MemoryType,
  MemoryScope,
  MemoryCategory,
  ExtractionResult,
  MemoryEntry,
  SessionMemory,
} from './types';
import { getMemoryManager } from './memory-manager';

const logger = createLogger('memory-extractor');

/**
 * 记忆提取提示词模板
 */
const EXTRACTION_PROMPT = `# 记忆提取专家

你是一个专门从对话中提取有价值长期记忆的 AI。

## 提取类型
1. **preference** (用户偏好): 用户的个人偏好、习惯、风格偏好
2. **convention** (项目约定): 项目的技术栈、代码规范、命名约定
3. **decision** (决策记录): 重要的技术或业务决策及其理由
4. **feedback** (用户反馈): 用户的评价、纠正、建议
5. **fact** (事实信息): 重要的事实、数据、配置信息
6. **procedure** (操作流程): 可复用的工作流程、最佳实践

## 提取规则
- 只提取有长期价值的信息，忽略临时性内容
- 合并相似的记忆，避免重复
- 评估重要性（1-10），10最重要
- 添加相关标签便于检索

## 输出格式
返回 JSON 数组，每个元素格式：
\`\`\`json
{
  "content": "记忆内容（简洁的一句话）",
  "type": "semantic|episodic|procedural",
  "category": "preference|convention|decision|feedback|fact|procedure",
  "importance": 5,
  "tags": ["标签1", "标签2"]
}
\`\`\`

如果没有值得提取的记忆，返回空数组 []`;

/**
 * 记忆提取器
 */
export class MemoryExtractor {
  private llmClient = getLLMClient();
  private memoryManager = getMemoryManager();

  /**
   * 从会话中提取记忆
   */
  async extractFromSession(session: SessionMemory): Promise<ExtractionResult> {
    logger.info(`开始从会话 ${session.sessionId} 提取记忆...`);

    // 构建提取内容
    const extractionContent = this.buildExtractionContent(session);

    // 调用 LLM 进行提取
    const response = await this.llmClient.chatSync({
      model: configManager.getConfig().model.defaultModel,
      maxTokens: 2000,
      messages: [
        {
          role: 'user',
          content: `请从以下会话内容中提取长期记忆：\n\n${extractionContent}`,
        },
      ],
      system: EXTRACTION_PROMPT,
    });

    // 解析结果
    const result = this.parseExtractionResult(response.content);

    // 保存提取的记忆
    const savedIds: string[] = [];
    for (const memory of result.memories) {
      // 去重检查
      if (await this.isDuplicate(memory.content)) {
        logger.debug(`跳过重复记忆: ${memory.content}`);
        continue;
      }

      const id = await this.saveMemory(memory, session.sessionId);
      if (id) {
        savedIds.push(id);
      }
    }

    logger.info(`提取完成: ${savedIds.length} 条新记忆`);

    return {
      memories: result.memories,
      topics: result.topics,
      summary: result.summary,
    };
  }

  /**
   * 构建提取内容
   */
  private buildExtractionContent(session: SessionMemory): string {
    const lines: string[] = [
      `## 会话信息`,
      `- 会话名称: ${session.sessionName}`,
      `- 消息数: ${session.messageCount}`,
      `- Token 使用: ${session.tokenStats.total}`,
      '',
    ];

    // 主题
    if (session.topicSummary) {
      lines.push(`## 主题摘要`, session.topicSummary, '');
    }

    // 决策
    if (session.decisions.length > 0) {
      lines.push(`## 关键决策`);
      for (const decision of session.decisions) {
        lines.push(`- ${decision}`);
      }
      lines.push('');
    }

    // 操作摘要
    if (session.actions.length > 0) {
      lines.push(`## 执行的操作`);
      const successfulActions = session.actions.filter(a => a.success);
      const failedActions = session.actions.filter(a => !a.success);

      lines.push(`成功: ${successfulActions.length} 个操作`);
      if (failedActions.length > 0) {
        lines.push(`失败: ${failedActions.length} 个操作`);
      }

      // 列出关键操作
      const keyActions = successfulActions
        .filter(a => a.type === 'write' || a.type === 'edit')
        .slice(-5);

      if (keyActions.length > 0) {
        lines.push('', '关键文件操作:');
        for (const action of keyActions) {
          lines.push(`- ${action.description}`);
        }
      }
      lines.push('');
    }

    // 上下文
    if (session.context.project || session.context.cwd) {
      lines.push(`## 上下文`);
      if (session.context.project) {
        lines.push(`- 项目: ${session.context.project}`);
      }
      if (session.context.cwd) {
        lines.push(`- 工作目录: ${session.context.cwd}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 解析提取结果
   */
  private parseExtractionResult(content: string): ExtractionResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return { memories: [], topics: [], summary: '' };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed)) {
        return { memories: [], topics: [], summary: '' };
      }

      const memories = parsed.map((item: any) => ({
        content: item.content || '',
        type: this.parseMemoryType(item.type),
        category: this.parseMemoryCategory(item.category),
        importance: Math.min(10, Math.max(1, item.importance || 5)),
        tags: Array.isArray(item.tags) ? item.tags : [],
        scope: MemoryScope.PRIVATE,
      }));

      return {
        memories,
        topics: [],
        summary: '',
      };
    } catch (error) {
      logger.error('解析提取结果失败:', error);
      return { memories: [], topics: [], summary: '' };
    }
  }

  /**
   * 解析记忆类型
   */
  private parseMemoryType(type: string): MemoryType {
    const typeMap: Record<string, MemoryType> = {
      semantic: MemoryType.SEMANTIC,
      episodic: MemoryType.EPISODIC,
      procedural: MemoryType.PROCEDURAL,
    };
    return typeMap[type.toLowerCase()] || MemoryType.SEMANTIC;
  }

  /**
   * 解析记忆分类
   */
  private parseMemoryCategory(category: string): MemoryCategory {
    const categoryMap: Record<string, MemoryCategory> = {
      preference: 'preference',
      convention: 'convention',
      decision: 'decision',
      feedback: 'feedback',
      fact: 'fact',
      procedure: 'procedure',
    };
    return categoryMap[category.toLowerCase()] || 'fact';
  }

  /**
   * 检查是否重复
   */
  private async isDuplicate(content: string): Promise<boolean> {
    const existing = await this.memoryManager.searchRelevant(content, 5);

    // 检查是否有非常相似的记忆
    for (const memory of existing) {
      const similarity = this.calculateSimilarity(
        content.toLowerCase(),
        memory.content.toLowerCase()
      );

      if (similarity > 0.8) {
        return true;
      }
    }

    return false;
  }

  /**
   * 计算相似度（简单的 Jaccard 相似度）
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * 保存记忆
   */
  private async saveMemory(
    memory: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>,
    sessionId: string
  ): Promise<string | null> {
    try {
      const id = await this.memoryManager.addMemory({
        ...memory,
        sessionId,
      });
      return id;
    } catch (error) {
      logger.error('保存记忆失败:', error);
      return null;
    }
  }

  /**
   * 快速提取（简化版，用于实时提取）
   */
  async quickExtract(
    userMessage: string,
    assistantResponse: string
  ): Promise<MemoryEntry | null> {
    // 简单规则匹配
    const preferenceMatch = userMessage.match(
      /(?:我喜欢|我偏好|我喜欢|请用|希望)(.+)/
    );
    if (preferenceMatch) {
      return {
        id: '',
        content: preferenceMatch[1].trim(),
        type: MemoryType.SEMANTIC,
        category: 'preference',
        scope: MemoryScope.PRIVATE,
        importance: 6,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        tags: ['偏好'],
      };
    }

    // 决策匹配
    const decisionMatch = assistantResponse.match(
      /(?:决定|选择|采用)(.+)方案/
    );
    if (decisionMatch) {
      return {
        id: '',
        content: decisionMatch[1].trim(),
        type: MemoryType.SEMANTIC,
        category: 'decision',
        scope: MemoryScope.PRIVATE,
        importance: 7,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        tags: ['决策'],
      };
    }

    return null;
  }
}

// 单例
let memoryExtractor: MemoryExtractor | null = null;

/**
 * 获取记忆提取器
 */
export function getMemoryExtractor(): MemoryExtractor {
  if (!memoryExtractor) {
    memoryExtractor = new MemoryExtractor();
  }
  return memoryExtractor;
}
