// src/upgrade/recorder.ts
// 小智自我升级系统 - 升级记录管理

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { UpgradeRecord, UpgradeStatus, TestResult, UpgradeConfig, DEFAULT_UPGRADE_CONFIG } from './types';
import {
  validateCommitHash,
  validateUpgradeId,
  validateFilePath,
  shellEscape,
} from './security-utils';

const logger = createLogger('upgrade-recorder');

export class UpgradeRecorder {
  private config: UpgradeConfig;
  private currentRecord: UpgradeRecord | null = null;

  constructor(config?: Partial<UpgradeConfig>) {
    this.config = { ...DEFAULT_UPGRADE_CONFIG, ...config };
    this.ensureDirectory();
  }

  /**
   * 确保升级目录存在
   */
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.config.upgradesDir, { recursive: true });
    } catch (error) {
      logger.error('创建升级目录失败:', error);
    }
  }

  /**
   * 生成升级 ID
   */
  generateUpgradeId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '-');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

    // 查找当天的升级序号
    const prefix = `${dateStr}_${timeStr.slice(0, 4)}`;
    return prefix;
  }

  /**
   * 创建新的升级记录
   */
  async createRecord(description: string, fromCommit: string): Promise<UpgradeRecord> {
    const id = this.generateUpgradeId();
    const recordDir = path.join(this.config.upgradesDir, id);

    await fs.mkdir(recordDir, { recursive: true });

    const record: UpgradeRecord = {
      id,
      status: 'preparing',
      fromCommit,
      createdAt: new Date(),
      description,
      changes: [],
      testResults: [],
      testPassed: false,
      shadowPort: this.config.shadowPortBase,
      notificationsSent: [],
    };

    this.currentRecord = record;
    await this.saveRecord(record);

    logger.info(`创建升级记录: ${id}`);
    return record;
  }

  /**
   * 获取当前升级记录
   */
  getCurrentRecord(): UpgradeRecord | null {
    return this.currentRecord;
  }

  /**
   * 更新升级状态
   */
  async updateStatus(status: UpgradeStatus): Promise<void> {
    if (!this.currentRecord) {
      logger.warn('没有当前升级记录');
      return;
    }

    this.currentRecord.status = status;

    if (status === 'executing') {
      this.currentRecord.startedAt = new Date();
    } else if (status === 'success' || status === 'failed' || status === 'rollback') {
      this.currentRecord.completedAt = new Date();
      this.currentRecord.success = status === 'success';
    }

    await this.saveRecord(this.currentRecord);
    logger.info(`升级状态更新: ${status}`);
  }

  /**
   * 设置目标 commit
   */
  async setTargetCommit(commit: string): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.toCommit = commit;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 设置变更文件列表
   */
  async setChanges(changes: string[]): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.changes = changes;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 添加测试结果
   */
  async addTestResult(result: TestResult): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.testResults.push(result);
    this.currentRecord.testPassed = result.passed;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 设置影子实例端口
   */
  async setShadowPort(port: number): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.shadowPort = port;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 设置 tmux 会话名
   */
  async setTmuxSession(session: string): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.tmuxSession = session;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 记录已发送的通知
   */
  async addNotification(notification: string): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.notificationsSent.push(notification);
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 设置错误信息
   */
  async setError(message: string): Promise<void> {
    if (!this.currentRecord) return;
    this.currentRecord.errorMessage = message;
    await this.saveRecord(this.currentRecord);
  }

  /**
   * 保存升级记录到文件
   */
  private async saveRecord(record: UpgradeRecord): Promise<void> {
    const recordDir = path.join(this.config.upgradesDir, record.id);
    const stateFile = path.join(recordDir, 'state.json');

    // 转换日期为字符串
    const recordJson = JSON.stringify(record, (key, value) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    }, 2);

    await fs.writeFile(stateFile, recordJson, 'utf-8');
  }

  /**
   * 加载升级记录
   */
  async loadRecord(id: string): Promise<UpgradeRecord | null> {
    const stateFile = path.join(this.config.upgradesDir, id, 'state.json');

    try {
      const content = await fs.readFile(stateFile, 'utf-8');
      const record = JSON.parse(content, (key, value) => {
        if (key === 'createdAt' || key === 'startedAt' || key === 'completedAt' || key === 'timestamp') {
          return value ? new Date(value) : value;
        }
        return value;
      }) as UpgradeRecord;

      return record;
    } catch (error) {
      logger.error(`加载升级记录失败: ${id}`, error);
      return null;
    }
  }

  /**
   * 检查是否有进行中的升级
   */
  async getActiveUpgrade(): Promise<UpgradeRecord | null> {
    try {
      const dirs = await fs.readdir(this.config.upgradesDir);

      for (const dir of dirs) {
        const record = await this.loadRecord(dir);
        if (record && ['preparing', 'testing', 'ready', 'executing'].includes(record.status)) {
          this.currentRecord = record;
          return record;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 生成升级脚本
   */
  async generateExecuteScript(record: UpgradeRecord): Promise<string> {
    // 安全验证：验证 commit hash 格式
    if (!validateCommitHash(record.fromCommit)) {
      throw new Error(`无效的源 commit hash: ${record.fromCommit}`);
    }
    if (!record.toCommit || !validateCommitHash(record.toCommit)) {
      throw new Error(`无效的目标 commit hash: ${record.toCommit}`);
    }

    // 安全验证：验证升级 ID 格式
    if (!validateUpgradeId(record.id)) {
      throw new Error(`无效的升级 ID: ${record.id}`);
    }

    // 安全验证：验证路径在预期目录内
    if (!validateFilePath(this.config.xiaozhiDir, path.join(os.homedir(), 'data', 'claudeClaw'))) {
      throw new Error(`小智目录路径不在预期范围内: ${this.config.xiaozhiDir}`);
    }

    // P1 安全修复：使用 shell 转义路径
    const escapedXiaozhiDir = shellEscape(this.config.xiaozhiDir);
    const escapedUpgradeId = shellEscape(record.id);
    const escapedFromCommit = shellEscape(record.fromCommit);
    const escapedToCommit = shellEscape(record.toCommit);

    const script = `#!/bin/bash
# 小智升级脚本
# 升级 ID: ${record.id}
# 生成时间: ${new Date().toISOString()}

set -e

echo "=========================================="
echo "小智升级脚本"
echo "升级 ID: ${record.id}"
echo "从 commit: ${record.fromCommit}"
echo "到 commit: ${record.toCommit}"
echo "=========================================="

# 记录当前状态
echo "[1/5] 检查升级状态..."
if [ -f ~/.xiaozhi/upgrades/${escapedUpgradeId}/executing.lock ]; then
    echo "升级已在执行中"
    exit 1
fi
touch ~/.xiaozhi/upgrades/${escapedUpgradeId}/executing.lock

# 停止服务
echo "[2/5] 停止小智服务..."
systemctl --user stop xiaozhi
sleep 2

# 确认服务已停止
if systemctl --user is-active xiaozhi &>/dev/null; then
    echo "警告: 服务仍在运行，强制停止"
    systemctl --user kill xiaozhi
    sleep 2
fi

# 切换到目标版本
echo "[3/5] 切换到目标版本..."
cd ${escapedXiaozhiDir}
git checkout ${escapedToCommit}

# 编译
echo "[4/5] 编译新版本..."
npm run build

# 启动服务
echo "[5/5] 启动小智服务..."
systemctl --user start xiaozhi

# 健康检查
echo "执行健康检查..."
for i in {1..${this.config.healthCheckRetries}}; do
    sleep ${this.config.healthCheckInterval / 1000}

    if curl -s http://localhost:8081/health | grep -q '"status":"ok"'; then
        echo "健康检查通过!"

        # 写入成功标记
        echo '{"status":"success","completedAt":"'$(date -Iseconds)'"}' > ~/.xiaozhi/upgrades/${escapedUpgradeId}/result.json
        rm ~/.xiaozhi/upgrades/${escapedUpgradeId}/executing.lock

        echo "=========================================="
        echo "升级成功!"
        echo "=========================================="

        # 等待新版小智来关闭这个 tmux 会话
        echo "等待新版小智确认..."
        exit 0
    fi

    echo "健康检查第 $i 次尝试..."
done

# 健康检查失败，回滚
echo "健康检查失败，执行回滚..."
git checkout ${escapedFromCommit}
npm run build
systemctl --user restart xiaozhi

echo '{"status":"failed","error":"Health check failed","completedAt":"'$(date -Iseconds)'"}' > ~/.xiaozhi/upgrades/${escapedUpgradeId}/result.json
rm ~/.xiaozhi/upgrades/${escapedUpgradeId}/executing.lock

echo "=========================================="
echo "升级失败，已回滚"
echo "=========================================="
exit 1
`;

    return script;
  }

  /**
   * 保存升级脚本
   */
  async saveExecuteScript(record: UpgradeRecord): Promise<string> {
    const script = await this.generateExecuteScript(record);
    const scriptPath = path.join(this.config.upgradesDir, record.id, 'execute.sh');

    // 验证脚本路径在预期目录内
    if (!validateFilePath(scriptPath, this.config.upgradesDir)) {
      throw new Error(`脚本路径不在预期目录内: ${scriptPath}`);
    }

    await fs.writeFile(scriptPath, script, 'utf-8');
    // 修改权限为 700，只允许所有者执行
    await fs.chmod(scriptPath, 0o700);
    logger.info(`升级脚本已保存: ${scriptPath}`);
    return scriptPath;
  }

  /**
   * 清理当前记录
   */
  clearCurrentRecord(): void {
    this.currentRecord = null;
  }

  /**
   * 获取升级历史
   */
  async getHistory(limit: number = 10): Promise<UpgradeRecord[]> {
    try {
      const dirs = await fs.readdir(this.config.upgradesDir);
      const records: UpgradeRecord[] = [];

      for (const dir of dirs.slice(-limit)) {
        const record = await this.loadRecord(dir);
        if (record) {
          records.push(record);
        }
      }

      return records.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch (error) {
      return [];
    }
  }
}
