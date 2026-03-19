// src/expert/feature-list.ts
// 功能清单管理
// 定义"什么算完成"
// 防止 Agent 提前宣布任务完成

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger';

const logger = createLogger('feature-list');

/**
 * 功能状态
 */
export type FeatureStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

/**
 * 功能步骤
 */
export interface FeatureStep {
  description: string;
  expected?: string;      // 预期结果
  actual?: string;          // 实际结果（由 Agent 填写）
}

/**
 * 功能定义
 */
export interface Feature {
  id: string;                  // 像素功能 ID: "user-login"
  category: string;            // 分类: "functional", "ui", "api", "security"
  priority: 'high' | 'medium' | 'low';
  description: string;         // 功能描述
  steps: FeatureStep[];         // 验证步骤
  status: FeatureStatus;
  assignee?: string;           // 负责专家
  startedAt?: string;          // 开始时间
  completedAt?: string;        // 完成时间
  notes?: string;               // 备注
  dependencies?: string[];      // 依赖的功能 ID
}

/**
 * 功能清单文件
 */
export interface FeatureListFile {
  projectPath: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  features: Feature[];
  completedCount: number;
  totalCount: number;
}

/**
 * 功能清单管理器
 */
export class FeatureListManager {
  private featureFileName = '.xiaozhi-features.json';

  /**
   * 获取功能清单路径
   */
  private getFeatureListPath(workDir: string): string {
    return path.join(workDir, this.featureFileName);
  }

  /**
   * 检查功能清单是否存在
   */
  async exists(workDir: string): Promise<boolean> {
    try {
      await fs.access(this.getFeatureListPath(workDir));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 创建功能清单
   */
  async create(
    workDir: string,
    features: Array<{
      id: string;
      description: string;
      category?: string;
      priority?: 'high' | 'medium' | 'low';
      steps?: Array<{ description: string; expected?: string }>;
      dependencies?: string[];
    }>,
    projectName?: string
  ): Promise<FeatureListFile> {
    const featureListPath = this.getFeatureListPath(workDir);
    const now = new Date().toISOString();

    const featureList: FeatureListFile = {
      projectPath: workDir,
      projectName: projectName || path.basename(workDir),
      createdAt: now,
      updatedAt: now,
      features: features.map(f => ({
        id: f.id,
        category: f.category || 'functional',
        priority: f.priority || 'medium',
        description: f.description,
        steps: f.steps || [],
        status: 'pending' as FeatureStatus,
        dependencies: f.dependencies || [],
      })),
      completedCount: 0,
      totalCount: features.length,
    };

    await fs.writeFile(featureListPath, JSON.stringify(featureList, null, 2));
    logger.info(`创建功能清单: ${workDir} (${features.length} 个功能)`);
    return featureList;
  }

  /**
   * 读取功能清单
   */
  async read(workDir: string): Promise<FeatureListFile | null> {
    const featureListPath = this.getFeatureListPath(workDir);
    try {
      const content = await fs.readFile(featureListPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.debug(`读取功能清单失败: ${workDir}`, error);
      return null;
    }
  }

  /**
   * 获取下一个待处理的功能
   */
  async getNextPending(workDir: string): Promise<Feature | null> {
    const list = await this.read(workDir);
    if (!list) {
      return null;
    }

    // 找到第一个 pending 状态的功能
    for (const feature of list.features) {
      if (feature.status === 'pending') {
        return feature;
      }
    }
    return null;
  }

  /**
   * 更新功能状态
   */
  async updateStatus(
    workDir: string,
    featureId: string,
    status: FeatureStatus,
    notes?: string
  ): Promise<boolean> {
    const list = await this.read(workDir);
    if (!list) {
      return false;
    }

    const feature = list.features.find(f => f.id === featureId);
    if (!feature) {
      return false;
    }

    feature.status = status;
    if (notes) {
      feature.notes = notes;
    }

    if (status === 'in_progress') {
      feature.startedAt = new Date().toISOString();
    } else if (status === 'completed') {
      feature.completedAt = new Date().toISOString();
      list.completedCount++;
    }

    list.updatedAt = new Date().toISOString();
    await fs.writeFile(this.getFeatureListPath(workDir), JSON.stringify(list, null, 2));
    logger.info(`更新功能状态: ${featureId} -> ${status}`);
    return true;
  }

  /**
   * 标记功能完成
   */
  async markCompleted(
    workDir: string,
    featureId: string,
    summary: string
  ): Promise<boolean> {
    const list = await this.read(workDir);
    if (!list) {
      return false;
    }

    const feature = list.features.find(f => f.id === featureId);
    if (!feature) {
      return false;
    }

    feature.status = 'completed';
    feature.completedAt = new Date().toISOString();
    feature.notes = summary;
    list.completedCount++;
    list.updatedAt = new Date().toISOString();

    await fs.writeFile(this.getFeatureListPath(workDir), JSON.stringify(list, null, 2));
    logger.info(`功能完成: ${featureId}`);
    return true;
  }

  /**
   * 获取进度概览
   */
  async getSummary(workDir: string): Promise<string> {
    const list = await this.read(workDir);
    if (!list) {
      return '功能清单不存在';
    }

    let md = `# 功能清单\n\n`;
    md += `> 项目: ${list.projectName}\n`;
    md += `> 更新时间: ${this.formatTime(list.updatedAt)}\n\n`;
    md += `## 进度概览\n\n`;
    md += `| 状态 | 数量 |\n`;
    md += `|------|------|\n`;
    md += `| ⏳ 待处理 | ${list.features.filter(f => f.status === 'pending').length} |\n`;
    md += `| 🔄 进行中 | ${list.features.filter(f => f.status === 'in_progress').length} |\n`;
    md += `| ✅ 已完成 | ${list.features.filter(f => f.status === 'completed').length} |\n`;
    md += `| 🚫 阻塞 | ${list.features.filter(f => f.status === 'blocked').length} |\n\n`;

    md += `## 功能列表\n\n`;

    for (const feature of list.features) {
      const statusEmoji = {
        pending: '⏳',
        'in_progress': '🔄',
        completed: '✅',
        blocked: '🚫',
      };

      md += `### ${statusEmoji[feature.status]} ${feature.id}\n\n`;
      md += `**分类**: ${feature.category}\n`;
      md += `**优先级**: ${feature.priority}\n`;
      md += `**描述**: ${feature.description}\n`;

      if (feature.steps.length > 0) {
        md += `\n**验证步骤**:\n`;
        for (let i = 0; i < feature.steps.length; i++) {
          const step = feature.steps[i];
          const check = step.actual ? '✅' : '⬜';
          md += `${i + 1}. ${step.description}`;
          if (step.expected) {
            md += `   预期: ${step.expected}\n`;
          }
          if (step.actual) {
            md += `   实际: ${check} ${step.actual}\n`;
          }
        }
      }

      if (feature.dependencies && feature.dependencies.length > 0) {
        md += `\n**依赖**: ${feature.dependencies.join(', ')}\n`;
      }

      if (feature.notes) {
        md += `\n**备注**: ${feature.notes}\n`;
      }

      md += '\n---\n\n';
    }

    return md;
  }

  private formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

// 导出单例
export const featureListManager = new FeatureListManager();
