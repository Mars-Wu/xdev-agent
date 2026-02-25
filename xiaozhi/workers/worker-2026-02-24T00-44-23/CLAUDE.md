# 轻量版记忆管理系统实现

## 背景
借鉴 Claude-mem 项目的思路，为小智实现一个轻量版的记忆管理系统。

## 已有基础
- src/session/context-manager.ts - 基础上下文压缩
- src/cli/context-cli.ts - CLI 工具

## 需要扩展的功能

### 1. 记忆存储 (Memory Storage)
创建 src/memory/memory-store.ts:
- 使用 SQLite 存储关键信息（决策、任务、用户偏好）
- 支持按时间、类型、标签检索
- 自动去重和合并相似记忆

### 2. 关键信息提取 (Key Info Extraction)
创建 src/memory/extractor.ts:
- 从对话中提取重要决策
- 提取任务状态和进度
- 提取用户偏好和习惯
- 提取代码修改记录

### 3. 记忆注入 (Memory Injection)
修改 src/core/claude-native-agent.ts:
- 在会话开始时注入相关记忆到 system prompt
- 根据当前话题检索相关历史
- 控制注入的记忆量（不超过 2000 tokens）

### 4. 自动触发
在 hooks-receiver 中集成:
- Stop hook: 提取本次会话的关键信息
- SessionEnd: 触发记忆整理和压缩

## 输出要求
1. 完整的 TypeScript 代码
2. 数据库 schema 设计
3. 与现有系统的集成代码
4. 使用文档