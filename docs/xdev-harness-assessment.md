# 艾克斯项目 Harness 工程评估报告

> 基于 OpenAI 和 Anthropic 的 Harness 工程最佳实践，对艾克斯项目框架结构进行审视

---

## 一、总体评估

| 维度 | 当前状态 | 评分 |
|------|----------|------|
| 环境设计 | 部分实现 | ⭐⭐⭐ |
| 状态追踪 | 良好 | ⭐⭐⭐⭐ |
| 增量工作流 | 需改进 | ⭐⭐ |
| 架构约束 | 基础实现 | ⭐⭐⭐ |
| 测试验证 | 缺失 | ⭐ |
| 文档管理 | 需加强 | ⭐⭐ |

**总体评价**：艾克斯项目已经具备了一些 Harness 工程的基础能力（专家系统、会话管理、SQLite 持久化），但在长时运行 Agent 的状态管理和自验证方面有明显短板。

---

## 二、优势分析（已实现的最佳实践）

### ✅ 1. 专家系统架构（多 Agent 模式）

**对应最佳实践**：Anthropic 提到的多 Agent 架构可能性

```
~/.xdev/experts/
├── coder/CLAUDE.md
├── analyst/CLAUDE.md
├── operator/CLAUDE.md
├── researcher/CLAUDE.md
├── product-manager/CLAUDE.md
├── marketing/CLAUDE.md
├── business-planner/CLAUDE.md
└── copywriter/CLAUDE.md
```

**优势**：
- 专业化分工明确
- 每个 Agent 有独立的 CLAUDE.md 定义角色和能力
- 会话基于 workDir 隔离

### ✅ 2. 持久化存储

**对应最佳实践**：OpenAI 提到的"代码仓库作为记录系统"

```
~/.xdev/
├── xdev.db          # SQLite 数据库
├── memory.db           # 记忆存储
├── experts/            # 专家配置
├── workers/            # Worker 元数据
└── system-prompt.md    # 系统提示词
```

**优势**：
- 使用 SQLite 持久化会话、任务、Cron 任务
- 数据库支持专家会话历史查询
- Cron 任务持久化，重启后自动恢复

### ✅ 3. 会话管理（SessionManager）

**对应最佳实践**：Anthropic 的"会话策略"

```typescript
// src/expert/manager.ts
continue: false  // 新会话
continue: true   // 继续会话（--continue）
```

**优势**：
- 支持 `--continue` 恢复上次会话
- 会话基于工作目录隔离
- 有会话历史记录

### ✅ 4. 配置管理

**对应最佳实践**：OpenAI 的"渐进式披露"

```typescript
// src/config.ts
// 多层配置：环境变量 > Claude settings > 默认值
// 统一路径配置对象 PATHS
```

**优势**：
- 配置来源分层
- 路径配置集中管理
- 支持环境变量覆盖

### ✅ 5. System Prompt 作为地图

**对应最佳实践**：OpenAI 的"AGENTS.md 作为内容目录"

```markdown
# ~/.xdev/system-prompt.md
## 身份
## 消息来源
## AI 专家系统
## 会话策略
...
```

**优势**：
- 结构化提示词
- 包含 API 使用说明
- 定义了消息处理流程

---

## 三、差距分析（需改进的方面）

### ❌ 1. 缺少初始化 Agent (Initializer Agent)

**最佳实践**：Anthropic 建议首次运行时设置环境

**当前问题**：
- 没有 `init.sh` 脚本
- 没有自动化的环境设置流程
- 新 Agent 启动时需要手动了解环境

**建议改进**：

```bash
# 新增 ~/.xdev/init.sh
#!/bin/bash
# 艾克斯环境初始化脚本
# 1. 检查依赖
# 2. 初始化数据库
# 3. 启动必要服务
# 4. 运行健康检查
```

### ❌ 2. 缺少 Progress 文件（进度追踪）

**最佳实践**：Anthropic 的 `claude-progress.txt`

**当前问题**：
- 会话历史存在数据库，但不适合 Agent 直接阅读
- 新 Agent 无法快速了解"最近做了什么"
- 缺少人类可读的进度日志

**建议改进**：

```typescript
// 在每个 workDir 创建 .xdev-progress.md
# 工作进度日志

## 2026-03-19 10:30 - coder
- 实现了用户登录功能
- 添加了密码加密

## 2026-03-19 11:45 - coder
- 添加记住密码功能
- 修复登录验证 bug
```

### ❌ 3. 缺少 Feature List（功能清单）

**最佳实践**：Anthropic 的 JSON 功能清单，防止 Agent 提前宣布完成

**当前问题**：
- 没有"什么算完成"的明确定义
- Agent 可能提前宣布任务完成
- 缺少可验证的功能列表

**建议改进**：

```json
// workDir/.xdev-features.json
{
  "features": [
    {
      "id": "user-login",
      "description": "用户可以登录系统",
      "steps": ["输入用户名", "输入密码", "点击登录", "看到欢迎页"],
      "status": "pending"
    },
    {
      "id": "remember-password",
      "description": "记住密码功能",
      "steps": ["勾选记住密码", "下次自动填充"],
      "status": "pending"
    }
  ]
}
```

### ❌ 4. 缺少端到端测试机制

**最佳实践**：Anthropic 的 Puppeteer MCP 端到端测试

**当前问题**：
- 没有 Agent 可用的测试工具
- 无法验证功能是否真正工作
- 依赖人工验证

**建议改进**：

```typescript
// 为 Agent 提供测试工具
// 1. 浏览器自动化（Puppeteer/Playwright）
// 2. HTTP 请求验证
// 3. 日志分析工具

// 在 system-prompt.md 中添加
## 测试工具

验证功能时使用：
1. 对于 Web 应用：使用 curl 测试 API
2. 检查服务状态：systemctl status xxx
3. 查看日志：journalctl -u xxx
```

### ❌ 5. 缺少"黄金原则"和 Lint 规则

**最佳实践**：OpenAI 的"品味不变式"和自定义 Lint

**当前问题**：
- 没有编码风格约束
- Agent 可能复制不良模式
- 缺少"垃圾回收"机制

**建议改进**：

```typescript
// 新增 src/lint/agent-rules.ts
export const GOLDEN_PRINCIPLES = [
  "使用共享工具函数，避免重复代码",
  "边界处验证数据，不使用 YOLO 式探测",
  "日志使用结构化格式",
  "文件大小不超过 300 行",
  // ...
];
```

### ⚠️ 6. 文档结构待优化

**最佳实践**：OpenAI 的 docs/ 目录结构

**当前问题**：
- docs/ 目录刚创建，内容有限
- 缺少架构文档、决策日志
- 没有文档验证机制

**建议改进**：

```
~/.xdev/docs/
├── architecture/
│   └── overview.md       # 架构概览
├── decisions/
│   └── 2026-03-19-expert-system.md  # 决策日志
├── plans/
│   └── active/
│       └── cron-feature.md  # 活跃计划
└── quality/
    └── golden-principles.md  # 黄金原则
```

---

## 四、具体改进建议

### Phase 1: 状态追踪增强（优先级：高）

| 改进项 | 文件 | 工作量 |
|--------|------|--------|
| 添加 Progress 文件机制 | `src/expert/progress-tracker.ts` | 2h |
| 添加 Feature List 支持 | `src/expert/feature-list.ts` | 2h |
| 更新 System Prompt | `~/.xdev/system-prompt.md` | 1h |

### Phase 2: 初始化和验证（优先级：中）

| 改进项 | 文件 | 工作量 |
|--------|------|--------|
| 创建 init.sh 脚本 | `scripts/init.sh` | 1h |
| 添加会话启动验证流程 | `src/expert/session-manager.ts` | 2h |
| 添加基础测试工具 | `src/tools/tester.ts` | 3h |

### Phase 3: 架构约束（优先级：中）

| 改进项 | 文件 | 工作量 |
|--------|------|--------|
| 定义黄金原则 | `docs/golden-principles.md` | 1h |
| 创建架构文档 | `docs/architecture/` | 2h |
| 添加文档验证 CI | `.github/workflows/` | 1h |

### Phase 4: 长期优化（优先级：低）

| 改进项 | 文件 | 工作量 |
|--------|------|--------|
| Agent 对 Agent 审核 | `src/expert/reviewer.ts` | 4h |
| 垃圾回收机制 | `src/expert/gc.ts` | 2h |
| 浏览器自动化集成 | `src/tools/browser.ts` | 4h |

---

## 五、立即可行的改进

以下改进可以立即实施，无需大量代码修改：

### 1. 更新 System Prompt

在 `~/.xdev/system-prompt.md` 添加：

```markdown
## 工作流程规范

### 会话开始时
1. 读取 git log 了解最近工作
2. 读取工作目录的 README.md
3. 确认当前任务目标

### 会话结束时
1. git commit 提交变更
2. 更新相关文档
3. 汇报完成状态

### 功能验证
在标记任务完成前，必须：
1. 运行相关测试
2. 检查服务状态
3. 验证端到端功能
```

### 2. 创建工作目录模板

```bash
# ~/.xdev/templates/workdir/
# 新项目时复制此模板

README.md          # 项目说明
TODO.md            # 待办事项
CHANGELOG.md       # 变更日志
```

### 3. 添加会话总结机制

在专家完成任务时，自动生成总结：

```typescript
// 专家完成时生成
// workDir/.xdev-session-{timestamp}.md
# 会话总结

**时间**: 2026-03-19 10:30
**专家**: coder
**任务**: 实现用户登录

## 完成内容
- 创建登录页面
- 实现密码加密
- 添加 session 管理

## 遗留问题
- 记住密码功能待实现
- 需要添加验证码

## 下一步建议
1. 实现记住密码
2. 添加登录日志
```

---

## 六、总结

艾克斯项目已经具备了 Harness 工程的**基础设施**（专家系统、持久化、会话管理），但在**状态可读性**和**自验证**方面需要加强。

**最关键的三个改进**：

1. **Progress 文件** - 让新 Agent 能快速了解历史工作
2. **Feature List** - 明确定义"什么算完成"
3. **测试验证** - Agent 必须能验证自己的工作

这三个改进将显著提升 Agent 在多上下文窗口场景下的工作连贯性和可靠性。

---

*评估日期: 2026-03-19*
*评估人: Claude (艾克斯优化 Worker)*
