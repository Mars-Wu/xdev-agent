// src/upgrade/manager.ts
// 小智自我升级系统 - 升级管理器（主控制器）

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger';
import {
  UpgradeRecord,
  UpgradeStatus,
  UpgradeRequest,
  UpgradeConfig,
  DEFAULT_UPGRADE_CONFIG,
  TestMessage,
} from './types';
import { UpgradeRecorder } from './recorder';
import { ShadowInstanceManager } from './shadow';
import { UpgradeTester } from './tester';
import {
  sanitizeCommitMessage,
  validateTmuxSessionName,
  validateCommitHash,
  createUpgradeLock,
  FileLock,
} from './security-utils';

const logger = createLogger('upgrade-manager');

// 升级管理器单例
let upgradeManager: UpgradeManager | null = null;

export class UpgradeManager {
  private config: UpgradeConfig;
  private recorder: UpgradeRecorder;
  private shadowManager: ShadowInstanceManager;
  private tester: UpgradeTester;
  private fileLock: FileLock;
  private feishuNotifier?: (message: string) => Promise<void>;

  constructor(config?: Partial<UpgradeConfig>) {
    this.config = { ...DEFAULT_UPGRADE_CONFIG, ...config };
    this.recorder = new UpgradeRecorder(this.config);
    this.shadowManager = new ShadowInstanceManager(this.config);
    this.tester = new UpgradeTester(this.shadowManager, this.config);
    this.fileLock = createUpgradeLock();
  }

  /**
   * 设置飞书通知器
   */
  setFeishuNotifier(notifier: (message: string) => Promise<void>): void {
    this.feishuNotifier = notifier;
  }

  /**
   * 发送飞书通知
   */
  private async notify(message: string): Promise<void> {
    logger.info(`飞书通知: ${message}`);
    if (this.feishuNotifier) {
      try {
        await this.feishuNotifier(message);
        // 记录已发送的通知
        const record = this.recorder.getCurrentRecord();
        if (record) {
          await this.recorder.addNotification(message);
        }
      } catch (error) {
        logger.error('发送飞书通知失败:', error);
      }
    }
  }

  /**
   * 获取单例
   */
  static getInstance(config?: Partial<UpgradeConfig>): UpgradeManager {
    if (!upgradeManager) {
      upgradeManager = new UpgradeManager(config);
    }
    return upgradeManager;
  }

  /**
   * 检查是否有进行中的升级
   */
  async checkActiveUpgrade(): Promise<UpgradeRecord | null> {
    return this.recorder.getActiveUpgrade();
  }

  /**
   * 开始升级流程
   */
  async startUpgrade(request: UpgradeRequest): Promise<UpgradeRecord> {
    // 使用文件锁实现跨进程互斥
    const acquired = await this.fileLock.acquire(5000);
    if (!acquired) {
      throw new Error('升级流程已锁定，请等待当前升级完成');
    }

    // 检查是否有进行中的升级
    const active = await this.checkActiveUpgrade();
    if (active) {
      await this.fileLock.release();
      throw new Error(`已有进行中的升级: ${active.id}`);
    }

    try {
      // 1. 获取当前 commit
      const fromCommit = await this.getCurrentCommit();

      // 2. 创建升级记录
      const record = await this.recorder.createRecord(request.description, fromCommit);
      await this.notify(`🔄 开始升级: ${request.description}\n升级 ID: ${record.id}\n备份 commit: ${fromCommit.slice(0, 8)}`);

      return record;
    } catch (error) {
      await this.fileLock.release();
      throw error;
    }
  }

  /**
   * 完成代码修改，提交变更
   */
  async commitChanges(message: string): Promise<string> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    // 清理 commit 消息，防止命令注入
    const sanitizedMessage = sanitizeCommitMessage(message);

    // Git add 和 commit - 使用 spawn 数组参数避免注入
    await this.runGitCommand(['add', '-A']);
    const commitMessage = `feat(upgrade): ${sanitizedMessage}\n\nUpgrade ID: ${record.id}`;
    await this.runGitCommand(['commit', '-m', commitMessage]);

    // 获取新 commit
    const toCommit = await this.getCurrentCommit();
    await this.recorder.setTargetCommit(toCommit);

    // 获取变更文件列表
    const changes = await this.getChangedFiles(record.fromCommit, toCommit);
    await this.recorder.setChanges(changes);

    logger.info(`代码已提交: ${toCommit}`);
    return toCommit;
  }

  /**
   * 编译代码
   */
  async build(): Promise<void> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    await this.recorder.updateStatus('preparing');
    logger.info('开始编译...');

    await this.runCommand('npm run build', this.config.xiaozhiDir);
    logger.info('编译完成');
  }

  /**
   * 启动影子实例并测试
   */
  async testShadow(customTests?: TestMessage[]): Promise<{ passed: boolean; results: import('./types').TestResult[] }> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    await this.recorder.updateStatus('testing');

    // 获取可用端口
    const port = await this.shadowManager.getAvailablePort();
    await this.recorder.setShadowPort(port);

    await this.notify(`🧪 开始测试影子实例 (端口 ${port})...`);

    try {
      // 启动影子实例
      await this.shadowManager.start(port);

      // 运行测试
      const result = await this.tester.runAllTests(port, customTests);

      // 记录测试结果
      for (const testResult of result.results) {
        await this.recorder.addTestResult(testResult);
      }

      if (result.passed) {
        await this.notify(`✅ 测试通过！共 ${result.results.length} 个测试全部成功。`);
      } else {
        const failed = result.results.filter(r => !r.passed).length;
        await this.notify(`❌ 测试失败：${failed}/${result.results.length} 个测试未通过。\n请检查并修复问题后重新测试。`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.notify(`❌ 测试过程出错: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * 准备升级（测试通过后调用）
   */
  async prepareUpgrade(): Promise<string> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    if (!record.testPassed) {
      throw new Error('测试未通过，不能准备升级');
    }

    await this.recorder.updateStatus('ready');

    // 生成升级脚本
    const scriptPath = await this.recorder.saveExecuteScript(record);

    await this.notify(`📦 升级准备就绪！\n\n升级脚本: ${scriptPath}\n\n确认升级后，将启动 tmux 守护进程执行升级。`);

    return scriptPath;
  }

  /**
   * 执行升级（启动 tmux 守护）
   */
  async executeUpgrade(): Promise<void> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    if (record.status !== 'ready') {
      throw new Error('升级未准备就绪，请先完成测试');
    }

    await this.recorder.updateStatus('executing');

    const tmuxSession = 'tmux_upgradeXiaoZhi';
    await this.recorder.setTmuxSession(tmuxSession);

    // 先停止影子实例
    await this.shadowManager.stopAll();

    // 启动 tmux 会话执行升级脚本
    const scriptPath = path.join(this.config.upgradesDir, record.id, 'execute.sh');

    await this.notify(`🚀 开始执行升级...\n\ntmux 会话: ${tmuxSession}\n\n升级完成后，新版小智会通知您结果。`);

    // 验证 tmux 会话名安全性
    if (!validateTmuxSessionName(tmuxSession)) {
      throw new Error('无效的 tmux 会话名');
    }

    // 使用 spawn 数组参数执行 tmux 命令，避免 shell 注入
    spawn('tmux', ['kill-session', '-t', tmuxSession], {
      cwd: this.config.xiaozhiDir,
      detached: true,
      stdio: 'ignore',
    }).on('error', () => {
      // 忽略会话不存在的错误
    });

    // 创建 tmux 会话并执行升级脚本 - 使用数组参数
    const shellCommand = `bash '${scriptPath}'; echo '升级脚本执行完成，等待新版小智确认...'; read`;
    spawn('tmux', ['new', '-d', '-s', tmuxSession, shellCommand], {
      cwd: this.config.xiaozhiDir,
      detached: true,
      stdio: 'ignore',
    }).unref();

    logger.info(`升级 tmux 会话已启动: ${tmuxSession}`);
  }

  /**
   * 检查升级结果（新版小智启动时调用）
   */
  async checkUpgradeResult(): Promise<{ hasPending: boolean; record?: UpgradeRecord; success?: boolean }> {
    const active = await this.checkActiveUpgrade();

    if (!active) {
      return { hasPending: false };
    }

    if (active.status === 'executing') {
      // 检查结果文件
      const resultPath = path.join(this.config.upgradesDir, active.id, 'result.json');
      try {
        const content = await fs.readFile(resultPath, 'utf-8');
        const result = JSON.parse(content);

        if (result.status === 'success') {
          await this.recorder.updateStatus('success');
          return { hasPending: true, record: active, success: true };
        } else if (result.status === 'failed') {
          await this.recorder.updateStatus('failed');
          await this.recorder.setError(result.error);
          return { hasPending: true, record: active, success: false };
        }
      } catch {
        // 结果文件不存在，升级可能还在进行
      }
    }

    return { hasPending: true, record: active };
  }

  /**
   * 完成升级（新版小智调用）
   */
  async completeUpgrade(): Promise<void> {
    const { hasPending, record, success } = await this.checkUpgradeResult();

    if (!hasPending || !record) {
      return;
    }

    // 关闭升级 tmux 会话
    if (record.tmuxSession && validateTmuxSessionName(record.tmuxSession)) {
      try {
        await this.runTmuxCommand(['kill-session', '-t', record.tmuxSession]);
      } catch {
        // 忽略错误
      }
    }

    if (success) {
      await this.notify(`✅ 升级成功！\n\n升级 ID: ${record.id}\n从 commit: ${record.fromCommit.slice(0, 8)}\n到 commit: ${record.toCommit?.slice(0, 8)}\n\n新版小智已就绪。`);
    } else {
      await this.notify(`❌ 升级失败，已回滚。\n\n错误: ${record.errorMessage || '未知错误'}\n\n旧版小智已恢复。`);
    }

    // 清理
    this.recorder.clearCurrentRecord();
    await this.fileLock.release();
  }

  /**
   * 放弃升级，回滚代码
   */
  async abortUpgrade(): Promise<void> {
    const record = this.recorder.getCurrentRecord();
    if (!record) {
      throw new Error('没有进行中的升级');
    }

    // 停止影子实例
    await this.shadowManager.stopAll();

    // 验证 commit hash 格式
    if (!validateCommitHash(record.fromCommit)) {
      throw new Error('无效的 commit hash');
    }

    // 回滚代码 - 使用数组参数
    await this.runGitCommand(['reset', '--hard', record.fromCommit]);

    await this.recorder.updateStatus('rollback');
    await this.notify(`↩️ 升级已放弃，代码已回滚到 commit ${record.fromCommit.slice(0, 8)}`);

    // 清理
    this.recorder.clearCurrentRecord();
    await this.fileLock.release();
  }

  /**
   * 获取当前升级状态
   */
  getStatus(): { isLocked: boolean; currentRecord: UpgradeRecord | null } {
    return {
      isLocked: this.fileLock.isLocked(),
      currentRecord: this.recorder.getCurrentRecord(),
    };
  }

  /**
   * 获取升级历史
   */
  async getHistory(limit?: number): Promise<UpgradeRecord[]> {
    return this.recorder.getHistory(limit);
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取当前 git commit
   */
  private async getCurrentCommit(): Promise<string> {
    const result = await this.runGitCommand(['rev-parse', 'HEAD']);
    return result.trim();
  }

  /**
   * 获取变更文件列表
   */
  private async getChangedFiles(fromCommit: string, toCommit: string): Promise<string[]> {
    // 验证 commit hash 格式
    if (!validateCommitHash(fromCommit) || !validateCommitHash(toCommit)) {
      logger.warn('无效的 commit hash');
      return [];
    }
    try {
      const result = await this.runGitCommand(['diff', '--name-only', fromCommit, toCommit]);
      return result.trim().split('\n').filter(f => f);
    } catch {
      return [];
    }
  }

  /**
   * 执行 git 命令 - 使用 spawn 数组参数避免注入
   */
  private async runGitCommand(args: string[]): Promise<string> {
    return this.runSpawnCommand('git', args, this.config.xiaozhiDir);
  }

  /**
   * 执行 tmux 命令 - 使用 spawn 数组参数避免注入
   */
  private async runTmuxCommand(args: string[]): Promise<string> {
    return this.runSpawnCommand('tmux', args, this.config.xiaozhiDir);
  }

  /**
   * 使用 spawn 执行命令（安全版本，避免 shell 注入）
   */
  private runSpawnCommand(command: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * 执行命令（保留用于兼容性）
   * @deprecated 使用 runSpawnCommand 代替
   */
  private runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', command], { cwd });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }
}

// 导出获取单例的函数
export function getUpgradeManager(config?: Partial<UpgradeConfig>): UpgradeManager {
  return UpgradeManager.getInstance(config);
}
