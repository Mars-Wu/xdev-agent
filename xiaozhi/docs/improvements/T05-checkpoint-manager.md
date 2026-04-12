# T05 · Checkpoint Manager（文件操作快照）

> 参考: `~/data/hermes-agent/tools/checkpoint_manager.py`（548行）  
> 目标文件: 新建 `src/tools/checkpoint-manager.ts`，修改 `src/core/agent-loop.ts`

---

## 问题背景

Agent 执行写文件、编辑文件操作时无法回滚。误操作（如覆盖正确文件）后难以恢复。
Hermes 使用"影子 Git 仓库"方案：对每个工作目录维护独立的 git 仓库，不污染用户项目的 .git。

---

## Hermes 架构设计

```
~/.xiaozhi/checkpoints/{sha256(abs_dir)[:16]}/   ← 影子 git 仓库
├── HEAD, refs/, objects/                          ← 标准 git 结构
├── XIAOZHI_WORKDIR                                ← 记录原始目录路径
└── info/exclude                                   ← 默认排除规则

使用 GIT_DIR + GIT_WORK_TREE 环境变量，git 状态不泄露到用户项目目录
每轮 Agent Loop 触发一次（非每次工具调用），避免频繁快照
```

---

## 执行方案

### 1. 新建 `src/tools/checkpoint-manager.ts`

```typescript
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, ExecSyncOptions } from 'child_process';
import { createLogger } from '../utils/logger';

const logger = createLogger('checkpoint');
const CHECKPOINT_BASE = path.join(process.env.HOME!, '.xiaozhi', 'checkpoints');
const MAX_CHECKPOINTS = 20;
const GIT_TIMEOUT_MS = 30_000;

const DEFAULT_EXCLUDES = [
  'node_modules/', 'dist/', 'build/', '.env', '.env.*',
  '__pycache__/', '*.log', '.cache/', 'coverage/', '.git/',
];

export interface CheckpointInfo {
  hash: string;
  message: string;
  timestamp: number;
  filesChanged: number;
}

/**
 * 计算工作目录对应的影子仓库路径
 * 使用 sha256(abs_path)[:16] 作为唯一目录名
 */
function shadowRepoPath(workingDir: string): string {
  const absPath = path.resolve(workingDir);
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  return path.join(CHECKPOINT_BASE, hash);
}

/**
 * 构建 git 命令的环境变量（将 git 重定向到影子仓库）
 */
function gitEnv(shadowRepo: string, workingDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: shadowRepo,
    GIT_WORK_TREE: path.resolve(workingDir),
    GIT_INDEX_FILE: undefined, // 使用默认 index
  };
}

function runGit(
  args: string[],
  shadowRepo: string,
  workingDir: string,
): { ok: boolean; stdout: string; stderr: string } {
  const env = gitEnv(shadowRepo, workingDir);
  const opts: ExecSyncOptions = {
    env,
    cwd: path.resolve(workingDir),
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: 'pipe',
  };
  try {
    const stdout = execSync(['git', ...args].join(' '), opts) as string;
    return { ok: true, stdout: stdout.trim(), stderr: '' };
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

  /** 初始化影子仓库（首次使用时调用） */
  private ensureInit(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.shadowRepo)) {
      fs.mkdirSync(this.shadowRepo, { recursive: true });
      runGit(['init', '--bare'], this.shadowRepo, this.workingDir);
      // 写入排除规则
      const excludePath = path.join(this.shadowRepo, 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.writeFileSync(excludePath, DEFAULT_EXCLUDES.join('\n'));
      // 记录工作目录
      fs.writeFileSync(path.join(this.shadowRepo, 'XIAOZHI_WORKDIR'), this.workingDir);
      // 配置 git 用户信息
      runGit(['config', 'user.email', 'xiaozhi@local'], this.shadowRepo, this.workingDir);
      runGit(['config', 'user.name', 'Xiaozhi Checkpoint'], this.shadowRepo, this.workingDir);
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

      // 检查是否有变更（diff --cached --quiet 退出码 1 = 有变更）
      const diffResult = runGit(['diff', '--cached', '--quiet'], this.shadowRepo, this.workingDir);
      if (diffResult.ok) {
        logger.debug('无文件变更，跳过快照');
        return null;
      }

      // git commit
      const commitResult = runGit(
        ['commit', '-m', message, '--no-verify'],
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

      logger.info(`检查点已创建: ${hash.slice(0, 8)} "${message}"`);

      // 清理旧检查点（保留最近 MAX_CHECKPOINTS 个）
      await this.pruneOldCheckpoints();

      return hash;
    } catch (error: any) {
      logger.warn(`快照异常（静默忽略）: ${error.message}`);
      return null;
    }
  }

  /**
   * 列出所有检查点
   */
  listCheckpoints(): CheckpointInfo[] {
    this.ensureInit();
    const result = runGit(
      ['log', '--format=%H|%s|%ct|%d', '--all'],
      this.shadowRepo,
      this.workingDir,
    );
    if (!result.ok) return [];

    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, message, timestamp] = line.split('|');
        return {
          hash,
          message: message ?? '',
          timestamp: parseInt(timestamp ?? '0', 10) * 1000,
          filesChanged: 0,
        };
      });
  }

  /**
   * 回滚到指定检查点
   */
  async rollback(commitHash: string): Promise<{ ok: boolean; error?: string }> {
    this.ensureInit();
    // 使用 git checkout 检出指定版本的所有文件
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
  }

  private async pruneOldCheckpoints(): Promise<void> {
    const result = runGit(['rev-list', 'HEAD'], this.shadowRepo, this.workingDir);
    if (!result.ok) return;
    const hashes = result.stdout.split('\n').filter(Boolean);
    if (hashes.length <= MAX_CHECKPOINTS) return;

    const toRemove = hashes.slice(MAX_CHECKPOINTS);
    for (const hash of toRemove) {
      // 使用 git replace 或直接 gc 清理
      runGit(['branch', '-D', hash.slice(0, 8)], this.shadowRepo, this.workingDir);
    }
    runGit(['gc', '--quiet', '--prune=now'], this.shadowRepo, this.workingDir);
  }
}
```

### 2. 修改 `src/core/agent-loop.ts`

每轮 loop 开始时创建检查点（若本轮有写操作）：

```typescript
import { CheckpointManager } from '../tools/checkpoint-manager';

// 在 agent loop 初始化时创建实例：
const checkpointMgr = new CheckpointManager(process.cwd());

// 在 while 循环顶部，上一轮工具执行完后：
// （只在检测到写操作时才创建）
if (hadWriteOperationLastRound) {
  const taskSummary = lastUserMessage.slice(0, 80);
  await checkpointMgr.createCheckpoint(`turn-${turnCount}: ${taskSummary}`);
}
```

### 3. 飞书命令支持

在消息处理中响应 `/checkpoint` 命令：
```
/checkpoint list           → 列出最近检查点
/checkpoint rollback <hash> → 回滚
```

---

## 注意事项

- 影子仓库不影响用户项目的 `.git` 目录（完全隔离）
- 对大型项目（> 50K 文件）跳过 `git add -A`，改为只追踪 agent 实际写过的文件
- `git gc` 需要定期运行，否则影子仓库会无限增大
- 检查点不包含 `.env`、`node_modules` 等（通过 `info/exclude` 排除）
