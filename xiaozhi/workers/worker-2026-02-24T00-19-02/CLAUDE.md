# 会话上下文管理实现

## 背景
小智使用 --continue 参数实现持久会话，会话文件存储在 ~/.claude/projects/-home-wxy--xiaozhi-workspace/*.jsonl
当前会话文件已达 1.2MB，712 行消息，会持续增长直到达到上下文限制。

## 任务
实现一个会话上下文管理模块，功能：
1. 监控会话文件大小
2. 当超过阈值（500KB 或 300 行）时自动摘要压缩
3. 保留关键信息：用户请求、重要决策、任务状态
4. 压缩旧对话为摘要

## 实现步骤
1. 创建 src/session/context-manager.ts
2. 实现 ContextManager 类
3. 提供压缩和摘要功能
4. 在主程序中集成

## 输出
完整的 TypeScript 代码实现