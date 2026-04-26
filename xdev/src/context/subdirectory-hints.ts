// src/context/subdirectory-hints.ts
// 子目录上下文懒加载：工具访问新目录时自动注入 XDEV.md/AGENTS.md
// 参考: hermes-agent/agent/subdirectory_hints.py

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('subdir-hints');

const HINT_FILENAMES = ['XDEV.md', 'xdev.md', 'AGENTS.md', 'agents.md', '.cursorrules'];
const MAX_HINT_CHARS = 8_000;
const MAX_ANCESTOR_WALK = 5;

// 工具参数中常见的路径字段名
const PATH_ARG_KEYS = new Set(['path', 'file_path', 'workdir', 'directory']);

// Prompt injection 威胁模式（防止恶意上下文文件劫持 Agent）
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
    // 主工作目录已在 system prompt 中加载，跳过
    this.loadedDirs.add(this.workingDir);
  }

  /**
   * 检查工具调用参数，若涉及新目录则加载上下文提示
   * 附加到工具结果末尾，不修改 system prompt（保护 prompt cache）
   * @returns 要附加的提示文本，或 null
   */
  checkToolCall(toolName: string, toolArgs: Record<string, unknown>): string | null {
    const dirs = this.extractDirectories(toolName, toolArgs);
    if (dirs.length === 0) return null;

    const allHints: string[] = [];
    for (const dir of dirs) {
      const hints = this.loadHintsForDir(dir);
      allHints.push(...hints);
    }

    return allHints.length > 0 ? '\n\n' + allHints.join('\n\n') : null;
  }

  private extractDirectories(toolName: string, toolArgs: Record<string, unknown>): string[] {
    const dirs = new Set<string>();

    // 从路径参数中提取目录
    for (const [key, value] of Object.entries(toolArgs)) {
      if (!PATH_ARG_KEYS.has(key) && !key.includes('path')) continue;
      if (typeof value !== 'string') continue;
      try {
        const resolved = path.resolve(this.workingDir, value);
        let dir: string;
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          dir = resolved;
        } else {
          dir = path.dirname(resolved);
        }
        dirs.add(dir);
      } catch {
        // 路径解析失败忽略
      }
    }

    // bash 命令：提取 cd 目标目录
    if (toolName === 'bash' && typeof toolArgs.command === 'string') {
      const cdMatch = toolArgs.command.match(/\bcd\s+([^\s;&|]+)/);
      if (cdMatch) {
        try {
          const dir = path.resolve(this.workingDir, cdMatch[1]);
          dirs.add(dir);
        } catch {
          // 忽略
        }
      }
    }

    return Array.from(dirs);
  }

  private loadHintsForDir(targetDir: string): string[] {
    const hints: string[] = [];
    let current = path.resolve(targetDir);
    let stepsUp = 0;

    while (stepsUp <= MAX_ANCESTOR_WALK) {
      // 只加载工作目录范围内的上下文（防止越界加载）
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

            const relPath = path.relative(this.workingDir, filePath);
            hints.push(`[来自 ${relPath} 的上下文]\n${content}`);
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
