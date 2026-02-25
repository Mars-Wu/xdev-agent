// src/upgrade/types.ts
// 小智自我升级系统 - 类型定义

import * as path from 'path';
import * as os from 'os';

// 升级状态
export type UpgradeStatus =
  | 'idle'           // 空闲
  | 'preparing'      // 准备中（备份、修改代码）
  | 'testing'        // 测试中（影子实例运行）
  | 'ready'          // 准备就绪（等待确认）
  | 'executing'      // 执行中（tmux 守护执行升级）
  | 'success'        // 成功
  | 'failed'         // 失败
  | 'rollback';      // 已回滚

// 测试结果
export interface TestResult {
  timestamp: Date;
  passed: boolean;
  testName: string;
  response?: string;
  error?: string;
  duration: number;  // 毫秒
}

// 升级记录
export interface UpgradeRecord {
  id: string;                    // 升级 ID，格式：2026-02-25_001
  status: UpgradeStatus;

  // Git 信息
  fromCommit: string;            // 升级前的 commit hash
  toCommit?: string;             // 升级后的 commit hash

  // 时间信息
  createdAt: Date;
  startedAt?: Date;              // 开始执行时间
  completedAt?: Date;            // 完成时间

  // 内容信息
  description: string;           // 升级描述
  changes: string[];             // 变更文件列表

  // 测试信息
  testResults: TestResult[];
  testPassed: boolean;

  // 执行信息
  shadowPort: number;            // 影子实例端口
  tmuxSession?: string;          // tmux 会话名

  // 结果
  success?: boolean;
  errorMessage?: string;

  // 飞书通知
  notificationsSent: string[];   // 已发送的通知列表
}

// 升级配置
export interface UpgradeConfig {
  shadowPortBase: number;        // 影子实例基础端口，默认 8090
  testTimeout: number;           // 测试超时时间（毫秒），默认 60000
  healthCheckRetries: number;    // 健康检查重试次数，默认 10
  healthCheckInterval: number;   // 健康检查间隔（毫秒），默认 3000
  upgradesDir: string;           // 升级记录目录
  xiaozhiDir: string;            // 小智项目目录
}

// 默认配置
export const DEFAULT_UPGRADE_CONFIG: UpgradeConfig = {
  shadowPortBase: 8090,
  testTimeout: 60000,
  healthCheckRetries: 10,
  healthCheckInterval: 3000,
  upgradesDir: path.join(os.homedir(), '.xiaozhi', 'upgrades'),
  xiaozhiDir: path.join(os.homedir(), 'data', 'claudeClaw', 'xiaozhi'),
};

// 升级请求
export interface UpgradeRequest {
  description: string;           // 升级描述
  changes?: string[];            // 变更文件列表（可选，自动检测）
}

// 测试消息
export interface TestMessage {
  content: string;
  expectedKeywords?: string[];   // 期望响应中包含的关键词
  timeout?: number;
}

// 影子实例状态
export interface ShadowInstance {
  port: number;
  pid?: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt?: Date;
  tmuxSession?: string;
}
