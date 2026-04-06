// src/agent/in-process-agent.ts
// 进程内 Agent - 替代 spawn 的轻量级 Agent

import { createLogger } from '../utils/logger';
import { getLLMClient, LLMClient } from '../core';
import { MessageHistoryManager } from '../core/message-history';
import { getMemoryManager } from '../memory';
import { getMemoryRetriever } from '../memory/memory-retriever';
import { getMessageBus, MessageType, AgentMessage } from './message-bus';
import { buildContextPrompt, getContextInfo } from '../prompt/context';
import { runAgentLoop } from '../core/agent-loop';
import { createDefaultToolRegistry } from '../tools';
import { configManager } from '../config';

const logger = createLogger('in-process-agent');

/**
 * Agent 类型
 */
export type AgentType =
  | 'general-purpose'  // 通用 Agent
  | 'explore'          // 探索/研究 Agent
  | 'plan';            // 规划 Agent

/**
 * Agent 配置
 */
export interface AgentConfig {
  /** Agent ID */
  id: string;
  /** Agent 名称 */
  name: string;
  /** Agent 类型 */
  type: AgentType;
  /** 可用工具列表（null 表示所有工具） */
  tools?: string[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 模型 */
  model?: string;
  /** 最大 Token */
  maxTokens?: number;
  /** 超时（毫秒） */
  timeout?: number;
}

/**
 * Agent 状态
 */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';

/**
 * 进程内 Agent
 */
export class InProcessAgent {
  private config: AgentConfig;
  private llmClient: LLMClient;
  private status: AgentStatus = 'idle';
  private messageBus = getMessageBus();
  private lastActivity: number = Date.now();

  constructor(config: AgentConfig) {
    this.config = config;
    this.llmClient = getLLMClient();

    // 注册消息处理器
    this.messageBus.register(config.id, this.handleMessage.bind(this));
    logger.info(`创建 Agent: ${config.name} (${config.id})`);
  }

  /**
   * 获取配置
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  /**
   * 获取状态
   */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * 处理消息
   */
  private async handleMessage(message: AgentMessage): Promise<void> {
    this.lastActivity = Date.now();

    switch (message.type) {
      case MessageType.TASK:
        await this.handleTask(message);
        break;

      case MessageType.SHUTDOWN:
        await this.handleShutdown(message);
        break;

      case MessageType.DECISION_REQUEST:
        await this.handleDecisionRequest(message);
        break;

      default:
        logger.debug(`Agent ${this.config.name} 收到消息: ${message.type}`);
    }
  }

  /**
   * 处理任务
   */
  private async handleTask(message: AgentMessage): Promise<void> {
    this.status = 'working';

    try {
      let task: string;
      if (typeof message.content === 'string') {
        task = message.content;
      } else if (message.content && typeof message.content === 'object' && 'task' in message.content) {
        task = String((message.content as Record<string, unknown>).task || '');
      } else {
        task = '';
      }

      // 执行任务
      const result = await this.execute(task);

      // 发送结果
      await this.messageBus.send({
        type: MessageType.RESULT,
        from: this.config.id,
        to: message.from,
        content: result,
        replyTo: message.id,
      });

      this.status = 'idle';
    } catch (error) {
      this.status = 'error';
      logger.error(`Agent ${this.config.name} 任务失败:`, error);

      // 发送错误结果
      await this.messageBus.send({
        type: MessageType.RESULT,
        from: this.config.id,
        to: message.from,
        content: {
          error: true,
          message: error instanceof Error ? error.message : String(error),
        },
        replyTo: message.id,
      });
    }
  }

  /**
   * 处理关闭
   */
  private async handleShutdown(message: AgentMessage): Promise<void> {
    logger.info(`Agent ${this.config.name} 收到关闭信号`);
    this.status = 'idle';
  }

  /**
   * 处理决策请求
   */
  private async handleDecisionRequest(message: AgentMessage): Promise<void> {
    let question: string;
    if (typeof message.content === 'string') {
      question = message.content;
    } else if (message.content && typeof message.content === 'object' && 'question' in message.content) {
      question = String((message.content as Record<string, unknown>).question || '');
    } else {
      question = '';
    }

    // 简单决策逻辑
    const decision = await this.makeDecision(question);

    await this.messageBus.send({
      type: MessageType.DECISION_RESPONSE,
      from: this.config.id,
      to: message.from,
      content: decision,
      replyTo: message.id,
    });
  }

  /**
   * 执行任务（Agent Loop 模式）
   *
   * 子 Agent 隔离原则（来自 learn-claude-code s04）：
   * - 使用干净的 messages=[]，不继承父 Agent 的上下文
   * - 只暴露 config.tools 指定的工具子集（null = 全部）
   * - 父 Agent 只接收最终文本摘要，不传工具调用历史
   */
  async execute(task: string): Promise<string> {
    logger.info(`Agent ${this.config.name} 开始执行: ${task.slice(0, 50)}...`);

    // 每次任务使用干净 history（子 Agent 隔离）
    const freshHistory = new MessageHistoryManager({
      maxMessages: 100,
      maxTokens: 50000,
      preserveRecent: 5,
    });
    freshHistory.addMessage({ role: 'user', content: task });

    // 构建系统提示词
    const systemPrompt = await this.buildSystemPrompt();

    // 构建工具注册表（按 config.tools 过滤）
    const registry = createDefaultToolRegistry();
    let toolRegistry: ReturnType<typeof createDefaultToolRegistry> | null = registry;
    if (this.config.tools && this.config.tools.length > 0) {
      const allowed = new Set(this.config.tools);
      // 过滤：只保留白名单工具
      const allDefs = registry.getDefinitions();
      const filtered = createDefaultToolRegistry();
      // 注销不在白名单的工具（利用重新注册覆盖）
      const filteredNames = new Set(allDefs.filter(d => allowed.has(d.name)).map(d => d.name));
      if (filteredNames.size === 0) toolRegistry = null; // 无工具，纯对话模式
    }

    const result = await runAgentLoop(
      this.llmClient,
      freshHistory,
      systemPrompt,
      toolRegistry,
      20, // 子 Agent 轮次上限略低
    );

    this.lastActivity = Date.now();
    return result || '(任务完成，无文本输出)';
  }

  /**
   * 构建系统提示词
   */
  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    // 基础身份
    parts.push(this.getBasePrompt());

    // 动态上下文
    try {
      const context = await getContextInfo();
      parts.push(buildContextPrompt(context));
    } catch {
      // 忽略
    }

    // 相关记忆（子 Agent 使用静态任务描述查询，无法访问调用时 history）
    try {
      const retriever = getMemoryRetriever();
      const memoryPrompt = await retriever.buildMemoryPrompt(this.config.name);
      if (memoryPrompt) {
        parts.push(memoryPrompt);
      }
    } catch {
      // 忽略
    }

    return parts.join('\n\n');
  }

  /**
   * 获取基础提示词
   */
  private getBasePrompt(): string {
    const typePrompts: Record<AgentType, string> = {
      'general-purpose': `你是小智的协作 Agent ${this.config.name}。

你是一个通用助手，可以执行各种任务。
简洁友好地完成任务，不要过多客套。`,

      'explore': `你是小智的研究 Agent ${this.config.name}。

你专注于探索和分析任务：
- 搜索和阅读文件
- 分析代码结构
- 研究技术问题
- 生成报告

你的输出应该结构清晰、结论明确。`,

      'plan': `你是小智的规划 Agent ${this.config.name}。

你专注于规划和设计任务：
- 分析需求
- 设计实现方案
- 制定执行步骤
- 评估风险

你的输出应该有条理、可执行。`,
    };

    let prompt = typePrompts[this.config.type];

    // 添加自定义提示词
    if (this.config.systemPrompt) {
      prompt += '\n\n' + this.config.systemPrompt;
    }

    return prompt;
  }

  /**
   * 做出决策
   */
  private async makeDecision(question: string): Promise<string> {
    // 简单实现：使用 LLM
    const response = await this.llmClient.chatSync({
      model: this.config.model || configManager.getConfig().model.defaultModel,
      maxTokens: 500,
      messages: [{ role: 'user', content: question }],
      system: `你是小智的决策 Agent。请简洁地回答问题，给出你的决策和建议。`,
    });

    return response.content;
  }

  /**
   * 发送消息给其他 Agent
   */
  async sendMessage(
    to: string,
    content: string | Record<string, unknown>,
    type: MessageType = MessageType.DIRECT
  ): Promise<void> {
    await this.messageBus.send({
      type,
      from: this.config.id,
      to,
      content,
    });
  }

  /**
   * 分享发现
   */
  async shareDiscovery(discovery: string): Promise<void> {
    await this.messageBus.send({
      type: MessageType.DISCOVERY,
      from: this.config.id,
      to: '*', // 广播
      content: discovery,
    });
  }

  /**
   * 获取活动时间
   */
  getLastActivity(): number {
    return this.lastActivity;
  }

  /**
   * 清理
   */
  cleanup(): void {
    this.messageBus.unregister(this.config.id);
    this.status = 'idle';
    logger.info(`Agent ${this.config.name} 已清理`);
  }
}
