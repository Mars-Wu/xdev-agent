# Harness Engineering 分析报告

> 分析时间：2026-04  
> 参考项目：originClaw (Claude Code 源码)、clawd-code (Python 移植)、learn-claude-code (教程)  
> 参考文献：Anthropic《Building Effective Agents》  
> 目标：识别艾克斯可借鉴的 harness engineering 提升方向

---

## 什么是 Harness Engineering

> "A harness is everything the agent needs to function in a specific domain."  
> — learn-claude-code README

```
Harness = Tools + Knowledge + Observation + Action Interfaces + Permissions

    Tools:          文件 I/O、Shell、网络、数据库、浏览器
    Knowledge:      领域文档、API 说明、风格指南（按需注入）
    Observation:    Git diff、错误日志、环境状态
    Action:         CLI 命令、API 调用、UI 交互
    Permissions:    沙箱、审批流程、信任边界
```

**模型是 Agent，Harness 是载具。** 模型决策，Harness 执行。好的 Harness 让模型更聪明、更安全、更持久。

---

## 参考项目对比

| 维度 | originClaw (Claude Code) | learn-claude-code | clawd-code |
|------|--------------------------|-------------------|------------|
| 规模 | 1884 TS 文件，512K LOC | 14 Python 文件，~2.5K LOC | 8 Python 文件 |
| 定位 | 生产级编程 Agent | 12 课递进教程 | 架构参考移植 |
| 核心价值 | 完整工具链 + 安全体系 | 清晰模式提炼 | 查询引擎抽象 |

---

## 一、Agent Loop：基础正确，可加生命周期钩子

### 当前状态
艾克斯使用 `LLMClient.chat()` 返回 `AsyncGenerator<ChatEvent>`，在 InProcessAgent 中消费工具调用，循环直到无工具调用为止。**核心模式正确**。

### 可借鉴：Loop 生命周期钩子

originClaw 在 loop 每一轮注入结构化钩子：

```
while stop_reason == "tool_use":
  ① [pre-call hook]  → 注入通知队列（后台任务结果、inbox 消息）
  ② LLM call
  ③ [post-call hook] → 微压缩旧 tool_result、计费、遥测
  ④ 执行工具
  ⑤ [result hook]   → 工具结果格式化、安全过滤
```

**建议**：在 `InProcessAgent` 的 loop 中明确区分 `beforeCall` / `afterCall` 阶段，便于后续接入压缩、通知注入等能力，而不是把这些逻辑散在各处。

---

## 二、Skill Loading：当前有改进空间【高优先级】

### 当前状态
`skills/loader.ts` 扫描所有 markdown 文件，一次性加载全部 Skill 定义。系统 prompt 中包含所有 Skill 的完整内容（或至少全部元数据）。

### 参考：两层注入模式（来自 learn-claude-code s05）

```
Layer 1（System Prompt，~100 tokens/skill）：
  Skills available:
    - pdf: 处理 PDF 文件，支持文本提取和结构解析 [pdf, document]
    - code-review: 代码审查，输出问题列表和改进建议 [code, quality]

Layer 2（Tool Result，按需加载完整 body）：
  当模型调用 load_skill("pdf") 时，返回：
  <skill name="pdf">
    ...完整的 PDF 处理步骤说明...
  </skill>
```

**改进方案**：
1. 系统 prompt 只注入 skill 名称 + 一行描述 + tags（约 50-100 tokens/个）
2. 在工具列表中暴露 `load_skill` 工具
3. 模型根据任务性质判断需要哪个 skill，再调用加载

**收益**：假设有 10 个 skill，每个完整体 500 tokens，当前浪费 ~5000 tokens/turn；改造后节省约 4500 tokens/turn，且让模型决策更精准。

---

## 三、Context Compaction：三层压缩管道【高优先级】

### 当前状态
`context/token-counter.ts` 做 token 估算，`context/context-pruning.ts` 做优先级保留。但架构不明确是否有 **微压缩（每轮清理老 tool result）** 和 **自动压缩（触发 LLM 摘要）**。

### 参考：三层管道（来自 learn-claude-code s06）

```
每轮 after tool execution：
┌─────────────────────────────────────────────────────────┐
│ Layer 1: micro_compact（每轮，无感知）                    │
│   把非最近 3 条的 tool_result 内容替换为                  │
│   "[Previous: used bash]"                               │
│   节省 90%+ 历史 tool output 占用                        │
└─────────────────────────────┬───────────────────────────┘
                              │ 若 tokens > 50000
┌─────────────────────────────▼───────────────────────────┐
│ Layer 2: auto_compact（阈值触发）                         │
│   1. 把完整 transcript 保存到 .transcripts/<ts>.jsonl    │
│   2. 请求 LLM 生成对话摘要                               │
│   3. 把 messages 替换成 [摘要 + "Continuing..."]         │
└─────────────────────────────┬───────────────────────────┘
                              │ 模型主动调用
┌─────────────────────────────▼───────────────────────────┐
│ Layer 3: compact tool（模型主动触发）                     │
│   模型感到 context 拥挤时，主动调用 compact() 工具        │
└─────────────────────────────────────────────────────────┘
```

**艾克斯改进方案**：
1. **Layer 1（立即可做）**：在每次 loop 迭代后，把 ≥4 轮前的 `tool_result` content 替换为 `[omitted: {tool_name}]`
2. **Layer 2（重要）**：设置 token 阈值（建议 80K），触发时保存 transcript 到 SQLite，然后用 LLM 生成摘要重置 context
3. **关键**：压缩后必须**重新注入 identity block**（见第六节）

---

## 四、Todo/任务追踪：添加提醒注入机制【中优先级】

### 当前状态
艾克斯有 `todo-manager.ts` 和 `task-system.ts`，基本功能完善。

### 参考：Reminder 注入（来自 learn-claude-code s03 / originClaw TodoWriteTool）

**originClaw 的结构性提醒**：
```typescript
// TodoWriteTool.ts - 关闭 3+ 项 todo 列表时，若无验证步骤，注入提醒
if (allDone && oldTodos.length >= 3 && !hasVerificationStep(oldTodos)) {
  verificationNudgeNeeded = true
  // 在 tool_result 中追加提示，推动模型添加验证环节
}
```

**s03 的轮次提醒**：
```python
# 超过 3 轮没有更新 todo，注入 <reminder>
if todo_manager.rounds_since_update >= 3:
    messages[-1]["content"] += "\n<reminder>Please update the todo list.</reminder>"
```

**建议**：
- 在 `InProcessAgent` loop 中追踪 `roundsSinceTodoUpdate`
- 超过阈值时在下次 user turn 注入 `<reminder>` XML 块
- 多步任务完成时，检查是否包含 "验证/测试" 步骤，若无则提示

---

## 五、Subagent 上下文隔离：明确 fresh context 模式【中优先级】

### 当前状态
艾克斯 `InProcessAgent` 支持嵌套，但不确定子 agent 是否总是使用干净的 `messages=[]`。

### 参考：严格上下文隔离（来自 learn-claude-code s04）

```
Parent Agent                    Subagent
messages=[...全量历史...]       messages=[]  ← 必须是空的
         |                              |
         | run_subagent(prompt)         |
         |─────────────────────────────>|
         |                              | 在干净上下文中工作
         |                              | 不会被父 context 污染
         |<─────────────────────────────|
         | "发现 3 个安全漏洞：..."      |  只返回摘要
         |  (只有结论，不包含子 agent    |
         |   的工具调用历史)             |
```

**关键原则**：
- 子 agent 使用全套工具，但 context 从零开始
- 父 agent 只接收最终文本摘要，不接收子 agent 的 tool_use / tool_result 链
- 父 context 保持干净，避免被子任务的中间结果污染

**建议**：在 `agent-tool.ts` 的实现中，确认 `runAgent()` 调用时 `messages` 参数是新建的 `[]`，而非从父 agent 继承。

---

## 六、Identity 重注入：压缩后不丢失身份【中优先级】

### 当前状态
艾克斯自主 agent 有 `name` / `role` / `skills` 配置，但压缩后如何保持身份不明确。

### 参考：压缩后 Identity 重注入（来自 learn-claude-code s11）

```python
def _compact_if_needed(self, messages: list, identity: dict) -> list:
    if estimate_tokens(messages) > THRESHOLD:
        summary = self._summarize(messages)
        # 重置 messages，但首条是 identity block
        return [
            {
                "role": "user",
                "content": (
                    f"[Context compressed. Summary: {summary}]\n\n"
                    f"Your identity: name={identity['name']}, "
                    f"role={identity['role']}, team={identity['team']}"
                )
            },
            {"role": "assistant", "content": "Understood. Resuming."},
        ]
    return messages
```

**建议**：在 `AutonomousAgent` 的压缩逻辑中，压缩后第一条消息必须包含 agent 的身份信息（名字、角色、当前任务 ID）。否则长时间运行的 agent 会"忘记自己是谁"。

---

## 七、多 Agent 协作：文件式邮箱协议【低优先级（已有基础）】

### 当前状态
艾克斯使用 `plugin-sdk/event-bus.ts` 做模块间通信，是内存 pub/sub 模型。

### 参考：JSONL 邮箱协议（来自 learn-claude-code s09/s10）

```
.team/inbox/
  alice.jsonl  ← append-only，read & drain
  bob.jsonl
  lead.jsonl

消息格式（5 种类型）：
  message              → 普通文本消息
  broadcast            → 群发给所有成员
  shutdown_request     → 请求优雅关机
  shutdown_response    → 批准/拒绝关机
  plan_approval_response → 批准/拒绝计划
```

**与 EventBus 的区别**：
- EventBus：内存 pub/sub，重启后丢失，无法跨进程
- JSONL 邮箱：持久化，可审计，可回放，支持异步

**建议**：如果艾克斯要做多 session 多 agent 协作，或需要 agent 在重启后恢复通信状态，可以在 task-system 旁边增加一个基于 SQLite 的 inbox 机制，替代或补充现有 EventBus。

---

## 八、工具安全防护：深度防御模型【重要，补充当前实现】

### 当前状态
`src/tools/` 有基本的危险命令列表，`background-tasks.ts` 用 `ChildProcess` 运行命令。

### 参考：originClaw BashTool 的深度防御

```typescript
// bashSecurity.ts - 多层安全检查
const checks = [
  // 1. Shell 展开模式检测（阻止注入）
  COMMAND_SUBSTITUTION_PATTERNS: [
    { pattern: /\$\(/, message: '$() command substitution' },
    { pattern: /\$\{/, message: '${} parameter substitution' },
    { pattern: /<\(/, message: 'process substitution <()' },
  ],
  
  // 2. Zsh 危险命令（绕过黑名单的向量）
  ZSH_DANGEROUS_COMMANDS: new Set([
    'zmodload',  // 加载危险 zsh 模块
    'emulate',   // eval 等价
    'sysopen',   // 绕过文件访问检查
  ]),
  
  // 3. Tree-sitter 语法分析（理解命令结构，而不只是字符串匹配）
  
  // 4. Heredoc 检查（检测 heredoc 内的命令注入）
  HEREDOC_IN_SUBSTITUTION: /\$\(.*<</,
]
```

**艾克斯可立即采用的改进**：

```typescript
// 在 background-tasks.ts 或工具执行层添加：

const BLOCKED_PATTERNS = [
  /\$\(/,           // $() 命令替换
  /`[^`]*`/,        // 反引号命令替换  
  /\$\{[^}]*\}/,    // ${} 参数展开
  /<\(/,            // 进程替换
  />\(/,
  /eval\s/i,        // eval
  /exec\s/i,        // exec
]

function validateCommand(cmd: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, reason: `Blocked pattern: ${pattern}` }
    }
  }
  return { safe: true }
}
```

---

## 九、工具 Prompt Engineering：ACI 与 HCI 同等重要【高价值】

### Anthropic《Building Effective Agents》核心原则

> "We spent more time optimizing our tools than the overall prompt."  
> — Anthropic SWE-bench 团队

**ACI（Agent-Computer Interface）原则**：

```
1. 工具描述 = 对初级开发者写的 docstring
   - 包含：用途、参数含义、边界条件、与其他工具的区别
   - 不好的：description: "Run bash command"
   - 好的：description: "Execute a shell command in the project workspace.
           Use for file operations, git, npm, etc.
           Returns stdout+stderr. Timeout: 120s.
           Do NOT use for: editing files (use edit_file instead)"

2. Poka-yoke（防错设计）
   - 改参数名让错误更难犯
   - 例：把 path 改成 absolute_path，强制绝对路径
   - 例：把 content 改成 new_file_content，避免意外覆盖

3. 格式选择
   - 给模型足够 token 在写入前"思考"
   - 保持接近模型训练时见过的自然格式
   - 避免需要精确计数（如 diff 行号）的格式
```

### 艾克斯工具描述审查建议

查看 `src/tools/index.ts` 中的工具描述，对照以下标准：
- [ ] 是否说明了"不要用于 X 场景"（负面说明）？
- [ ] 是否包含示例输入/输出？  
- [ ] 参数名是否会让模型产生歧义？
- [ ] 与相似工具（如 task vs todo）的区别是否清晰？

---

## 十、Evaluator-Optimizer 模式：输出质量循环【新能力】

### 参考：Anthropic 推荐模式

```
┌──────────────┐     生成     ┌──────────────┐
│  Generator   │ ──────────> │   Output     │
│  (LLM 1)    │             │              │
└──────────────┘             └──────┬───────┘
        ^                           │
        │ 修改建议                  │ 评估
        │                           ▼
┌───────┴──────────────────────────────────┐
│         Evaluator (LLM 2)               │
│  "输出是否满足标准？给出具体改进意见"     │
└──────────────────────────────────────────┘
      循环直到 Evaluator 认为"合格"
```

**适合艾克斯的场景**：
- 飞书消息生成：Generator 生成回复，Evaluator 检查"是否简洁/是否回答了问题"
- 代码审查：Generator 找问题，Evaluator 验证"问题是否真实存在"
- 任务规划：Generator 制定计划，Evaluator 检查"依赖是否合理/步骤是否可执行"

**实现成本**：低，只需在关键节点调用两次 LLM，使用小型快速模型（如 GLM-4-Flash）做 Evaluator。

---

## 十一、clawd-code 的 QueryEngine 抽象【架构参考】

```python
@dataclass(frozen=True)
class QueryEngineConfig:
    max_turns: int = 8                # 硬性轮次上限
    max_budget_tokens: int = 2000     # 预算 token 上限
    compact_after_turns: int = 12     # 多少轮后触发压缩
    structured_output: bool = False   # 是否要求结构化输出
    structured_retry_limit: int = 2   # 结构化失败重试次数
```

**建议**：艾克斯的 `InProcessAgent` 目前可能缺少 `max_turns` 硬上限保护。建议添加：

```typescript
interface AgentLoopConfig {
  maxTurns: number          // 硬上限，防止失控循环（建议 30）
  budgetTokens?: number     // token 预算（可选，用于成本控制）
  compactAfterTurns?: number // 多少轮后触发压缩（建议 12）
}
```

---

## 十二、Worktree 任务隔离：并行任务的空间隔离【中期目标】

### 参考（learn-claude-code s12）

```
.tasks/task_12.json
{
  "id": 12,
  "subject": "实现用户认证重构",
  "status": "in_progress",
  "worktree": "auth-refactor"    ← 关联 worktree
}

.worktrees/index.json
{
  "worktrees": [{
    "name": "auth-refactor",
    "path": ".../.worktrees/auth-refactor",
    "branch": "wt/auth-refactor",
    "task_id": 12
  }]
}
```

**原理**：每个并发任务运行在独立的 git worktree 中，避免文件冲突，同时通过 task ID 保持协调。

**适合艾克斯的场景**：如果要让多个 AutonomousAgent 并发处理同一代码库的不同任务，worktree 隔离是必须的。

---

## 优先级汇总

| # | 改进项 | 优先级 | 实现难度 | 收益 |
|---|--------|--------|----------|------|
| 1 | Skill 两层加载（按需注入） | 🔴 高 | 中 | 节省 token，提升精准度 |
| 2 | 三层 Context 压缩管道 | 🔴 高 | 中 | 支持无限时长会话 |
| 3 | ACI 工具描述优化 | 🔴 高 | 低 | 降低工具调用错误率 |
| 4 | AgentLoop max_turns 保护 | 🟡 中 | 低 | 防止失控循环 |
| 5 | Todo Reminder 注入 | 🟡 中 | 低 | 提高多步任务完成率 |
| 6 | Identity 重注入（压缩后） | 🟡 中 | 低 | 自主 agent 长期稳定性 |
| 7 | Subagent 严格 fresh context | 🟡 中 | 低 | 减少 context 污染 |
| 8 | 命令安全模式检测增强 | 🟡 中 | 中 | 防御性安全 |
| 9 | Evaluator-Optimizer 模式 | 🟢 低 | 中 | 输出质量提升 |
| 10 | JSONL 邮箱多 Agent 协议 | 🟢 低 | 高 | 持久化多 agent 通信 |
| 11 | Worktree 并发任务隔离 | 🟢 低 | 高 | 并发代码任务安全 |

---

## 关键认知总结

1. **模型是 Agent，代码是 Harness**：不要试图用代码逻辑替代模型决策，而是给模型好的工具、干净的 context 和清晰的 identity。

2. **工具设计比 Prompt 更重要**：Anthropic 在 SWE-bench 上花在工具优化的时间比系统 prompt 更多。工具的描述、参数名、错误信息都是对模型的 prompt。

3. **Context 是消耗品，需要主动管理**：三层压缩（微压缩 → 自动摘要 → 手动触发）让 agent 可以无限运行，而不是在 context 满了就崩溃。

4. **状态要在 context 之外持久化**：任务状态、agent 身份、inbox 消息存在文件/数据库中，不依赖对话历史。这样压缩后状态不丢失。

5. **简单 + 可组合 > 复杂框架**：所有这些模式都可以用几十行代码实现，不需要引入任何框架。Anthropic 的建议是从 LLM API 直接开始构建。
