// src/tools/checkpoint-manager.ts
// 文件操作快照：基于影子 Git 仓库的 checkpoint 机制
// 参考: hermes-agent/tools/checkpoint_manager.py

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, ExecFileSyncOptions } from 'child_process';
import { createLogger } from '../utils/logger';

const logger = createLogger('checkpoint');
const CHECKPOINT_BASE = path.join(process.env.HOME!, '.xdev', 'checkpoints');
const MAX_CHECKPOINTS = 20;
const GIT_TIMEOUT_MS = 30_000;

const DEFAULT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  '.env',
  '.env.*',
  '__pycache__/',
  '*.log',
  '.cache/',
  'coverage/',
  '.git/',
];

export interface CheckpointInfo {
  hash: string;
  message: string;
  timestamp: number;
  filesChanged: number;
}

/** 计算工作目录对应的影子仓库路径，使用 sha256[:16] 作为唯一目录名 */
function shadowRepoPath(workingDir: string): string {
  const absPath = path.resolve(workingDir);
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  return path.join(CHECKPOINT_BASE, hash);
}

/** 构建 git 命令的环境变量（将 git 重定向到影子仓库，不污染用户项目 .git） */
function gitEnv(shadowRepo: string, workingDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: shadowRepo,
    GIT_WORK_TREE: path.resolve(workingDir),
  };
}

function runGit(
  args: string[],
  shadowRepo: string,
  workingDir: string,
): { ok: boolean; stdout: string; stderr: string } {
  const env = gitEnv(shadowRepo, workingDir);
  // 使用 execFileSync 而非 execSync(string)，args 直接传给 git 进程，不经过 shell 解释
  // 防止 commit message 中的 backtick/$() 被 shell 执行（shell 注入漏洞修复）
  const opts: ExecFileSyncOptions = {
    env,
    cwd: path.resolve(workingDir),
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: 'pipe',
  };
  try {
    const stdout = execFileSync('git', args, opts) as string;
    return { ok: true, stdout: (stdout as string).trim(), stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: err.stderr?.toString() ?? String(err) };
  }
}

export class CheckpointManager {
  private workingDir: string;
  private shadowRepo: string;
  private initialized = false;

  constructor(workingDir: string) {
    this.workingDir = path.resolve(workingDir);
    this.shadowRepo = shadowRepoPath(workingDir);
  }

  /** 初始化影子仓库（首次使用时懒加载） */
  private ensureInit(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.shadowRepo)) {
      fs.mkdirSync(this.shadowRepo, { recursive: true });
      runGit(['init', '--bare'], this.shadowRepo, this.workingDir);
      // 写入排除规则
      const excludePath = path.join(this.shadowRepo, 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.writeFileSync(excludePath, DEFAULT_EXCLUDES.join('\n'));
      // 记录原始工作目录
      fs.writeFileSync(path.join(this.shadowRepo, 'XDEV_WORKDIR'), this.workingDir);
      // 配置 git 用户信息
      runGit(['config', 'user.email', 'xdev@local'], this.shadowRepo, this.workingDir);
      runGit(['config', 'user.name', 'Xdev Checkpoint'], this.shadowRepo, this.workingDir);
    }
    this.initialized = true;
  }

  /**
   * 创建检查点快照
   * @param message 快照描述（通常是当前 agent loop 的任务摘要）
   * @returns 快照 commit hash，或 null（无变更时跳过）
   */
  async createCheckpoint(message: string = 'auto checkpoint'): Promise<string | null> {
    try {
      this.ensureInit();

      // git add -A（追踪所有变更）
      runGit(['add', '-A'], this.shadowRepo, this.workingDir);

      // 检查是否有变更（diff --cached --quiet 退出码 1 = 有变更，0 = 无变更）
      const diffResult = runGit(['diff', '--cached', '--quiet'], this.shadowRepo, this.workingDir);
      if (diffResult.ok) {
        logger.debug('无文件变更，跳过快照');
        return null;
      }

      // git commit（message 作为独立 arg 传给 execFileSync，无需 shell 转义）
      const safeMessage = message.slice(0, 200);
      const commitResult = runGit(
        ['commit', '-m', safeMessage, '--no-verify'],
        this.shadowRepo,
        this.workingDir,
      );

      if (!commitResult.ok) {
        logger.warn(`快照创建失败: ${commitResult.stderr}`);
        return null;
      }

      // 获取 commit hash
      const hashResult = runGit(['rev-parse', 'HEAD'], this.shadowRepo, this.workingDir);
      const hash = hashResult.stdout;

      logger.info(`检查点已创建: ${hash.slice(0, 8)} "${safeMessage}"`);

      // 清理旧检查点（保留最近 MAX_CHECKPOINTS 个）
      this.pruneOldCheckpoints();

      return hash;
    } catch (error: any) {
      logger.warn(`快照异常（静默忽略）: ${error.message}`);
      return null;
    }
  }

  /** 列出所有检查点 */
  listCheckpoints(): CheckpointInfo[] {
    try {
      this.ensureInit();
      const result = runGit(
        ['log', '--format=%H|%s|%ct', '--all'],
        this.shadowRepo,
        this.workingDir,
      );
      if (!result.ok || !result.stdout) return [];

      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|');
          return {
            hash: parts[0] ?? '',
            message: parts[1] ?? '',
            timestamp: parseInt(parts[2] ?? '0', 10) * 1000,
            filesChanged: 0,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * 回滚到指定检查点
   * @param commitHash 目标 commit hash（前8位即可）
   */
  async rollback(commitHash: string): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ensureInit();
      const result = runGit(
        ['checkout', commitHash, '--', '.'],
        this.shadowRepo,
        this.workingDir,
      );
      if (!result.ok) {
        return { ok: false, error: result.stderr };
      }
      logger.info(`已回滚到检查点 ${commitHash.slice(0, 8)}`);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  private pruneOldCheckpoints(): void {
    try {
      const result = runGit(['rev-list', 'HEAD'], this.shadowRepo, this.workingDir);
      if (!result.ok) return;
      const hashes = result.stdout.split('\n').filter(Boolean);
      if (hashes.length <= MAX_CHECKPOINTS) return;
      // 通过 gc 清理不可达对象（soft prune）
      runGit(['gc', '--quiet', '--prune=now'], this.shadowRepo, this.workingDir);
    } catch {
      // 非关键操作，忽略异常
    }
  }
}
