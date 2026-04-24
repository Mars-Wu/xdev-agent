// src/utils/interrupt.ts
// 全局中断信号 — 参考 Hermes tools/interrupt.py（极简设计）
// Node.js 单线程，用普通变量即可（无需 Mutex）

let _interrupted = false

/**
 * 设置中断状态（由飞书消息处理器或 CLI 调用）
 */
export function setInterrupt(active: boolean): void {
  _interrupted = active
}

/**
 * 检查是否已中断（工具执行循环中轮询）
 */
export function isInterrupted(): boolean {
  return _interrupted
}

/**
 * 每轮 Agent Loop 开始时重置（防止上一轮中断状态污染下一轮）
 */
export function resetInterrupt(): void {
  _interrupted = false
}
