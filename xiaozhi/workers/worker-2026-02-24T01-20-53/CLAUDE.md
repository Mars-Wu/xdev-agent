# 小智记忆管理系统实现

## 任务
实现轻量版记忆管理系统，借鉴 Claude-mem 思路。

## 需要创建的文件

### 1. src/memory/memory-store.ts
SQLite 存储关键信息：
- decisions (决策)
- tasks (任务状态)
- preferences (用户偏好)
- modifications (代码修改记录)

### 2. src/memory/extractor.ts
从对话中提取关键信息：
- extractDecisions() - 提取决策
- extractTaskStatus() - 提取任务状态
- extractUserPreferences() - 提取用户偏好

### 3. 修改 src/worker/hooks-receiver.ts
在 Stop hook 时调用 extractor 提取信息

### 4. 修改 src/core/claude-native-agent.ts
会话开始时注入相关记忆到 system prompt

## 数据库 Schema
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  type TEXT,  -- decision/task/preference/modification
  content TEXT,
  tags TEXT,
  created_at DATETIME,
  last_accessed DATETIME
);

## 输出
完成代码实现并编译测试