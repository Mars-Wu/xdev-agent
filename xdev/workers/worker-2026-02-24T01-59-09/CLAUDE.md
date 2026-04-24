整合上下文管理和记忆管理系统。

当前有两个独立系统:
1. src/session/context-manager.ts - 会话文件压缩
2. src/memory/ - 记忆存储和提取

需要整合:
1. 修改 context-manager.ts，在压缩前调用 memoryExtractor 提取关键信息
2. 修改 context-cli.ts，xdev-context stats 同时显示记忆统计
3. 在 hooks-receiver.ts 的 handleComplete 中检查会话大小，超过阈值自动压缩

请先阅读现有代码，然后实现整合。