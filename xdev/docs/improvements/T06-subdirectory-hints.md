# T06 · 子目录上下文懒加载

> 参考: `~/data/hermes-agent/agent/subdirectory_hints.py`  
> 目标文件: 新建 `src/context/subdirectory-hints.ts`，修改 `src/core/agent-loop.ts`

---

## 问题背景

Agent 进入新子目录（如 `backend/src/`）工作时，不知道该子目录是否有 AGENTS.md、CLAUDE.md 等上下文指导文件。
通过懒加载发现并注入这些文件内容，避免在 system prompt 中预加载所有子目录文件（浪费 token）。

---

## Hermes 设计要点

```
- 追踪已访问目录（避免重复加载）
- 在工具调用后检查参数中的路径
- 向上最多5层查找：AGENTS.md, CLAUDE.md, .cursorrules
- 发现后内容附加到工具结果尾部（不修改 system prompt，保护 prompt cache）
- 最大 8000 字符/文件
- 扫描注入攻击模式（防止 prompt injection）
```

---

## 执行方案

### 1. 新建 `src/context/subdirectory-hints.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('subdir-hints');

const HINT_FILENAMES = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md', '.cursorrules'];
const MAX_HINT_CHARS = 8_000;
const MAX_ANCESTOR_WALK = 5;

// 工具参数中常见的路径字段名
const PATH_ARG_KEYS = new Set(['path', 'file_path', 'workdir', 'directory']);

// Prompt injection 威胁模式（扫描加载的上下文文件）
const CONTEXT_THREAT_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|above)\s+instructions?/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+(?:a|an)\s+\w/i,
  /forget\s+(?:all\s+)?(?:previous|your)\s+instructions?/i,
  /new\s+instructions?\s*:/i,
];

function isSafeContent(content: string): boolean {
  return !CONTEXT_THREAT_PATTERNS.some((p) => p.test(content));
}

export class SubdirectoryHintTracker {
  private workingDir: string;
  private loadedDirs = new Set<string>();

  constructor(workingDir?: string) {
    this.workingDir = path.resolve(workingDir ?? process.cwd());
    this.loadedDirs.add(this.workingDir); // 主目录已由 system prompt 加载
  }

  /**
   * 检查工具调用参数，若涉及新目录则加载上下文提示
   * @returns 要附加到工具结果的提示文本，或 null
   */
  checkToolCall(
    toolName: string,
    toolArgs: Record<string, any>,
  ): string | null {
    const dirs = this.extractDirectories(toolName, toolArgs);
    if (dirs.length === 0) return null;

    const allHints: string[] = [];
    for (const dir of dirs) {
      const hints = this.loadHintsForDir(dir);
      allHints.push(...hints);
    }

    return allHints.length > 0 ? '\n\n' + allHints.join('\n\n') : null;
  }

  private extractDirectories(toolName: string, toolArgs: Record<string, any>): string[] {
    const dirs = new Set<string>();

    // 从路径参数中提取目录
    for (const [key, value] of Object.entries(toolArgs)) {
      if (!PATH_ARG_KEYS.has(key) && !key.includes('path')) continue;
      if (typeof value !== 'string') continue;
      const resolved = path.resolve(this.workingDir, value);
      const dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
      dirs.add(dir);
    }

    // bash/shell 命令：提取 cd 目标
    if (toolName === 'bash' && typeof toolArgs.command === 'string') {
      const cdMatch = toolArgs.command.match(/\bcd\s+([^\s;&|]+)/);
      if (cdMatch) {
        const dir = path.resolve(this.workingDir, cdMatch[1]);
        dirs.add(dir);
      }
    }

    return Array.from(dirs);
  }

  private loadHintsForDir(targetDir: string): string[] {
    const hints: string[] = [];
    let current = path.resolve(targetDir);
    let stepsUp = 0;

    while (stepsUp <= MAX_ANCESTOR_WALK) {
      // 不加载超出工作目录范围的上下文
      if (!current.startsWith(this.workingDir)) break;

      if (!this.loadedDirs.has(current)) {
        for (const filename of HINT_FILENAMES) {
          const filePath = path.join(current, filename);
          if (!fs.existsSync(filePath)) continue;

          try {
            let content = fs.readFileSync(filePath, 'utf8');
            if (content.length > MAX_HINT_CHARS) {
              content = content.slice(0, MAX_HINT_CHARS) + '\n...[已截断]';
            }

            if (!isSafeContent(content)) {
              logger.warn(`跳过可疑上下文文件（可能含 prompt injection）: ${filePath}`);
              continue;
            }

            hints.push(`[来自 ${path.relative(this.workingDir, filePath)} 的上下文]\n${content}`);
            logger.debug(`加载子目录上下文: ${filePath}`);
          } catch (err: any) {
            logger.debug(`读取上下文文件失败: ${filePath}: ${err.message}`);
          }
        }
        this.loadedDirs.add(current);
      }

      const parent = path.dirname(current);
      if (parent === current) break; // 到达文件系统根部
      current = parent;
      stepsUp++;
    }

    return hints;
  }
}
```

### 2. 修改 `src/core/agent-loop.ts`

```typescript
import { SubdirectoryHintTracker } from '../context/subdirectory-hints';

// 在 agent loop 初始化时：
const hintTracker = new SubdirectoryHintTracker(process.cwd());

// 在工具执行完成后，处理 tool_result 时：
for (const toolResult of toolResults) {
  const hints = hintTracker.checkToolCall(toolResult.toolName, toolResult.toolArgs);
  if (hints) {
    // 将提示附加到工具结果内容末尾
    toolResult.content += hints;
  }
}
```

---

## 效果示例

```
用户: 帮我查看 backend/src/auth/ 目录结构
→ Agent 调用 bash: ls backend/src/auth/

→ hintTracker.checkToolCall('bash', { command: 'ls backend/src/auth/' })
→ 发现 backend/src/auth/ 未加载过
→ 查找 backend/src/auth/AGENTS.md → 找到！
→ 读取内容: "# 认证模块\n本模块负责 JWT 认证..."
→ 附加到 ls 命令结果末尾：

工具结果:
auth.ts  guards/  middleware/  types.ts

[来自 backend/src/auth/AGENTS.md 的上下文]
# 认证模块
本模块负责 JWT 认证...
```

---

## 注意事项

- 注入到 **工具结果**（不修改 system prompt），保护 prompt caching 效果
- `isSafeContent()` 扫描 prompt injection 攻击，发现威胁则跳过文件（记录 warning 日志）
- 同一目录只加载一次（`loadedDirs` 集合保护）
- 不加载 `.xdev/` 内部目录（通过 `startsWith(workingDir)` 校验限制范围）
