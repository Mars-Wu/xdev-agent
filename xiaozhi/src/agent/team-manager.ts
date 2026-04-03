// src/agent/team-manager.ts
// 团队管理器 - 多 Agent 协作

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { InProcessAgent, AgentType, AgentConfig, AgentStatus } from './in-process-agent';
import { getMessageBus, MessageType, AgentMessage } from './message-bus';

const logger = createLogger('team-manager');

/**
 * 团队成员配置
 */
export interface TeamMemberConfig {
  /** 成员名称 */
  name: string;
  /** Agent 类型 */
  type: AgentType;
  /** 可用工具（可选） */
  tools?: string[];
  /** 自定义提示词（可选） */
  systemPrompt?: string;
  /** 模型（可选） */
  model?: string;
}

/**
 * 团队配置
 */
export interface TeamConfig {
  /** 团队名称 */
  name: string;
  /** 团队描述 */
  description?: string;
  /** 成员配置 */
  members: TeamMemberConfig[];
}

/**
 * 团队状态
 */
export interface TeamState {
  /** 团队 ID */
  teamId: string;
  /** 团队配置 */
  config: TeamConfig;
  /** 成员状态 */
  memberStatus: Record<string, AgentStatus>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 任务历史 */
  taskHistory: TaskRecord[];
}

/**
 * 任务记录
 */
export interface TaskRecord {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 分配给的成员 */
  assignedTo: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 结果 */
  result?: string;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/**
 * 团队管理器
 */
export class TeamManager {
  private teamId: string;
  private config: TeamConfig;
  private members: Map<string, InProcessAgent> = new Map();
  private state: TeamState;
  private messageBus = getMessageBus();
  private teamDir: string;

  constructor(config: TeamConfig) {
    this.teamId = this.generateId();
    this.config = config;
    this.teamDir = this.getTeamDir();

    this.state = {
      teamId: this.teamId,
      config,
      memberStatus: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      taskHistory: [],
    };
  }

  /**
   * 初始化团队
   */
  async initialize(): Promise<void> {
    // 创建团队目录
    await fs.mkdir(this.teamDir, { recursive: true });
    await fs.mkdir(path.join(this.teamDir, 'memory'), { recursive: true });
    await fs.mkdir(path.join(this.teamDir, 'messages'), { recursive: true });

    // 创建成员 Agent
    for (const memberConfig of this.config.members) {
      const agentConfig: AgentConfig = {
        id: `${this.teamId}-${memberConfig.name}`,
        name: memberConfig.name,
        type: memberConfig.type,
        tools: memberConfig.tools,
        systemPrompt: memberConfig.systemPrompt,
        model: memberConfig.model,
      };

      const agent = new InProcessAgent(agentConfig);
      this.members.set(memberConfig.name, agent);
      this.state.memberStatus[memberConfig.name] = 'idle';
    }

    // 保存团队配置
    await this.saveTeamConfig();

    logger.info(`团队 ${this.config.name} 已初始化 (${this.members.size} 个成员)`);
  }

  /**
   * 分配任务给成员
   */
  async assignTask(
    memberName: string,
    task: string,
    timeout: number = 120000
  ): Promise<string> {
    const agent = this.members.get(memberName);
    if (!agent) {
      throw new Error(`成员不存在: ${memberName}`);
    }

    // 记录任务
    const taskRecord: TaskRecord = {
      taskId: this.generateId(),
      description: task,
      assignedTo: memberName,
      startTime: Date.now(),
      status: 'running',
    };
    this.state.taskHistory.push(taskRecord);
    this.state.memberStatus[memberName] = 'working';

    try {
      // 发送任务消息
      const result = await this.messageBus.sendAndWait({
        type: MessageType.TASK,
        from: 'team-manager',
        to: agent.getConfig().id,
        content: task,
      }, timeout);

      taskRecord.endTime = Date.now();
      taskRecord.status = 'completed';

      if (result && typeof result.content === 'string') {
        taskRecord.result = result.content;
        return result.content;
      } else if (result && typeof result.content === 'object' && 'error' in result.content) {
        taskRecord.status = 'failed';
        throw new Error((result.content as any).message || '任务失败');
      }

      return '任务完成';
    } catch (error) {
      taskRecord.endTime = Date.now();
      taskRecord.status = 'failed';
      taskRecord.result = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.state.memberStatus[memberName] = 'idle';
      await this.saveState();
    }
  }

  /**
   * 并行分配任务给多个成员
   */
  async assignParallel(
    tasks: Array<{ member: string; task: string }>
  ): Promise<Record<string, string>> {
    const promises = tasks.map(async ({ member, task }) => {
      try {
        const result = await this.assignTask(member, task);
        return { member, result, error: null };
      } catch (error) {
        return {
          member,
          result: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const results = await Promise.all(promises);
    const resultMap: Record<string, string> = {};

    for (const { member, result, error } of results) {
      resultMap[member] = error ? `错误: ${error}` : result;
    }

    return resultMap;
  }

  /**
   * 广播消息给所有成员
   */
  async broadcast(content: string): Promise<void> {
    for (const [name, agent] of this.members) {
      await this.messageBus.send({
        type: MessageType.BROADCAST,
        from: 'team-manager',
        to: agent.getConfig().id,
        content,
      });
    }
  }

  /**
   * 获取团队上下文（给新成员或外部）
   */
  async getTeamContext(): Promise<string> {
    const lines: string[] = [
      `# 团队: ${this.config.name}`,
      '',
      `团队 ID: ${this.teamId}`,
      `成员数: ${this.members.size}`,
      '',
      '## 成员状态',
      '',
    ];

    for (const [name, agent] of this.members) {
      const status = this.state.memberStatus[name] || 'idle';
      lines.push(`- **${name}** (${agent.getConfig().type}): ${status}`);
    }

    // 添加最近的记忆
    const teamMemoryFile = path.join(this.teamDir, 'memory', 'TEAM_MEMORY.md');
    try {
      const memory = await fs.readFile(teamMemoryFile, 'utf-8');
      lines.push('', '## 团队记忆', '', memory);
    } catch {
      // 没有团队记忆
    }

    return lines.join('\n');
  }

  /**
   * 记录团队发现
   */
  async recordDiscovery(memberName: string, discovery: string): Promise<void> {
    const teamMemoryFile = path.join(this.teamDir, 'memory', 'TEAM_MEMORY.md');
    const timestamp = new Date().toISOString();

    const entry = `\n### ${timestamp} - ${memberName}\n${discovery}\n`;

    try {
      await fs.appendFile(teamMemoryFile, entry, 'utf-8');
    } catch {
      // 创建新文件
      const content = `# 团队记忆\n\n${entry}`;
      await fs.writeFile(teamMemoryFile, content, 'utf-8');
    }
  }

  /**
   * 获取成员状态
   */
  getMemberStatus(): Record<string, AgentStatus> {
    return { ...this.state.memberStatus };
  }

  /**
   * 获取任务历史
   */
  getTaskHistory(limit: number = 20): TaskRecord[] {
    return this.state.taskHistory.slice(-limit);
  }

  /**
   * 关闭团队
   */
  async shutdown(): Promise<void> {
    // 发送关闭信号
    for (const [name, agent] of this.members) {
      await this.messageBus.send({
        type: MessageType.SHUTDOWN,
        from: 'team-manager',
        to: agent.getConfig().id,
        content: '团队关闭',
      });
      agent.cleanup();
    }

    this.members.clear();
    await this.saveState();

    logger.info(`团队 ${this.config.name} 已关闭`);
  }

  /**
   * 保存团队配置
   */
  private async saveTeamConfig(): Promise<void> {
    const configFile = path.join(this.teamDir, 'config.json');
    await fs.writeFile(
      configFile,
      JSON.stringify(
        {
          teamId: this.teamId,
          config: this.config,
          createdAt: this.state.createdAt,
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  /**
   * 保存状态
   */
  private async saveState(): Promise<void> {
    this.state.updatedAt = Date.now();
    const stateFile = path.join(this.teamDir, 'state.json');
    await fs.writeFile(stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  /**
   * 获取团队目录
   */
  private getTeamDir(): string {
    const home = process.env.XIAOZHI_HOME || path.join(os.homedir(), '.xiaozhi');
    return path.join(home, 'teams', this.teamId);
  }

  /**
   * 生成 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `team-${timestamp}-${random}`;
  }
}

// 活跃团队管理
const activeTeams: Map<string, TeamManager> = new Map();

/**
 * 创建团队
 */
export async function createTeam(config: TeamConfig): Promise<TeamManager> {
  const team = new TeamManager(config);
  await team.initialize();
  activeTeams.set(team['teamId'], team);
  return team;
}

/**
 * 获取团队
 */
export function getTeam(teamId: string): TeamManager | undefined {
  return activeTeams.get(teamId);
}

/**
 * 列出所有活跃团队
 */
export function listActiveTeams(): Array<{ teamId: string; name: string }> {
  return Array.from(activeTeams.entries()).map(([id, team]) => ({
    teamId: id,
    name: team['config'].name,
  }));
}

/**
 * 关闭所有团队
 */
export async function shutdownAllTeams(): Promise<void> {
  for (const team of activeTeams.values()) {
    await team.shutdown();
  }
  activeTeams.clear();
}
