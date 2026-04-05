# Phase 4：话题感知上下文路由系统 — 完整实施计划

> **版本**：v1.0  
> **日期**：2026-04  
> **背景**：当前 `handleMessage()` 使用单一全局 `MessageHistoryManager`（1000条/18万token），长期运行导致跨话题上下文污染。典型案例：TqQuant（Python量化）被误答为 TypeScript AI 项目。  
> **目标**：引入话题级别的上下文隔离，流水线上的所有判断尽量由 LLM 完成，减少硬编码规则。

---

## 零、当前状态确认

### 已完成（Phase 0-3）
- ✅ `runAgentLoop` 带工具调用的完整循环（agent-loop.ts）
- ✅ `MessageHistoryManager` 压缩/micro-compact（message-history.ts）
- ✅ `MemoryManager` 含 `searchRelevant()`、tags、importance（memory-manager.ts）
- ✅ 飞书 post 富文本回复
- ✅ 工具系统：bash/file/grep/glob/todo/task/web/browser

### Phase 4 需要新建/修改的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/message-history.ts` | 修改 | 增加 `serialize()` / `deserialize()` |
| `src/storage/topic-graph.ts` | 新建 | 话题图 SQLite 操作层 |
| `src/core/message-router.ts` | 新建 | Stage 1：glm-4-flash 路由 + context 组装 |
| `src/tools/topic-tools.ts` | 新建 | `save_memory` / `update_topic_summary` 工具 |
| `src/core/background-memory.ts` | 新建 | 后台 LLM Pass（异步，不阻塞回复）|
| `src/index.ts` | 修改 | `handleMessage()` 接入 3 阶段流水线 |
| `src/core/agent-loop.ts` | 修改 | 注入 topicId，loop 后触发 background pass |
| `tests/phase4/` | 新建 | 所有单元测试 + 集成测试 |

---

## 一、整体流水线设计

```
飞书消息到达
  │
  ▼
[Stage 1] Router + Assembler（glm-4-flash + 纯代码组装，~160ms）
  ├─ 输入：最近 N 条话题摘要列表 + 用户原始消息
  ├─ LLM 输出（JSON）：topicId, historyStrategy, historyHint,
  │                   relatedTopicIds, entityTags, confidence
  └─ 纯代码立即执行：
       ├─ 按 historyStrategy 加载 topic history bucket
       ├─ 注入相关话题摘要（轻量文本）
       ├─ 注入 ~/data/ 动态目录列表
       ├─ 按 topicId 召回 episodic memory（few-shot 示例）
       └─ 组装最终 { systemPrompt, messages }
  │
  ▼
[Stage 2] Main Agent Loop（GLM-5，N轮工具调用）
  ├─ 工具调用正常执行（现有逻辑不变）
  ├─ 追加每轮对话到 topic history bucket（替代全局 historyManager）
  ├─ 主 LLM 按需调用：
  │    save_memory({ content, type, importance })     ← 语义/情节记忆热路径写入
  │    update_topic_summary({ summary })              ← 话题摘要热路径更新
  └─ loop 结束，返回 finalReply 和 executionTrace
  │
  ▼
[Stage 3] 飞书回复（立即执行，不等待后台任务）
  │
  └─→（异步触发，不阻塞）
[Background Pass] 后台 LLM（glm-4-flash，对话结束后异步执行）
  ├─ 输入：Stage 2 执行摘要（executionTrace 压缩版）
  ├─ LLM 输出：新实体标签、话题图关系更新建议、episodic pattern
  └─ 写入：话题图 edges + MemoryManager（episodic 类型）
```

### 关键设计原则
1. **判断由 LLM 做**：路由分类、实体提取、关系权重、记忆写入时机——全部由 LLM 输出
2. **代码只做 I/O**：context 拼接、磁盘读写、工具注册——不做语义判断
3. **不阻塞回复**：Background Pass 在 Stage 3 之后异步执行

---

## 二、实施任务详情

### 4-A：MessageHistoryManager 序列化（前置依赖）

**目标**：支持将 history 按话题分桶持久化到磁盘，服务重启后恢复。

**修改文件**：`src/core/message-history.ts`

**新增方法**：
```typescript
// 序列化当前 history 为 JSON 字符串
serialize(): string

// 从 JSON 字符串恢复 history（替换当前内容）
deserialize(json: string): void

// 清空所有消息（用于话题切换时的重置）
clear(): void

// 获取当前消息数量和 token 估算
stats(): { messageCount: number; estimatedTokens: number }
```

**存储路径**：`~/.xiaozhi/topics/{topicId}/history.json`

**配置参数**（话题 bucket 的限制，小于全局）：
```typescript
const TOPIC_HISTORY_CONFIG = {
  maxMessages: 200,    // 全局是 1000
  maxTokens: 60_000,  // 全局是 180_000
  preserveRecent: 5,
}
```

---

### 4-B：话题图存储层

**目标**：以 SQLite 存储话题元数据、话题间关系、流水线日志。

**新建文件**：`src/storage/topic-graph.ts`

**Schema**：
```sql
CREATE TABLE IF NOT EXISTS topics (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,          -- project_query/code_task/general_chat/other
  title             TEXT,
  summary           TEXT,                  -- 1-2句，供 Stage 1 LLM 读取
  entity_tags       TEXT DEFAULT '[]',     -- JSON数组，如 ["TqQuant","天勤行情"]
  turn_count        INTEGER DEFAULT 0,
  summary_updated_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  status            TEXT DEFAULT 'active'  -- active/archived
);

CREATE TABLE IF NOT EXISTS topic_relations (
  from_topic  TEXT NOT NULL,
  to_topic    TEXT NOT NULL,
  relation    TEXT NOT NULL,               -- LLM 自然语言描述，如"同一用户的相关项目"
  weight      REAL DEFAULT 1.0,            -- 0~1，由 Background LLM 给出
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (from_topic, to_topic)
);

CREATE TABLE IF NOT EXISTS pipeline_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  msg_preview      TEXT,                   -- 消息前50字
  topic_id         TEXT,
  is_new_topic     INTEGER DEFAULT 0,
  confidence       REAL,
  history_strategy TEXT,
  context_tokens   INTEGER,
  turn_count       INTEGER,
  bg_pass_done     INTEGER DEFAULT 0       -- background pass 是否完成
);
```

**主要方法**：
```typescript
class TopicGraph {
  // 获取活跃话题摘要列表（Stage 1 输入）
  getActiveSummaries(limit?: number): Promise<TopicSummary[]>

  // 获取或创建话题
  getOrCreate(topicId: string, type: string): Promise<Topic>

  // 更新话题摘要（热路径工具调用）
  updateSummary(topicId: string, summary: string, entityTags?: string[]): Promise<void>

  // 加载话题 history（从磁盘）
  loadHistory(topicId: string): Promise<MessageHistoryManager>

  // 保存话题 history（到磁盘）
  saveHistory(topicId: string, history: MessageHistoryManager): Promise<void>

  // 写入话题图关系（Background LLM 调用）
  upsertRelation(from: string, to: string, relation: string, weight: number): Promise<void>

  // 写入流水线日志
  logPipeline(entry: PipelineLogEntry): Promise<void>
}
```

---

### 4-C：消息路由器（Stage 1）

**目标**：用 glm-4-flash 在独立、干净的上下文中分类消息，然后纯代码组装 context。

**新建文件**：`src/core/message-router.ts`

**Stage 1 完整流程**：

```typescript
export interface RouteResult {
  topicId: string           // 如 "T1"、"T_1743800000_abc"（新话题）
  isNewTopic: boolean
  historyStrategy: 'full' | 'recent_20' | 'summary_only' | 'none'
  historyHint: string       // LLM 自述选择原因，供调试
  relatedTopicIds: string[]
  entityTags: string[]
  confidence: number        // 0~1
}

export interface AssembledContext {
  systemPrompt: string      // 含动态目录 + episodic few-shot
  messages: Message[]       // topic history（已按 historyStrategy 筛选）
  topicId: string
  route: RouteResult
}

export async function routeAndAssemble(
  userMessage: string,
  topicGraph: TopicGraph,
  llmClient: LLMClient,
  memoryManager: MemoryManager,
): Promise<AssembledContext>
```

**Stage 1 LLM Prompt 设计**：

System（固定，可被 prompt cache）：
```
你是消息分类路由器。根据已知话题列表和用户消息，判断：
1. 消息属于哪个已知话题（或是否是新话题）
2. 消息中提到的实体（项目名、路径、专有名词）
3. 与其他话题的关联
4. 需要注入的 history 范围

historyStrategy 选项：
- "full"：话题连续进行中（置信度高且话题最近活跃 <2小时）
- "recent_20"：话题有间隔（最近24小时内）
- "summary_only"：话题较久（>24小时），只注入摘要
- "none"：新话题，干净 context

只输出 JSON，不作任何解释。
```

User（每次动态构建）：
```
已知话题（最近活跃优先）：
[T1] 类型:code_task  摘要:"开发小智AI助手，TypeScript+飞书"
     实体:["xiaozhi","feishu"]  最近活跃:30分钟前  轮次:156
[T3] 类型:project_query  摘要:"Python量化交易系统TqQuant调研"
     实体:["TqQuant","天勤行情","TQSDK"]  最近活跃:3天前  轮次:8

用户消息：{userMessage}

输出格式：
{
  "topicId": "T3",
  "isNewTopic": false,
  "historyStrategy": "summary_only",
  "historyHint": "TqQuant话题3天前有记录，间隔较长，注入摘要即可避免污染",
  "relatedTopicIds": [],
  "entityTags": ["TqQuant", "TQSDK"],
  "confidence": 0.95
}
```

**Context 组装（纯代码）**：
```typescript
async function assembleContext(route: RouteResult, topicGraph: TopicGraph, ...) {
  // 1. 加载 topic history
  const topicHistory = await topicGraph.loadHistory(route.topicId);
  const messages = selectMessages(topicHistory, route.historyStrategy);

  // 2. 注入相关话题摘要（轻量）
  if (route.relatedTopicIds.length > 0) {
    const relatedSummaries = await topicGraph.getSummaries(route.relatedTopicIds);
    // 注入到 system prompt 末尾
  }

  // 3. 动态注入 ~/data/ 目录列表
  const dataDir = await readDataDirectory();

  // 4. 召回 episodic memory（相似任务的历史解决路径）
  const episodics = await memoryManager.searchRelevant(
    route.entityTags.join(' '), { type: 'episodic', limit: 2 }
  );

  // 5. 组装 systemPrompt
  const systemPrompt = buildSystemPrompt({ dataDir, episodics, relatedSummaries });

  return { systemPrompt, messages, topicId: route.topicId, route };
}
```

---

### 4-D：热路径记录工具

**目标**：主 LLM 在 Stage 2 loop 中自主决定何时写入记忆和更新话题摘要。

**新建文件**：`src/tools/topic-tools.ts`

**工具 1：`save_memory`**
```typescript
{
  name: 'save_memory',
  description: `将重要信息永久存入长期记忆。当你发现：
    - 关于某个项目/系统的重要技术事实
    - 用户的偏好或习惯
    - 某类问题的有效解决方案（episodic）
    - 需要跨话题共享的知识
    时调用此工具。普通对话不需要调用。`,
  inputSchema: {
    content: { type: 'string', description: '要记住的内容，1-3句' },
    type: { enum: ['semantic', 'episodic'], description: 'semantic=事实知识，episodic=解决过程' },
    importance: { type: 'number', minimum: 1, maximum: 10, description: '重要性评分' },
    entityTags: { type: 'array', items: { type: 'string' }, description: '相关实体标签' },
  }
}
```

**工具 2：`update_topic_summary`**
```typescript
{
  name: 'update_topic_summary',
  description: `更新当前话题的摘要描述。在完成一个完整的子任务后调用，
    帮助将来的路由器正确识别此话题。`,
  inputSchema: {
    summary: { type: 'string', description: '话题摘要，1-2句，简洁描述话题内容' },
    entityTags: { type: 'array', items: { type: 'string' }, description: '话题涉及的主要实体' },
  }
}
```

**注入上下文（自动，LLM 无需填写）**：
- topicId：从 pipeline context 自动注入
- userId：从当前 session 自动注入

**触发建议**（写入 tool description，引导 LLM）：
- 发现重要技术事实 → 调用 `save_memory(type=semantic)`
- 完成一个完整解决过程 → 调用 `save_memory(type=episodic)` + `update_topic_summary`
- 普通闲聊/简单问答 → 不调用

---

### 4-E：handleMessage 接入流水线

**目标**：将 `handleMessage()` 改造为 3 阶段流水线，保持错误处理和用户体验不变。

**修改文件**：`src/index.ts`

**改造前**：
```typescript
historyManager.addMessage({ role: 'user', content: ... });
const systemPrompt = await buildSystemPrompt(storage);
const replyText = await runAgentLoop(llmClient, historyManager, systemPrompt, toolRegistry);
```

**改造后**：
```typescript
// Stage 1：路由 + 组装
const context = await routeAndAssemble(
  msg.content, topicGraph, llmClient, memoryManager
);

// 创建话题专属 historyManager（从 bucket 加载）
const topicHistory = context.topicHistory;
topicHistory.addMessage({ role: 'user', content: `[主人@飞书] ${msg.content}` });

// Stage 2：Agent Loop（注入 topicId）
const { replyText, trace } = await runAgentLoop(
  llmClient, topicHistory, context.systemPrompt, toolRegistry,
  { topicId: context.topicId }
);

// 保存 topic history bucket
await topicGraph.saveHistory(context.topicId, topicHistory);

// Stage 3：飞书回复（立即）
await feishuClient.sendMessage(msg.chatId, { content: replyText, type: 'post' });

// Background Pass（异步，不阻塞）
triggerBackgroundPass(trace, context.route, topicGraph, memoryManager, llmClient);
```

**降级策略**：若 Stage 1 路由失败（超时/API错误），自动降级为当前全局 historyManager 行为（保持服务可用）。

---

### 4-F：后台 LLM Pass

**目标**：对话结束后异步分析执行过程，由 LLM 提取实体/关系/情节记忆，不阻塞回复。

**新建文件**：`src/core/background-memory.ts`

**触发条件**：每次 Stage 2 完成后触发，用 `setImmediate` 或 `Promise` 不 `await`。

**Background LLM Prompt**：

System（固定）：
```
你是记忆整理助手。分析一次对话的执行摘要，提取值得记录的信息。
只输出 JSON，不作任何解释。
```

User（动态，压缩版 trace）：
```
话题ID：T3
话题类型：project_query
执行摘要（工具调用列表）：
  1. read_file(/data/TqQuant/README.md) → 成功
  2. bash(find /data/TqQuant -name "*.py" | head -20) → 找到20个Python文件
  3. read_file(/data/TqQuant/strategy/ma_cross.py) → 成功

最终回复要点：TqQuant是Python量化交易系统，使用TQSDK连接天勤行情，实现均线交叉策略

请输出：
{
  "newEntityTags": ["TqQuant", "TQSDK", "天勤行情", "均线交叉策略"],
  "topicRelations": [
    {
      "toTopicId": "T1",
      "relation": "同一用户的不同技术项目，语言不同",
      "weight": 0.3
    }
  ],
  "episodicPattern": {
    "patternType": "project_code_review",
    "approach": "先读README了解整体，再find定位文件，再读关键策略文件",
    "outcome": "success",
    "shouldSave": true
  }
}
```

**写入操作**（纯代码，Background LLM 只做判断）：
- `newEntityTags` → `topicGraph.updateEntityTags(topicId, tags)`
- `topicRelations` → `topicGraph.upsertRelation(...)`
- `episodicPattern.shouldSave === true` → `memoryManager.save(episodic)`

---

## 三、测试用例

### 3.1 单元测试：MessageHistoryManager 序列化（4-A）

**文件**：`src/core/message-history.test.ts`（追加）

```typescript
describe('MessageHistoryManager 序列化', () => {
  test('serialize/deserialize 往返一致', () => {
    const h = new MessageHistoryManager({ maxMessages: 50 });
    h.addMessage({ role: 'user', content: '你好' });
    h.addMessage({ role: 'assistant', content: '你好！有什么需要帮助的？' });

    const json = h.serialize();
    const h2 = new MessageHistoryManager({ maxMessages: 50 });
    h2.deserialize(json);

    expect(h2.getMessages()).toHaveLength(2);
    expect(h2.getMessages()[0].content).toBe('你好');
    expect(h2.stats().messageCount).toBe(2);
  });

  test('deserialize 空字符串不报错，清空 history', () => {
    const h = new MessageHistoryManager();
    h.addMessage({ role: 'user', content: '测试' });
    h.deserialize('[]');
    expect(h.getMessages()).toHaveLength(0);
  });

  test('deserialize 后保留原有 config（maxMessages 等）', () => {
    const h = new MessageHistoryManager({ maxMessages: 10 });
    const json = new MessageHistoryManager({ maxMessages: 50 }).serialize();
    h.deserialize(json);
    // config 不被序列化内容覆盖
    expect((h as any).config.maxMessages).toBe(10);
  });

  test('clear() 清空所有消息', () => {
    const h = new MessageHistoryManager();
    h.addMessage({ role: 'user', content: '消息1' });
    h.addMessage({ role: 'user', content: '消息2' });
    h.clear();
    expect(h.getMessages()).toHaveLength(0);
    expect(h.stats().estimatedTokens).toBe(0);
  });
});
```

---

### 3.2 单元测试：话题图存储层（4-B）

**文件**：`src/storage/topic-graph.test.ts`（新建）

```typescript
describe('TopicGraph', () => {
  let graph: TopicGraph;
  const testDbPath = '/tmp/test-topic-graph.db';

  beforeEach(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    graph = new TopicGraph(testDbPath);
    await graph.init();
  });

  afterEach(() => graph.close());

  test('getOrCreate 创建新话题', async () => {
    const topic = await graph.getOrCreate('T1', 'code_task');
    expect(topic.id).toBe('T1');
    expect(topic.type).toBe('code_task');
    expect(topic.status).toBe('active');
  });

  test('getOrCreate 幂等，重复调用不报错', async () => {
    await graph.getOrCreate('T1', 'code_task');
    const topic2 = await graph.getOrCreate('T1', 'code_task');
    expect(topic2.id).toBe('T1');
  });

  test('updateSummary 更新摘要和实体标签', async () => {
    await graph.getOrCreate('T3', 'project_query');
    await graph.updateSummary('T3', 'Python量化交易系统', ['TqQuant', 'TQSDK']);
    const summaries = await graph.getActiveSummaries();
    const t3 = summaries.find(s => s.id === 'T3');
    expect(t3?.summary).toBe('Python量化交易系统');
    expect(t3?.entityTags).toContain('TqQuant');
  });

  test('getActiveSummaries 返回 active 状态话题，按更新时间降序', async () => {
    await graph.getOrCreate('T1', 'code_task');
    await graph.getOrCreate('T2', 'general_chat');
    await graph.getOrCreate('T3', 'project_query');
    const summaries = await graph.getActiveSummaries(2);
    expect(summaries).toHaveLength(2);
  });

  test('upsertRelation 写入和覆盖', async () => {
    await graph.getOrCreate('T1', 'code_task');
    await graph.getOrCreate('T3', 'project_query');
    await graph.upsertRelation('T1', 'T3', '同一用户项目群', 0.4);
    await graph.upsertRelation('T1', 'T3', '同一用户项目群，技术栈不同', 0.5);
    // 覆盖成功，只有1条记录
    const relations = await graph.getRelations('T1');
    expect(relations).toHaveLength(1);
    expect(relations[0].weight).toBe(0.5);
  });

  test('loadHistory 话题不存在时返回空 history', async () => {
    const history = await graph.loadHistory('T_nonexistent');
    expect(history.getMessages()).toHaveLength(0);
  });

  test('saveHistory + loadHistory 往返一致', async () => {
    const h = new MessageHistoryManager({ maxMessages: 200 });
    h.addMessage({ role: 'user', content: 'TqQuant 是什么' });
    h.addMessage({ role: 'assistant', content: 'TqQuant 是Python量化交易框架' });

    await graph.saveHistory('T3', h);
    const loaded = await graph.loadHistory('T3');
    expect(loaded.getMessages()).toHaveLength(2);
    expect(loaded.getMessages()[1].content).toContain('TqQuant');
  });

  test('logPipeline 写入流水线日志', async () => {
    await graph.logPipeline({
      ts: Date.now(), msgPreview: '查看TqQuant', topicId: 'T3',
      isNewTopic: false, confidence: 0.95, historyStrategy: 'summary_only',
      contextTokens: 1200, turnCount: 3
    });
    // 不抛出即通过
  });
});
```

---

### 3.3 单元测试：消息路由器（4-C）

**文件**：`src/core/message-router.test.ts`（新建）

```typescript
describe('MessageRouter - routeAndAssemble', () => {
  // Mock glm-4-flash 返回
  const mockLLMClient = {
    chatSync: vi.fn(),
  };

  const mockTopicGraph = {
    getActiveSummaries: vi.fn(),
    getOrCreate: vi.fn(),
    loadHistory: vi.fn(),
    saveHistory: vi.fn(),
  };

  const mockMemoryManager = {
    searchRelevant: vi.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTopicGraph.getActiveSummaries.mockResolvedValue([
      {
        id: 'T1', type: 'code_task', summary: '开发小智AI助手，TypeScript+飞书',
        entityTags: ['xiaozhi', 'feishu'], updatedAt: Date.now() - 30 * 60 * 1000
      },
      {
        id: 'T3', type: 'project_query', summary: 'Python量化交易系统TqQuant调研',
        entityTags: ['TqQuant', 'TQSDK'], updatedAt: Date.now() - 3 * 86400 * 1000
      }
    ]);
    mockTopicGraph.loadHistory.mockResolvedValue(new MessageHistoryManager());
  });

  test('正确路由到已有话题 T3（核心场景：TqQuant）', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'T3', isNewTopic: false,
        historyStrategy: 'summary_only',
        historyHint: 'TqQuant话题3天前有记录，间隔较长，只注入摘要',
        relatedTopicIds: [], entityTags: ['TqQuant'], confidence: 0.95
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      'TqQuant 的主要功能是什么？',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.topicId).toBe('T3');
    expect(result.route.historyStrategy).toBe('summary_only');
    expect(result.route.confidence).toBeGreaterThan(0.9);
    // 确保未注入全局 history（xiaozhi 相关内容不应出现）
    const allContent = JSON.stringify(result.messages);
    expect(allContent).not.toContain('xiaozhi');
  });

  test('新消息路由到新话题', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'new:general_chat', isNewTopic: true,
        historyStrategy: 'none',
        historyHint: '未发现匹配话题，创建新话题',
        relatedTopicIds: [], entityTags: [], confidence: 0.8
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      '今天天气怎么样？',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.route.isNewTopic).toBe(true);
    expect(result.messages).toHaveLength(0); // 新话题，空 messages
  });

  test('historyStrategy=full 时加载完整 history', async () => {
    const fullHistory = new MessageHistoryManager();
    for (let i = 0; i < 15; i++) {
      fullHistory.addMessage({ role: 'user', content: `消息${i}` });
      fullHistory.addMessage({ role: 'assistant', content: `回复${i}` });
    }
    mockTopicGraph.loadHistory.mockResolvedValue(fullHistory);

    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'T1', isNewTopic: false, historyStrategy: 'full',
        historyHint: '话题30分钟内活跃', relatedTopicIds: [],
        entityTags: ['xiaozhi'], confidence: 0.99
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      '继续刚才的开发工作',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.messages.length).toBe(30); // 15对
  });

  test('historyStrategy=recent_20 时只取最近20条', async () => {
    const history = new MessageHistoryManager();
    for (let i = 0; i < 25; i++) {
      history.addMessage({ role: 'user', content: `u${i}` });
    }
    mockTopicGraph.loadHistory.mockResolvedValue(history);

    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'T1', isNewTopic: false, historyStrategy: 'recent_20',
        historyHint: '话题近24小时内', relatedTopicIds: [],
        entityTags: [], confidence: 0.85
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      '继续上午的工作',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.messages.length).toBeLessThanOrEqual(20);
  });

  test('LLM 路由失败时降级为空 context（不抛出）', async () => {
    mockLLMClient.chatSync.mockRejectedValue(new Error('API timeout'));

    const result = await routeAndAssemble(
      '任意消息',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    // 降级：使用 fallback topicId，空 messages
    expect(result.topicId).toBe('fallback');
    expect(result.messages).toHaveLength(0);
  });

  test('LLM 返回非 JSON 时降级（不抛出）', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: '抱歉我无法判断', toolCalls: []
    });

    const result = await routeAndAssemble(
      '任意消息',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.topicId).toBe('fallback');
  });

  test('systemPrompt 中包含 ~/data/ 动态目录', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'T1', isNewTopic: false, historyStrategy: 'full',
        historyHint: '', relatedTopicIds: [], entityTags: [], confidence: 0.9
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      '查看项目列表',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.systemPrompt).toContain('/data/');
  });

  test('episodic memory 注入到 systemPrompt', async () => {
    mockMemoryManager.searchRelevant.mockResolvedValue([{
      content: '调研未知项目时：先读README，再find入口，再分析核心逻辑',
      type: 'episodic', importance: 8
    }]);

    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        topicId: 'T3', isNewTopic: false, historyStrategy: 'summary_only',
        historyHint: '', relatedTopicIds: [], entityTags: ['TqQuant'], confidence: 0.9
      }),
      toolCalls: []
    });

    const result = await routeAndAssemble(
      '帮我分析 TqQuant 的架构',
      mockTopicGraph as any, mockLLMClient as any, mockMemoryManager as any
    );

    expect(result.systemPrompt).toContain('先读README');
  });
});
```

---

### 3.4 单元测试：热路径记录工具（4-D）

**文件**：`src/tools/topic-tools.test.ts`（新建）

```typescript
describe('topic-tools', () => {
  let tools: ToolRegistry;
  let mockMemoryManager: any;
  let mockTopicGraph: any;

  beforeEach(() => {
    mockMemoryManager = {
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockTopicGraph = {
      updateSummary: vi.fn().mockResolvedValue(undefined),
    };

    tools = createTopicTools(mockMemoryManager, mockTopicGraph, 'T3');
  });

  describe('save_memory', () => {
    test('semantic 类型调用 memoryManager.save', async () => {
      const tool = tools.get('save_memory');
      await tool.execute({
        content: 'TqQuant 使用 TQSDK 连接天勤行情',
        type: 'semantic',
        importance: 8,
        entityTags: ['TqQuant', 'TQSDK'],
      });

      expect(mockMemoryManager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'semantic',
          content: 'TqQuant 使用 TQSDK 连接天勤行情',
          importance: 8,
          tags: expect.arrayContaining(['TqQuant', 'TQSDK', 'T3']),
        })
      );
    });

    test('episodic 类型正确写入', async () => {
      const tool = tools.get('save_memory');
      await tool.execute({
        content: '调研TqQuant时：先读README确认框架，再查Python入口，再分析策略文件',
        type: 'episodic',
        importance: 7,
        entityTags: ['project_query'],
      });

      expect(mockMemoryManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'episodic' })
      );
    });

    test('importance 超出范围时被 clamp 到 1-10', async () => {
      const tool = tools.get('save_memory');
      await tool.execute({ content: '测试', type: 'semantic', importance: 15 });
      expect(mockMemoryManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ importance: 10 })
      );
    });
  });

  describe('update_topic_summary', () => {
    test('调用 topicGraph.updateSummary', async () => {
      const tool = tools.get('update_topic_summary');
      await tool.execute({
        summary: 'Python量化交易系统，TQSDK接入天勤行情',
        entityTags: ['TqQuant', 'TQSDK', '天勤行情'],
      });

      expect(mockTopicGraph.updateSummary).toHaveBeenCalledWith(
        'T3',
        'Python量化交易系统，TQSDK接入天勤行情',
        ['TqQuant', 'TQSDK', '天勤行情']
      );
    });

    test('summary 过长时截断（不超过 200 字符）', async () => {
      const tool = tools.get('update_topic_summary');
      const longSummary = '长'.repeat(300);
      await tool.execute({ summary: longSummary });
      const [, actualSummary] = mockTopicGraph.updateSummary.mock.calls[0];
      expect(actualSummary.length).toBeLessThanOrEqual(200);
    });
  });
});
```

---

### 3.5 单元测试：后台 LLM Pass（4-F）

**文件**：`src/core/background-memory.test.ts`（新建）

```typescript
describe('BackgroundMemoryPass', () => {
  const mockLLMClient = { chatSync: vi.fn() };
  const mockTopicGraph = {
    upsertRelation: vi.fn(),
    updateEntityTags: vi.fn(),
    markBgPassDone: vi.fn(),
  };
  const mockMemoryManager = { save: vi.fn() };

  test('正确解析 LLM 输出并写入话题图', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        newEntityTags: ['TqQuant', 'TQSDK', '均线交叉'],
        topicRelations: [{ toTopicId: 'T1', relation: '同一用户不同技术项目', weight: 0.3 }],
        episodicPattern: {
          patternType: 'project_code_review',
          approach: '先读README，再find文件，再分析核心策略',
          outcome: 'success',
          shouldSave: true
        }
      }),
      toolCalls: []
    });

    await runBackgroundPass(
      { topicId: 'T3', executionSummary: '...' },
      mockLLMClient as any, mockTopicGraph as any, mockMemoryManager as any
    );

    expect(mockTopicGraph.updateEntityTags).toHaveBeenCalledWith('T3', expect.arrayContaining(['TqQuant']));
    expect(mockTopicGraph.upsertRelation).toHaveBeenCalledWith('T3', 'T1', '同一用户不同技术项目', 0.3);
    expect(mockMemoryManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'episodic' })
    );
  });

  test('LLM 返回 shouldSave=false 时不写入 episodic', async () => {
    mockLLMClient.chatSync.mockResolvedValue({
      content: JSON.stringify({
        newEntityTags: [],
        topicRelations: [],
        episodicPattern: { shouldSave: false }
      }),
      toolCalls: []
    });

    await runBackgroundPass(
      { topicId: 'T3', executionSummary: '...' },
      mockLLMClient as any, mockTopicGraph as any, mockMemoryManager as any
    );

    expect(mockMemoryManager.save).not.toHaveBeenCalled();
  });

  test('LLM 失败不抛出（后台任务不影响主流程）', async () => {
    mockLLMClient.chatSync.mockRejectedValue(new Error('timeout'));
    await expect(
      runBackgroundPass({ topicId: 'T3', executionSummary: '...' },
        mockLLMClient as any, mockTopicGraph as any, mockMemoryManager as any)
    ).resolves.not.toThrow();
  });

  test('executionSummary 长度限制（避免 bg pass token 浪费）', async () => {
    mockLLMClient.chatSync.mockResolvedValue({ content: '{}', toolCalls: [] });
    const longTrace = Array(100).fill('long tool result content').join('\n');

    await runBackgroundPass(
      { topicId: 'T3', executionSummary: longTrace },
      mockLLMClient as any, mockTopicGraph as any, mockMemoryManager as any
    );

    // 检查 LLM 调用中的 prompt 不超过合理长度
    const callArgs = mockLLMClient.chatSync.mock.calls[0][0];
    const promptLength = JSON.stringify(callArgs.messages).length;
    expect(promptLength).toBeLessThan(10_000);
  });
});
```

---

### 3.6 集成测试：完整流水线

**文件**：`src/tests/phase4/pipeline.integration.test.ts`（新建）

```typescript
describe('Phase 4 流水线集成测试', () => {
  // 使用真实 SQLite 但 Mock LLM 调用
  let topicGraph: TopicGraph;
  const testDbPath = '/tmp/test-pipeline-integration.db';

  beforeAll(async () => {
    topicGraph = new TopicGraph(testDbPath);
    await topicGraph.init();
  });

  afterAll(() => {
    topicGraph.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  test('【核心场景】TqQuant 不被 xiaozhi history 污染', async () => {
    // 预设：T1 有大量 xiaozhi 相关 history
    const t1History = new MessageHistoryManager({ maxMessages: 200 });
    for (let i = 0; i < 50; i++) {
      t1History.addMessage({ role: 'user', content: `小智开发任务${i}` });
      t1History.addMessage({ role: 'assistant', content: `TypeScript实现${i}` });
    }
    await topicGraph.saveHistory('T1', t1History);
    await topicGraph.getOrCreate('T1', 'code_task');
    await topicGraph.updateSummary('T1', '开发小智AI助手，TypeScript+飞书', ['xiaozhi', 'feishu']);

    // 路由器将 TqQuant 消息路由到 T3
    const mockRouter = vi.fn().mockResolvedValue({
      topicId: 'T3', isNewTopic: true, historyStrategy: 'none',
      relatedTopicIds: [], entityTags: ['TqQuant'], confidence: 0.95
    });

    const context = await assembleContext(
      await mockRouter(), topicGraph, null as any
    );

    // 关键断言：T3 的 context 中不含 T1 的 xiaozhi 内容
    const allContextContent = JSON.stringify(context.messages);
    expect(allContextContent).not.toContain('TypeScript实现');
    expect(allContextContent).not.toContain('小智开发任务');
    expect(context.messages).toHaveLength(0); // 新话题，干净 context
  });

  test('话题历史在 saveHistory/loadHistory 后保持一致', async () => {
    await topicGraph.getOrCreate('T_test', 'general_chat');

    const h = new MessageHistoryManager({ maxMessages: 200 });
    h.addMessage({ role: 'user', content: '测试消息A' });
    h.addMessage({ role: 'assistant', content: '测试回复A' });
    await topicGraph.saveHistory('T_test', h);

    const loaded = await topicGraph.loadHistory('T_test');
    expect(loaded.getMessages()[0].content).toBe('测试消息A');
    expect(loaded.getMessages()[1].content).toBe('测试回复A');
  });

  test('同一话题多次交互，history 正确累积', async () => {
    await topicGraph.getOrCreate('T_accumulate', 'project_query');

    // 第1次交互
    const h1 = await topicGraph.loadHistory('T_accumulate');
    h1.addMessage({ role: 'user', content: '第一次问' });
    h1.addMessage({ role: 'assistant', content: '第一次答' });
    await topicGraph.saveHistory('T_accumulate', h1);

    // 第2次交互
    const h2 = await topicGraph.loadHistory('T_accumulate');
    h2.addMessage({ role: 'user', content: '第二次问' });
    h2.addMessage({ role: 'assistant', content: '第二次答' });
    await topicGraph.saveHistory('T_accumulate', h2);

    // 验证累积
    const final = await topicGraph.loadHistory('T_accumulate');
    expect(final.getMessages()).toHaveLength(4);
  });

  test('降级场景：路由失败时使用 fallback history，服务不中断', async () => {
    // Stage 1 LLM 超时模拟
    const result = await routeAndAssemble(
      '测试消息',
      topicGraph,
      { chatSync: vi.fn().mockRejectedValue(new Error('timeout')) } as any,
      { searchRelevant: vi.fn().mockResolvedValue([]) } as any
    );

    // 降级到 fallback，不抛出
    expect(result.topicId).toBe('fallback');
    expect(result.messages).toBeDefined();
  });
});
```

---

### 3.7 系统测试：真实 API 场景（可选，CI 跳过）

**文件**：`src/tests/phase4/e2e.test.ts`（标记 `skip` 除非手动运行）

```typescript
describe.skip('Phase 4 E2E（需要真实 API Key）', () => {
  test('TqQuant 查询 → 正确路由到 T3（真实 glm-4-flash）', async () => {
    // 需要 ZHIPU_API_KEY 环境变量
    const result = await routeAndAssemble(
      'TqQuant 的 TQSDK 怎么连接天勤行情？',
      realTopicGraph, realLLMClient, realMemoryManager
    );
    expect(result.topicId).not.toBe('T1'); // 不能路由到 xiaozhi 话题
    expect(result.route.entityTags).toContain('TqQuant');
  });

  test('background pass 不超过 5 秒完成（性能保障）', async () => {
    const start = Date.now();
    await runBackgroundPass({ topicId: 'T3', executionSummary: '...' },
      realLLMClient, realTopicGraph, realMemoryManager);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
```

---

## 四、实施顺序和依赖关系

```
4-A（序列化）─┐
             ├──→ 4-B（话题图）─┐
             |                  ├──→ 4-C（路由器）─┐
             |                  |                  ├──→ 4-E（接入 handleMessage）
             |                  |                  |
             |                  └──→ 4-D（热路径工具）─┘
             |                                         |
             └─────────────────────────────────────────→ 4-F（Background Pass）
```

| 任务 | 前置 | 预估工作量 | 关键风险 |
|------|------|-----------|---------|
| 4-A 序列化 | 无 | 0.5天 | 需确保 timestamp 类型正确反序列化 |
| 4-B 话题图 | 4-A | 1天 | SQLite 文件路径权限、并发写入 |
| 4-C 路由器 | 4-B | 1天 | LLM 输出格式不稳定，需健壮解析 |
| 4-D 热路径工具 | 4-B | 0.5天 | tool description 引导有效性 |
| 4-E 接入 | 4-C、4-D | 0.5天 | 降级逻辑覆盖所有异常路径 |
| 4-F Background | 4-E | 0.5天 | 异步任务不能影响主进程崩溃 |
| **合计** | | **4天** | |

---

## 五、功能开关（Feature Flag）

Phase 4 通过环境变量控制，支持灰度上线：

```bash
# 启用话题路由（默认关闭，安全上线）
XIAOZHI_TOPIC_ROUTING=true

# 路由 LLM 模型（默认 glm-4-flash，成本低）
XIAOZHI_ROUTER_MODEL=glm-4-flash

# 后台 Pass 开关（可独立关闭）
XIAOZHI_BG_PASS=true

# 话题 history 目录
XIAOZHI_TOPICS_DIR=~/.xiaozhi/topics
```

`handleMessage` 中：
```typescript
if (process.env.XIAOZHI_TOPIC_ROUTING === 'true') {
  // 3 阶段流水线
} else {
  // 原有全局 historyManager 行为（兜底）
}
```

---

## 六、成功验收标准

### 定量指标
- [ ] TqQuant 查询测试（3.6 集成测试）：100% pass，xiaozhi history 不污染
- [ ] 序列化往返测试（3.1）：数据 0 丢失
- [ ] 路由器降级测试：LLM 失败时服务响应不超过原有延迟 + 500ms
- [ ] 所有新增测试在 `npm test` 中通过

### 定性验证
- [ ] 实际飞书测试：连续对话 TqQuant → 切换话题 → 再回 TqQuant，上下文正确恢复
- [ ] Background Pass 日志确认：每次 Stage 2 后有后台任务完成日志
- [ ] 话题图 SQLite 文件可读：`topic graph` CLI 命令输出话题列表

---

*计划版本：v1.0 | 基于 3 阶段 + Background Pass 设计 | LLM 驱动判断原则*
