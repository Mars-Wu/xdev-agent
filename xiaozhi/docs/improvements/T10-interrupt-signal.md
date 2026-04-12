# T10 · 中断信号

> 参考: `~/data/hermes-agent/tools/interrupt.py`（~30行，极简设计）  
> 目标文件: 新建 `src/utils/interrupt.ts`，修改 `src/tools/bash-tool.ts`，修改 `src/core/agent-loop.ts`，修改飞书消息处理器

---

## 问题背景

长时间运行的 bash 命令（如 `npm run build`、`sleep 100`、慢 curl 请求）无法被用户打断。
用户发送 `/stop` 或 Ctrl+C 类指令后，命令应立即终止，Agent 返回 `[interrupted]`。

---

## Hermes 设计（极简全局事件）

```python
import threading

_interrupt_event = threading.Event()

def set_interrupt(active: bool) -> None:
    if active:
        _interrupt_event.set()
    else:
        _interrupt_event.clear()

def is_interrupted() -> bool:
    return _interrupt_event.is_set()
```

Node.js 等价实现：用 `{ interrupted: boolean }` 可变对象替代 threading.Event。

---

## 执行方案

### 1. 新建 `src/utils/interrupt.ts`

```typescript
/**
 * 全局中断信号 — 进程内任何工具都可以检查此状态
 * 不使用类，保持极简（对应 Hermes interrupt.py）
 */
let _interrupted = false;

export function setInterrupt(active: boolean): void {
  _interrupted = active;
}

export function isInterrupted(): boolean {
  return _interrupted;
}

export function resetInterrupt(): void {
  _interrupted = false;
}
```

### 2. 修改 `src/tools/bash-tool.ts`

在命令执行主循环中轮询中断状态：

```typescript
import { isInterrupted } from '../utils/interrupt';

// 在 child_process spawn + 循环读取输出处：
const proc = spawn('bash', ['-c', command], { ... });
let output = '';
let killed = false;

const checkInterval = setInterval(() => {
  if (isInterrupted() && !killed) {
    killed = true;
    proc.kill('SIGINT');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 2000);
  }
}, 500); // 每500ms 检查一次

proc.stdout.on('data', (data) => { output += data.toString(); });
proc.stderr.on('data', (data) => { output += data.toString(); });

await new Promise<void>((resolve) => {
  proc.on('close', (code) => {
    clearInterval(checkInterval);
    exitCode = code ?? -1;
    resolve();
  });
});

if (killed) {
  return {
    output: output + '\n[interrupted by user]',
    exitCode: 130,
    interrupted: true,
  };
}
```

### 3. 修改 `src/core/agent-loop.ts`

每轮 loop 开始时重置中断状态：

```typescript
import { resetInterrupt } from '../utils/interrupt';

// 在主循环顶部：
while (true) {
  resetInterrupt(); // 每轮开始前重置

  // ... 现有逻辑
}
```

### 4. 修改飞书消息处理器（`src/index.ts` 或 feishu 相关文件）

检测 `/stop`、`/中断`、`/interrupt` 命令：

```typescript
import { setInterrupt } from './utils/interrupt';

// 在消息处理入口：
function handleFeishuMessage(text: string, ctx: MessageContext) {
  const trimmed = text.trim().toLowerCase();
  if (['/stop', '/中断', '/interrupt', '/cancel'].includes(trimmed)) {
    setInterrupt(true);
    ctx.reply('⏹ 已发送中断信号，正在停止当前命令...');
    return;
  }
  // ... 正常处理逻辑
}
```

---

## 工作流程示例

```
用户: "帮我运行 npm run build"
小智: 执行 bash: npm run build（长时间运行）

用户（另一条消息）: "/stop"
→ setInterrupt(true)
→ 500ms 内 checkInterval 触发
→ proc.kill('SIGINT')
→ bash 命令终止
→ 小智回复: "[bash 输出前几行]\n[interrupted by user]"

下一轮对话开始时：
→ resetInterrupt()  ← 防止上一轮的中断状态污染下一轮
```

---

## 注意事项

- `setInterval` 轮询间隔500ms，对用户来说响应足够快，CPU 开销极低
- 对于非 bash 工具（browser、http 请求），也应在其主循环中检查 `isInterrupted()`
- 飞书的中断命令（`/stop`）应优先于正常消息处理，不进入 agent 队列
- 中断后 Agent 会收到 `[interrupted by user]` 作为工具结果，LLM 会自动告知用户任务已中止
- Node.js 是单线程，不存在竞态条件，简单变量即可，无需 Mutex
