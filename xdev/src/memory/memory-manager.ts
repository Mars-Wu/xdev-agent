// src/memory/memory-manager.ts
// 记忆管理器 - 核心管理类

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger';
import { getXdevHome } from '../config';
import {
  MemoryEntry,
  MemoryType,
  MemoryScope,
  MemoryCategory,
  MemorySystemConfig,
  DEFAULT_MEMORY_CONFIG,
  MemoryFileMetadata,
} from './types';

const logger = createLogger('memory');

/**
 * 记忆管理器
 */
export class MemoryManager {
  private config: MemorySystemConfig;
  private memoryDir: string;
  private memoryFile: string;
  private semanticDir: string;
  private episodicDir: string;
  private proceduralDir: string;
  private cache: MemoryEntry[] | null = null;
  private indexCache: Map<string, string> = new Map(); // id -> filepath

  constructor(config: Partial<MemorySystemConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    const home = getXdevHome();
    this.memoryDir = path.join(home, 'memory');
    this.memoryFile = path.join(this.memoryDir, 'MEMORY.md');
    this.semanticDir = path.join(this.memoryDir, 'semantic');
    this.episodicDir = path.join(this.memoryDir, 'episodic');
    this.proceduralDir = path.join(this.memoryDir, 'procedural');
  }

  /**
   * 初始化记忆目录
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.mkdir(this.semanticDir, { recursive: true });
    await fs.mkdir(this.episodicDir, { recursive: true });
    await fs.mkdir(this.proceduralDir, { recursive: true });

    // 创建默认 MEMORY.md 如果不存在
    try {
      await fs.access(this.memoryFile);
    } catch {
      await this.writeMemoryIndex([]);
      logger.info('创建默认 MEMORY.md');
    }
  }

  /**
   * 加载所有记忆
   */
  async loadMemories(): Promise<MemoryEntry[]> {
    if (this.cache) {
      return this.cache;
    }

    const entries: MemoryEntry[] = [];

    // 从分类目录读取（.md 文件是唯一数据源，MEMORY.md 仅用于展示）
    const dirs = [
      { dir: this.semanticDir, type: MemoryType.SEMANTIC },
      { dir: this.episodicDir, type: MemoryType.EPISODIC },
      { dir: this.proceduralDir, type: MemoryType.PROCEDURAL },
    ];

    for (const { dir } of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (file.endsWith('.md')) {
            try {
              const entry = await this.loadMemoryFile(path.join(dir, file));
              if (entry) {
                entries.push(entry);
                this.indexCache.set(entry.id, path.join(dir, file));
              }
            } catch (e) {
              logger.warn(`加载记忆文件失败: ${file}`);
            }
          }
        }
      } catch {
        // 目录不存在，忽略
        logger.debug(`记忆目录不存在，跳过`)
      }
    }

    this.cache = entries;
    return entries;
  }

  /**
   * 解析 MEMORY.md 索引
   */
  private parseMemoryIndex(content: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const lines = content.split('\n');
    let currentCategory: MemoryCategory = 'fact';

    for (const line of lines) {
      // 检测分类标题
      const headerMatch = line.match(/^##\s+(.+)/);
      if (headerMatch) {
        const section = headerMatch[1].toLowerCase();
        if (section.includes('偏好') || section.includes('preference')) {
          currentCategory = 'preference';
        } else if (section.includes('约定') || section.includes('convention')) {
          currentCategory = 'convention';
        } else if (section.includes('决策') || section.includes('decision')) {
          currentCategory = 'decision';
        } else if (section.includes('反馈') || section.includes('feedback')) {
          currentCategory = 'feedback';
        } else if (section.includes('流程') || section.includes('procedure')) {
          currentCategory = 'procedure';
        } else {
          currentCategory = 'fact';
        }
        continue;
      }

      // 解析列表项
      const listMatch = line.match(/^-\s+(.+)/);
      if (listMatch) {
        const value = listMatch[1].trim();
        entries.push({
          id: this.generateId(),
          content: value,
          type: MemoryType.SEMANTIC,
          scope: MemoryScope.PRIVATE,
          category: currentCategory,
          importance: 5,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 0,
          tags: [],
        });
      }
    }

    return entries;
  }

  /**
   * 加载单个记忆文件
   */
  private async loadMemoryFile(filepath: string): Promise<MemoryEntry | null> {
    try {
      const content = await fs.readFile(filepath, 'utf-8');
      return this.parseMemoryFile(content);
    } catch {
      return null;
    }
  }

  /**
   * 解析记忆文件（带 frontmatter）
   */
  private parseMemoryFile(content: string): MemoryEntry | null {
    // 解析 frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatterStr = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();

    // 解析 YAML frontmatter
    const metadata: Partial<MemoryFileMetadata> = {};
    for (const line of frontmatterStr.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
        if (match) {
          const [, key, value] = match;
          if (key === 'tags' || key === 'metadata') {
            metadata[key] = JSON.parse(value);
          } else {
            (metadata as any)[key] = value;
          }
        }
    }

    return {
      id: metadata.id || this.generateId(),
      content: body,
      type: metadata.type || MemoryType.SEMANTIC,
      scope: metadata.scope || MemoryScope.PRIVATE,
      category: metadata.category || 'fact',
      importance: metadata.importance || 5,
      createdAt: metadata.createdAt ? new Date(metadata.createdAt).getTime() : Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      tags: metadata.tags || [],
      sessionId: metadata.sessionId,
      projectPath: metadata.projectPath,
      metadata: metadata.metadata,
    };
  }

  /**
   * 添加记忆
   */
  async addMemory(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<string> {
    const memories = await this.loadMemories();

    // 检查是否超过最大条目数
    if (memories.length >= this.config.maxEntries) {
      // 移除重要性最低的条目
      memories.sort((a, b) => b.importance - a.importance);
      const toRemove = memories.splice(this.config.maxEntries - 1);
      for (const removed of toRemove) {
        await this.deleteMemoryFile(removed.id);
      }
    }

    const newEntry: MemoryEntry = {
      ...entry,
      id: this.generateId(),
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    };

    // 保存到文件
    await this.saveMemoryFile(newEntry);

    // 更新索引
    memories.push(newEntry);
    await this.updateMemoryIndex(memories);

    // 清除缓存
    this.cache = null;

    logger.info(`添加记忆: ${newEntry.id.slice(0, 8)}... [${entry.category}]`);
    return newEntry.id;
  }

  /**
   * 保存记忆文件
   */
  private async saveMemoryFile(entry: MemoryEntry): Promise<void> {
    const dir = this.getTypeDir(entry.type);
    const filepath = path.join(dir, `${entry.id}.md`);

    const frontmatter: MemoryFileMetadata = {
      id: entry.id,
      type: entry.type,
      scope: entry.scope,
      category: entry.category,
      importance: entry.importance,
      createdAt: new Date(entry.createdAt).toISOString(),
      tags: entry.tags,
      sessionId: entry.sessionId,
      projectPath: entry.projectPath,
      metadata: entry.metadata,
    };

    const content = this.buildMemoryFileContent(frontmatter, entry.content);
    await fs.writeFile(filepath, content, 'utf-8');

    this.indexCache.set(entry.id, filepath);
  }

  /**
   * 构建记忆文件内容
   */
  private buildMemoryFileContent(metadata: MemoryFileMetadata, content: string): string {
    const lines: string[] = ['---'];

    lines.push(`id: ${metadata.id}`);
    lines.push(`type: ${metadata.type}`);
    lines.push(`scope: ${metadata.scope}`);
    lines.push(`category: ${metadata.category}`);
    lines.push(`importance: ${metadata.importance}`);
    lines.push(`createdAt: ${metadata.createdAt}`);
    lines.push(`tags: ${JSON.stringify(metadata.tags)}`);

    if (metadata.sessionId) {
      lines.push(`sessionId: ${metadata.sessionId}`);
    }
    if (metadata.projectPath) {
      lines.push(`projectPath: ${metadata.projectPath}`);
    }
    if (metadata.metadata) {
      lines.push(`metadata: ${JSON.stringify(metadata.metadata)}`);
    }

    lines.push('---', '', content);

    return lines.join('\n');
  }

  /**
   * 获取类型对应目录
   */
  private getTypeDir(type: MemoryType): string {
    switch (type) {
      case MemoryType.SEMANTIC:
        return this.semanticDir;
      case MemoryType.EPISODIC:
        return this.episodicDir;
      case MemoryType.PROCEDURAL:
        return this.proceduralDir;
      default:
        return this.semanticDir;
    }
  }

  /**
   * 删除记忆文件
   */
  private async deleteMemoryFile(id: string): Promise<void> {
    const filepath = this.indexCache.get(id);
    if (filepath) {
      try {
        await fs.unlink(filepath);
        this.indexCache.delete(id);
      } catch (err) {
        logger.debug(`删除记忆文件 ${id} 失败:`, err)
      }
    }
  }

  /**
   * 更新 MEMORY.md 索引
   */
  private async updateMemoryIndex(entries: MemoryEntry[]): Promise<void> {
    // 按分类分组
    const grouped = new Map<MemoryCategory, MemoryEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.category) || [];
      list.push(entry);
      grouped.set(entry.category, list);
    }

    // 构建内容
    const sections: string[] = [
      '# 艾克斯记忆系统',
      '',
      '> 跨会话知识积累，自动注入到系统提示词',
      '',
    ];

    const categoryNames: Record<MemoryCategory, string> = {
      preference: '## 用户偏好',
      convention: '## 项目约定',
      decision: '## 历史决策',
      feedback: '## 用户反馈',
      fact: '## 重要事实',
      procedure: '## 操作流程',
      context: '## 上下文信息',
      topic: '## 主题分类',
      insight: '## 洞察总结',
      error: '## 错误及解决方案',
      resource: '## 资源链接',
    };

    for (const [category, name] of Object.entries(categoryNames)) {
      const items = grouped.get(category as MemoryCategory) || [];
      if (items.length > 0) {
        sections.push(name);
        // 只保留最重要的 20 条
        const topItems = items
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 20);
        for (const item of topItems) {
          sections.push(`- ${item.content}`);
        }
        sections.push('');
      }
    }

    const content = sections.join('\n');

    // 检查文件大小
    if (content.length > this.config.maxFileSize) {
      logger.warn(`记忆索引超过限制，需要压缩`);
    }

    await fs.writeFile(this.memoryFile, content, 'utf-8');
  }

  /**
   * 写入记忆索引（初始）
   */
  private async writeMemoryIndex(entries: MemoryEntry[]): Promise<void> {
    await this.updateMemoryIndex(entries);
  }

  /**
   * 搜索相关记忆
   */
  async searchRelevant(query: string, limit: number = 10): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    // 计算相关性分数
    const scored = memories.map(entry => {
      const contentLower = entry.content.toLowerCase();
      let score = 0;

      // 完全匹配
      if (contentLower.includes(queryLower)) {
        score += 10;
      }

      // 单词匹配
      for (const word of queryWords) {
        if (word.length > 2 && contentLower.includes(word)) {
          score += 2;
        }
      }

      // 标签匹配
      for (const tag of entry.tags) {
        if (queryLower.includes(tag.toLowerCase())) {
          score += 3;
        }
      }

      // 重要性加权
      score += entry.importance;

      // 新鲜度加权
      const ageInDays = (Date.now() - entry.lastAccessedAt) / (1000 * 60 * 60 * 24);
      if (ageInDays < 1) {
        score += 2;
      } else if (ageInDays < 7) {
        score += 1;
      }

      return { entry, score };
    });

    // 排序并返回
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  /**
   * 更新访问统计
   */
  async updateAccessStats(id: string): Promise<void> {
    const memories = await this.loadMemories();
    const entry = memories.find(m => m.id === id);

    if (entry) {
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      await this.saveMemoryFile(entry);
    }
  }

  /**
   * 获取重要记忆（话题感知过滤）
   *
   * 过滤策略：
   *   1. 通用记忆（tags 中无任何话题 ID T_ 前缀）→ 始终注入
   *   2. 与当前话题同标签的记忆 → 注入
   *   3. 重要度 >= 8 的全局记忆 → 始终注入（高价值跨话题知识）
   *   4. 其他话题的专属记忆 → 过滤掉，避免话题污染
   */
  async getImportantMemories(limit: number = 15, currentTopicId?: string): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();

    const filtered = currentTopicId
      ? memories.filter(m => {
          // 重要度 >= 8：全局知识，始终保留
          if (m.importance >= 8) return true
          // 检查是否有话题 tag
          const topicTags = m.tags.filter(t => t.startsWith('T_'))
          // 无话题 tag = 通用记忆，始终保留
          if (topicTags.length === 0) return true
          // 有话题 tag：只保留与当前话题相关的
          return topicTags.includes(currentTopicId)
        })
      : memories

    filtered.sort((a, b) => b.importance - a.importance)
    return filtered.slice(0, limit)
  }

  /**
   * 删除记忆
   */
  async removeMemory(id: string): Promise<boolean> {
    const memories = await this.loadMemories();
    const index = memories.findIndex(m => m.id === id);

    if (index >= 0) {
      memories.splice(index, 1);
      await this.deleteMemoryFile(id);
      await this.updateMemoryIndex(memories);
      this.cache = null;
      logger.info(`删除记忆: ${id}`);
      return true;
    }

    return false;
  }

  /**
   * 清除所有记忆
   */
  async clearAll(): Promise<void> {
    const dirs = [this.semanticDir, this.episodicDir, this.proceduralDir];

    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (file.endsWith('.md')) {
            await fs.unlink(path.join(dir, file));
          }
        }
      } catch (err) {
        logger.debug(`清除记忆目录失败:`, err)
      }
    }

    await this.writeMemoryIndex([]);
    this.cache = null;
    this.indexCache.clear();
    logger.info('清除所有记忆');
  }

  /**
   * 导出为 Prompt 格式
   */
  async exportToPrompt(): Promise<string> {
    const memories = await this.getImportantMemories(20);

    if (memories.length === 0) {
      return '';
    }

    const lines = ['## 长期记忆', ''];

    // 按分类分组
    const grouped = new Map<MemoryCategory, MemoryEntry[]>();
    for (const memory of memories) {
      const list = grouped.get(memory.category) || [];
      list.push(memory);
      grouped.set(memory.category, list);
    }

    const categoryNames: Record<MemoryCategory, string> = {
      preference: '### 用户偏好',
      convention: '### 项目约定',
      decision: '### 历史决策',
      feedback: '### 用户反馈',
      fact: '### 重要事实',
      procedure: '### 操作流程',
      context: '',
      topic: '',
      insight: '',
      error: '',
      resource: '',
    };

    for (const [category, name] of Object.entries(categoryNames)) {
      if (!name) continue;
      const items = grouped.get(category as MemoryCategory) || [];
      if (items.length > 0) {
        lines.push(name);
        for (const item of items) {
          lines.push(`- ${item.content}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 生成记忆 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `mem-${timestamp}-${random}`;
  }

  /**
   * 获取所有记忆（供 Lint 使用）
   */
  async getAllMemories(): Promise<MemoryEntry[]> {
    return this.loadMemories();
  }

  /**
   * 获取记忆统计
   */
  async getStats(): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
    byCategory: Record<MemoryCategory, number>;
    avgImportance: number;
  }> {
    const memories = await this.loadMemories();

    const byType: Record<MemoryType, number> = {
      [MemoryType.SEMANTIC]: 0,
      [MemoryType.EPISODIC]: 0,
      [MemoryType.PROCEDURAL]: 0,
    };

    const byCategory: Record<MemoryCategory, number> = {
      preference: 0,
      convention: 0,
      decision: 0,
      feedback: 0,
      fact: 0,
      procedure: 0,
      context: 0,
      topic: 0,
      insight: 0,
      error: 0,
      resource: 0,
    };

    let totalImportance = 0;

    for (const memory of memories) {
      byType[memory.type]++;
      byCategory[memory.category]++;
      totalImportance += memory.importance;
    }

    return {
      total: memories.length,
      byType,
      byCategory,
      avgImportance: memories.length > 0 ? totalImportance / memories.length : 0,
    };
  }
}

// 单例
let memoryManager: MemoryManager | null = null;

/**
 * 获取记忆管理器实例
 */
export function getMemoryManager(): MemoryManager {
  if (!memoryManager) {
    memoryManager = new MemoryManager();
  }
  return memoryManager;
}

/**
 * 重置记忆管理器
 */
export function resetMemoryManager(): void {
  memoryManager = null;
}

// 向后兼容的旧接口
export interface LegacyMemoryEntry {
  key: string;
  value: string;
  importance: number;
  category: 'preference' | 'decision' | 'fact' | 'project';
  timestamp: number;
}

/**
 * 转换为新格式（向后兼容）
 */
export function toLegacyEntry(entry: MemoryEntry): LegacyMemoryEntry {
  return {
    key: entry.id,
    value: entry.content,
    importance: entry.importance,
    category: entry.category === 'convention' ? 'project' :
              entry.category === 'feedback' ? 'fact' :
              entry.category as 'preference' | 'decision' | 'fact' | 'project',
    timestamp: entry.createdAt,
  };
}
