# T01 · 上下文压缩算法重写

> 参考: `~/data/hermes-agent/agent/context_compressor.py`  
> 目标文件: `src/core/message-history.ts`, `src/context/compressor.ts`

---

## 问题背景

当前 `compress()` 是简单切片（`preserveRecent=5`），不对齐 tool_use/tool_result 边界。
压缩后序列非法（首条为 assistant 或连续同角色），GLM API 报 1214 错误。
已有临时修复 `normalizeMessages`，但根源问题在压缩算法本身。

---

## Hermes 算法要点

Hermes `ContextCompressor` 的关键设计：

```
1. 工具输出剪枝（无需 LLM，廉价预处理）
2. 保护头部：前 protect_first_n（默认3）条消息
3. 按 token 预算保护尾部（而非固定N条）
4. 中间部分用结构化 LLM prompt 生成摘要
5. 迭代摘要：第二次压缩时在前次摘要上累加，不从头重来
```

边界对齐核心（需移植）：
- `_align_boundary_forward(idx)`: 若 idx 落在 tool_result 上，前移到下一个非 tool 消息
- `_align_boundary_backward(idx)`: 尾部边界若切断 assistant+tool_result 组，整体收入保护区
- `_sanitize_tool_pairs(messages)`: 清理孤立的 tool_use/tool_result 对

---

## 执行方案

### 1. 修改 `src/core/message-history.ts`

#### 新增常量

```typescript
// 尾部 token 预算 = maxTokens * 20%（约 12000 tokens）
const TAIL_TOKEN_BUDGET_RATIO = 0.20
// 工具结果剪枝：保护最近 N 条不剪枝
const PRUNE_KEEP_LAST = 15
// 工具结果剪枝阈值：内容超过多少字符才替换
const PRUNE_MIN_CHARS = 200
const PRUNED_PLACEHOLDER = '[旧工具输出已清除以节省上下文空间]'
// 压缩失败冷却时间（ms）
const SUMMARY_FAILURE_COOLDOWN_MS = 600_000
```

#### `compress()` 重写流程

```typescript
compress(): void {
  if (!this.shouldCompress()) return;
  this.isCompressing = true;

  // 步骤1：工具输出剪枝（廉价，不需要 LLM）
  const [pruned, pruneCount] = this._pruneOldToolResults(this.messages, PRUNE_KEEP_LAST);

  // 步骤2：计算边界
  const headEnd = Math.min(3, Math.floor(pruned.length * 0.1)); // 保护头部3条
  const tailStart = this._findTailByTokenBudget(pruned,
    Math.floor(this.config.maxTokens * TAIL_TOKEN_BUDGET_RATIO));

  // 步骤3：边界对齐（关键！防止切断 tool pair）
  const alignedHead = this._alignBoundaryForward(pruned, headEnd);
  const alignedTail = this._alignBoundaryBackward(pruned, tailStart);

  if (alignedHead >= alignedTail) {
    // 压缩区域太小，跳过
    this.isCompressing = false;
    return;
  }

  // 步骤4：中间区域生成摘要
  const middle = pruned.slice(alignedHead, alignedTail);
  const head = pruned.slice(0, alignedHead);
  const tail = pruned.slice(alignedTail);

  const summary = this.createStructuredSummary(middle);

  // 步骤5：重建消息序列
  this.messages = [
    ...head,
    ...(summary ? [{ role: 'system' as const, content: summary, importance: 10 }] : []),
    ...tail,
  ];
  this.currentTokens = this.messages.reduce((sum, m) => sum + this.estimateTokens(m), 0);

  // 步骤6：孤立 tool pair 清理
  this.messages = this._cleanOrphanedToolPairs(this.messages);

  this.isCompressing = false;
  this.compressionCallback?.({ ... });
}
```

#### `_findTailByTokenBudget(messages, budget): number`

```typescript
_findTailByTokenBudget(messages: Message[], budget: number): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += this.estimateTokens(messages[i]);
    if (tokens > budget) return i + 1;
  }
  return 0; // 整个序列都在预算内
}
```

#### `_alignBoundaryForward(messages, idx): number`

```typescript
// 如果 idx 指向 tool_result，向后移到下一个非 tool_result 消息
_alignBoundaryForward(messages: Message[], idx: number): number {
  while (idx < messages.length) {
    const role = messages[idx].role;
    const content = messages[idx].content;
    if (role === 'user' && Array.isArray(content) && 
        content.some((b: any) => b.type === 'tool_result')) {
      idx++;
    } else {
      break;
    }
  }
  return idx;
}
```

#### `_alignBoundaryBackward(messages, idx): number`

```typescript
// 如果 idx-1 是 assistant with tool_use，将 idx 向前退到该 assistant 之前
// 防止切断 tool_use + tool_result 对
_alignBoundaryBackward(messages: Message[], idx: number): number {
  while (idx > 0) {
    const prev = messages[idx - 1];
    const isToolUse = prev.role === 'assistant' &&
      Array.isArray(prev.content) &&
      prev.content.some((b: any) => b.type === 'tool_use');
    if (isToolUse) {
      idx--;
    } else {
      break;
    }
  }
  return idx;
}
```

#### `_pruneOldToolResults(messages, keepLast): [Message[], number]`

```typescript
_pruneOldToolResults(messages: Message[], keepLast: number): [Message[], number] {
  const result = messages.map(m => ({ ...m }));
  let pruned = 0;
  const boundary = Math.max(0, result.length - keepLast);
  for (let i = 0; i < boundary; i++) {
    const msg = result[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const hasToolResult = content.some((b: any) => b.type === 'tool_result');
    if (!hasToolResult) continue;
    // 替换超长工具结果内容
    result[i] = {
      ...msg,
      content: content.map((block: any) => {
        if (block.type !== 'tool_result') return block;
        const text = typeof block.content === 'string' ? block.content :
          JSON.stringify(block.content);
        if (text.length <= PRUNE_MIN_CHARS) return block;
        return { ...block, content: PRUNED_PLACEHOLDER };
      }),
    };
    pruned++;
  }
  return [result, pruned];
}
```

#### `_cleanOrphanedToolPairs(messages): Message[]`

```typescript
_cleanOrphanedToolPairs(messages: Message[]): Message[] {
  // 收集所有 tool_use id
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_use') toolUseIds.add(block.id);
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
    }
  }

  return messages.filter(msg => {
    if (!Array.isArray(msg.content)) return true;
    const blocks = msg.content as any[];
    // 如果消息只含孤立 tool_use（没有对应 result），移除
    const hasOrphanToolUse = blocks.some(
      b => b.type === 'tool_use' && !toolResultIds.has(b.id)
    );
    // 如果消息只含孤立 tool_result（没有对应 use），移除
    const hasOrphanToolResult = blocks.some(
      b => b.type === 'tool_result' && !toolUseIds.has(b.tool_use_id)
    );
    return !hasOrphanToolUse && !hasOrphanToolResult;
  });
}
```

### 2. 结构化摘要 prompt（`createStructuredSummary`）

替换现有 `createSummary` 方法，使用 Hermes 的结构化模板：

```typescript
const SUMMARY_PREFIX = '[上下文压缩] 以下摘要描述已完成的工作，请在此基础上继续：';

const prompt = `请为以下对话片段创建结构化的工作摘要，供后续 AI 助手继续工作使用。

对话内容：
${serialized}

请使用以下结构：

## 目标
[用户想要完成的任务]

## 约束与偏好
[用户偏好、代码风格、重要决策]

## 进度
### 已完成
[具体完成的工作，包含文件路径、命令、结果]
### 进行中
[当前正在进行的工作]
### 受阻
[遇到的问题或阻塞]

## 关键文件
[读取、修改或创建的文件，每个简要说明]

## 下一步
[继续工作需要进行的操作]

目标约 ${budget} tokens。使用中文。只输出摘要正文，不要前言。`;
```

**迭代摘要**：若 `_previousSummary` 存在，改为"在原摘要基础上更新"的 prompt，避免重复工作。

---

## 测试用例

| 场景 | 期望结果 |
|------|---------|
| 压缩点落在 tool_result 消息上 | 边界前移，不切断 tool pair |
| 压缩点落在 assistant+tool_use 后 | 边界后退，tool_use 随其 result 保护到尾部 |
| 旧工具结果 > 200 字符 | 被替换为占位符 |
| LLM 摘要失败 | 静默忽略，直接拼接 head + tail（无摘要） |
| 压缩后首条为 assistant | `normalizeMessages` 兜底修复（T01 完成后可移除） |
