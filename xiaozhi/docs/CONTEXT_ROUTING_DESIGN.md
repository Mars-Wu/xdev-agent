# 话题感知上下文路由系统设计

> **问题来源**：TqQuant 项目查询案例——小智因全局 history 上下文污染，将 Python 量化交易项目误答为 TypeScript AI 项目。  
> **设计目标**：在不影响连续对话体验的前提下，实现话题级别的上下文隔离，防止跨话题污染。  
> **参考项目**：originClaw（Claude Code）、learn-claude-code、OpenClaw（个人 AI 助手平台）

---

## 一、问题本质：上下文污染的循环依赖

### 为什么"在工具里解决"不够

直觉方案是增加一个 `delegate_task` 工具，让主 LLM 自行决定何时隔离执行。但这存在循环依赖：

```
[需要隔离的判断] 依赖 [干净的判断能力]
[干净的判断能力] 依赖 [未被污染的上下文]
[未被污染的上下文] 依赖 [已经隔离]  ← 循环
```

LLM 的注意力机制对"高频出现词汇"有强烈偏向。当 history 中有 600 条 xiaozhi 相关内容时，即便有工具说明，主 LLM 的推理起点已经偏移了。

**结论**：路由判断必须在污染上下文**之外**进行。

---

## 二、行业现有方案对比

| 方案 | 原理 | 解决"同用户跨话题污染"？ | 代表实现 |
|------|------|------------------------|---------|
| **会话隔离** | 每次新对话 = 新 session | ❌ 同一 session 内无效 | 所有商业产品 |
| **滑动窗口** | 保留最近 N 条消息 | ❌ 近期消息本身就是污染 | LangChain Buffer |
| **摘要压缩** | 将旧历史压缩为摘要 | ⚠️ 改善但未解决，摘要仍混合 | LangChain Summary |
| **RAG 记忆** | 实体/事实向量化，按相似度检索 | ⚠️ 检索结果混合，无法分 topic | Mem0、LangMem |
| **图记忆** | 实体关系图，结构化存储 | ⚠️ 解决了记忆，未解决执行污染 | Mem0 Graph |
| **CoALA 框架** | 工作/情节/语义/程序四层记忆 | ✅ 理论上支持，实现复杂 | 学术论文 |
| **话题图路由（本设计）** | 话题级 history 隔离 + 受控关联 | ✅ 针对性解决 | 本项目 |

### OpenClaw 的方案：平台原生 Thread 隔离

OpenClaw 是目前最接近本问题的开源个人助手项目。它的解法是：每个消息来源（channel/thread/DM）映射到独立的 `sessionKey`，各自拥有独立 transcript 文件。

```
telegram:topic:42     → 独立 transcript  ✅ 天然隔离
discord:channel:dev   → 独立 transcript  ✅ 天然隔离
feishu:personal       → agent:main:main  ❌ 单一 transcript，无法分话题
```

OpenClaw **主动拒绝**了自动话题检测，原因：安全性（prompt injection 风险）+ 显式优于隐式。但当平台不提供原生 threading 时（如飞书个人对话），单 channel 多话题无解，这是本设计填补的空白。

**关键洞察**：行业方案主要解决"用户 A vs 用户 B"的隔离，而**"同一用户、同一 session 内、不同话题之间的污染"**是被忽视的场景。本设计针对此场景。

---

## 三、设计方案：3 阶段流水线

### 3.1 整体流水线

```
飞书消息到达
  │
  ▼
[Stage 1] Router + Assembler（glm-4.7-flash + 纯逻辑）
  ├─ glm-4.7-flash 独立调用（~150ms）：
  │    输入：话题摘要列表（轻量）+ 用户原始消息
  │    输出：{ topicId, entityTags, historyStrategy, relatedTopicIds }
  └─ 纯代码立即执行（~10ms，无 LLM）：
       ├─ 按 historyStrategy 加载 topic history bucket
       ├─ 注入相关话题摘要（轻量）
       ├─ 注入 ~/data/ 动态目录
       └─ 组装完整 { systemPrompt, messages }
  记录：pipeline_log（topicId、historyStrategy、token 数）
  │
  ▼
[Stage 2] Main Agent Loop（GLM-5）
  ├─ 工具调用执行任务（N 轮）
  ├─ 每轮 tool_result 追加到 topic history bucket
  ├─ 主 LLM 按需调用 save_memory / update_topic_summary 工具（热路径记录）
  └─ loop 结束后同步执行（< 5ms，纯规则）：
       ├─ 从执行 trace 提取新实体标签 → 更新话题图
       └─ 更新话题图边权重（时序衰减 + 关联加权）
  记录：topic history bucket（实时）+ 话题图（loop 后）
  │
  ▼
[Stage 3] 飞书回复
  └─ 记录 delivery_status、message_id
```

**设计本质**：把"判断用什么上下文"和"执行任务"分开。Stage 1 在无污染环境里做路由决策并组装 context，Stage 2 在干净、有针对性的 context 里执行，主 LLM 自己负责记录值得保留的知识。

### 3.2 预处理器 Prompt 设计（职责边界）

**核心原则：system 只定义职责规则，不含具体项目信息；具体话题数据放 user role**

```
[System - 固定不变，可被 prompt cache 复用]
你是消息分类路由器。
职责：
  1. 判断消息属于哪个已知话题，或是否是新话题
  2. 识别消息中提到的实体（项目名、文件路径、专有名词）
  3. 评估与其他已知话题的关联程度
  4. 建议需要注入的 history 范围
只输出 JSON，不作任何解释或回答。

[User - 动态，每次构建]
已知话题：
[T1] 类型:code_task  摘要:"开发AI助手，TypeScript飞书集成"
     实体:["xiaozhi","feishu"]  最近活跃:2小时前
[T3] 类型:project_query  摘要:"Python量化交易系统调研"
     实体:["TqQuant"]  最近活跃:3天前

用户消息：{原始消息原文}

输出格式：
{
  "topicId": "T3 或 new:project_query",
  "isNewTopic": false,
  "relatedTopicIds": ["T1"],
  "entityTags": ["TqQuant", "/home/wxy/data/TqQuant"],
  "topicType": "project_query",
  "historyStrategy": "full",
  "confidence": 0.92
}
```

`historyStrategy` 说明：
- `full`：话题刚发生，连续性强（< 1小时）
- `recent_20`：话题较近但有间隔（< 1天）
- `summary_only`：话题较久（> 1天），只注入摘要
- `none`：全新话题，干净 context

### 3.3 主 LLM 的热路径记录工具

Stage 2 中，主 LLM 通过两个工具在执行过程中自行决定何时记录，无需外部后处理器：

```typescript
// 工具 1：保存记忆（主 LLM 判断何时值得记录）
save_memory({
  content: "TqQuant 使用 TQSDK 连接天勤行情，主要入口是 tqsdk.TqApi",
  type: "semantic",
  importance: 8,
  // topicId 由系统自动注入，LLM 无需填写
})

// 工具 2：更新话题摘要（任务完成后调用，可选）
update_topic_summary({
  summary: "Python量化交易系统，TQSDK接入天勤行情，实现缠论策略",
})
```

**触发规则**：
- 发现重要技术事实 → 调用 `save_memory`
- 完成一个完整任务 → 调用 `update_topic_summary`
- 普通问答 → 什么都不调用

### 3.4 三类信息 × 三个归宿

| 信息类型 | 产生阶段 | 归宿 | 生命周期 |
|---------|---------|------|---------|
| **话题归属**（路由信息）| Stage 1 glm-4.7-flash | 话题图 SQLite | 长期，随话题演化 |
| **执行过程**（工作记忆）| Stage 2 每轮追加 | topic history bucket | 中期，按 historyStrategy 老化 |
| **提炼知识**（长期记忆）| Stage 2 主 LLM 工具调用 | MemoryManager | 长期，跨话题可用 |

执行过程的分层保留：
```
最近 3 轮 tool_result → 完整保留（micro-compact 现有逻辑）
3~20 轮以前          → 截断保留头尾（micro-compact 现有逻辑）
20 轮以前            → 由主 LLM 决定是否 save_memory 提炼
```

### 3.5 话题图本地存储

```sql
CREATE TABLE topics (
  id                  TEXT PRIMARY KEY,   -- "T1", "T2", ...
  type                TEXT NOT NULL,      -- project_query/code_task/general_chat
  summary             TEXT,              -- 预处理器读取，须简短（1-2句）
  entity_tags         TEXT,              -- JSON 数组，如 ["TqQuant"]
  turn_count          INTEGER DEFAULT 0,
  summary_updated_at  INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  status              TEXT DEFAULT 'active'  -- active / archived
);

CREATE TABLE topic_relations (
  from_topic  TEXT NOT NULL,
  to_topic    TEXT NOT NULL,
  relation    TEXT NOT NULL,  -- same_project / same_task / sequential
  weight      REAL DEFAULT 1.0,
  PRIMARY KEY (from_topic, to_topic, relation)
);

CREATE TABLE pipeline_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  topic_id          TEXT,
  is_new_topic      INTEGER,
  confidence        REAL,
  history_strategy  TEXT,
  token_count       INTEGER,
  turn_count        INTEGER
);
```

### 3.6 话题 History 分桶存储

```
~/.xiaozhi/topics/
├── index.db          ← 话题图 + pipeline_log（SQLite）
├── T1/
│   └── history.json  ← MessageHistoryManager 序列化（maxMessages:200, maxTokens:60K）
├── T3/
│   └── history.json
└── ...
```

内存缓存：最近活跃 3 个话题常驻，其余按需磁盘加载。

---

## 四、与现有架构的集成

### 4.1 需要修改/新建的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/message-router.ts` | **新建** | Stage 1：glm-4.7-flash 分类 + 上下文组装 |
| `src/storage/topic-graph.ts` | **新建** | 话题图 SQLite 操作层 |
| `src/core/message-history.ts` | **修改** | 增加 `saveToDisk` / `loadFromDisk` 序列化 |
| `src/tools/memory-tools.ts` | **新建** | `save_memory` / `update_topic_summary` 工具注册 |
| `src/index.ts` | **修改** | `handleMessage()` 接入 3 阶段流水线 |

### 4.2 handleMessage 改造后的流程

```typescript
async function handleMessage(msg, llmClient, feishuClient, ...) {
  // Stage 1: Router + Assembler
  const topicSummaries = await topicGraph.getActiveSummaries();
  const route = await routeMessage(msg.text, topicSummaries, llmClient);
  const topicHistory = await topicGraph.getOrCreateHistory(route.topicId);
  const { systemPrompt, messages } = assembleContext(route, topicHistory);

  // Stage 2: Main Agent Loop
  const result = await runAgentLoop(llmClient, topicHistory, systemPrompt);

  // Stage 2 结束后的规则清理（同步，< 5ms）
  syncCleanup(route, result.executionTrace, topicGraph);

  // Stage 3: 飞书回复
  await feishuClient.reply(msg, result.finalResponse);
}
```

---

## 五、实施路径

### Phase 4-A：Router + Assembler（1 天）
- 新建 `message-router.ts`：glm-4.7-flash 分类 + 纯代码组装
- 新建 `topic-graph.ts`：SQLite schema + getActiveSummaries + getOrCreateHistory
- `MessageHistoryManager` 加 saveToDisk / loadFromDisk

### Phase 4-B：热路径记录工具（0.5 天）
- 新建 `save_memory` 工具（复用 MemoryManager，自动注入 topicId）
- 新建 `update_topic_summary` 工具（写入话题图）
- 注册到 ToolRegistry

### Phase 4-C：话题图边维护（0.5 天）
- `syncCleanup`：从 executionTrace 提取实体标签 + 更新边权重
- 边权重时序衰减（每次 loop 后）

### Phase 4-D：动态目录注入（0.25 天）
- `assembleContext` 中动态读取 `~/data/` 写入 system prompt

### Phase 4-E：预压缩记忆刷新（0.5 天，借鉴 OpenClaw）
- 话题 history 达到软阈值（80%）时，主 LLM 收到隐式提示调用 `save_memory`
- 防止压缩后关键信息丢失

**总工作量：约 2.75 天**

---

## 六、预期效果

| 场景 | 改造前 | 改造后 |
|------|-------|--------|
| 查询 TqQuant 项目 | 受 xiaozhi 历史污染，答错 | Stage 1 路由到独立 T3 bucket，干净执行 |
| 继续昨天的代码任务 | 可能被中间对话打断 | 同话题 bucket 保持完整上下文 |
| 询问"之前做过什么" | 全局搜索，结果随机 | MemoryManager 按话题标签检索 |
| 普通闲聊 | 全局 history | general_chat 路由，行为不变 |
| 项目列表过时 | system prompt 写死 | 每次动态读取 ~/data/ |
| 接近 token 上限 | 压缩可能丢失关键记忆 | 预压缩前触发 save_memory |

---

## 七、与参考项目的对比定位

| 维度 | originClaw | learn-claude-code | OpenClaw | 本设计 |
|------|-----------|------------------|---------|--------|
| **话题隔离** | 子 Agent（任务粒度）| 子任务新 context | 平台 thread 隔离 | 话题图（内容粒度）|
| **单 channel 多话题** | ❌ | ❌ | ❌ | ✅ 核心目标 |
| **记忆写入方式** | 无 | 无 | 热路径或预压缩 | 热路径（主 LLM 工具）|
| **久远记忆** | 无 | 无 | embedding 搜索 | 话题图 + MemoryManager |

---

## 八、适用场景说明

本设计针对**"单一消息源、长期运行、多话题混合"**的 Agent 场景：

- 消息源：单一入口（一个飞书群/用户）
- 生命周期：服务常驻，无 session 边界
- 话题模式：用户在不同时间切换话题，也会回到旧话题

这是**个人助手类 Agent 的典型工作模式**。与多用户系统的差别：多用户用 userId 隔离，本场景用 topicId 隔离，粒度更细。

如果飞书未来支持话题 threading，可直接用 sessionKey 取代本设计中的 Stage 1 预处理器，两者思路互补。

---

*文档版本：v2.0 | 更新日期：2026-04 | 简化为 3 阶段流水线，Stage 4 合并入 Stage 2 热路径工具，Stage 2 合并入 Stage 1*

---

## 九、单消息多话题处理（方案 B：并行子任务）

### 问题

一条飞书消息可能包含多个独立话题，例如：
> "帮我看看 TqQuant 的 README，顺便把 xiaozhi 的日志级别改成 debug"

原设计路由器只返回单个 `topicId`，只能选一个话题处理，另一个裸跑，导致：
- 被放弃的话题缺失 history 上下文
- 两件事的结果混存到同一个 bucket

### 设计原则

- **代码负责合并**，不引入第三个 LLM——合并只是有序拼接，不需要理解
- **每个 Stage 2 相互不知道对方**，各自在独立 context 中运行，保持隔离
- 单话题消息（绝大多数）走长度为 1 的数组，行为与之前完全一致

### 数据流

```
用户消息（原始）
       │
       ▼
  【Stage 1：路由器】
  输出: SubRouteResult[]
       │
       ├─ routes.length === 1  →  原有路径（无性能开销）
       └─ routes.length >= 2  →  并行执行
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   【Stage 2-A】       【Stage 2-B】
    话题 T1 context     话题 T2 context
    subMessage A        subMessage B
        │                   │
        ▼                   ▼
      回复A               回复B
        │                   │
        └─────────┬─────────┘
                  ▼
           【handleMessage 拼接】
           回复A + "\n\n---\n\n" + 回复B
                  │
           保存 T1 history    保存 T2 history
           （存 subMessageA） （存 subMessageB）
```

### Stage 1 输出结构变化

```typescript
// 路由器输出从单对象改为容器
interface SubRouteResult {
  topicId: string
  isNewTopic: boolean
  subMessage: string       // ← 新增：从原消息提炼的独立子问题（自含上下文）
  historyStrategy: HistoryStrategy
  historyHint: string
  relatedTopicIds: string[]
  entityTags: string[]
  confidence: number
}

interface MultiRouteResult {
  routes: SubRouteResult[]     // 单话题时长度=1
  isMultiTopic: boolean
  splitHint: string
}
```

### Router Prompt 拆分规则

```
若消息包含 ≥2 个独立问题/任务（互不依赖，可分别独立回答）→ 拆分
若问题之间有依赖或共享上下文（"用A的结果做B"）→ 不拆分，选主话题
subMessage 必须自含上下文，不能有指代不明的代词
最多拆分为 3 个子任务
若任一话题 confidence < 0.6 → 不拆分，退化为单话题（原始消息）
```

### History 保存规则

| 保存内容 | 保存到哪个 bucket |
|---------|-----------------|
| `subMessage`（用户侧） | 对应话题的 bucket |
| LLM 回复（助手侧） | 对应话题的 bucket |
| 原始 `userMessage` | **不保存**——避免跨话题噪音 |

### 合并逻辑（handleMessage）

```typescript
if (responses.length === 1) {
  return responses[0].reply                 // 单话题：直接返回
}
// 多话题：按路由顺序拼接，失败项输出占位符
return responses
  .map(r => r.error ? '（该部分处理失败，请稍后重试）' : r.reply)
  .join('\n\n---\n\n')
```

### 边界情况

| 情况 | 处理方式 |
|------|---------|
| 路由器拆出 >3 个话题 | 限制最多 3 个 |
| 任一子任务 Stage 2 异常 | 不影响其他子任务，该位置返回占位符 |
| 所有子任务失败 | 降级到全局 historyManager |
| 话题有依赖关系 | Router 不拆分，单话题处理 |
| 后台 Pass | 每个话题独立触发 |
