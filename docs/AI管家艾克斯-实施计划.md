# AI管家艾克斯 - 实施计划

## 时间估算说明

**本计划基于使用 Claude Code 实现的时间估算**：

| 任务类型 | 预估时间 | 说明 |
|----------|----------|------|
| 项目初始化/配置 | 10-30分钟 | Claude Code可以快速生成配置文件 |
| 单个模块实现 | 15-60分钟 | 根据复杂度，包含类型定义和基本实现 |
| Shell脚本 | 5-15分钟 | 简单脚本很快完成 |
| 调试/修复 | 10-30分钟/次 | 取决于问题复杂度 |
| 测试验证 | 10-20分钟 | 基本功能测试 |

**总计预估**: 4-8小时的核心开发时间（不含调试迭代）

---

## 实施计划

### Phase 1: 基础框架（1-2小时）

#### 1.1 项目初始化（15分钟）
- [ ] 创建项目目录结构
- [ ] 初始化 package.json，安装依赖
- [ ] 配置 TypeScript (tsconfig.json)

#### 1.2 飞书SDK集成（30-45分钟）
- [ ] 实现飞书客户端封装 `src/feishu/client.ts`
- [ ] 实现WebSocket长连接消息接收
- [ ] 实现消息发送（文本、卡片）
- [ ] **验证**: 发消息给飞书机器人，能收到回复

#### 1.3 艾克斯Claude Agent核心（30-45分钟）
- [ ] 实现艾克斯入口 `src/index.ts`
- [ ] 实现艾克斯核心 `src/core/xdev.ts`
- [ ] 配置System Prompt
- [ ] **验证**: 飞书发消息，艾克斯能用Claude回复

---

### Phase 2: 核心功能（2-3小时）

#### 2.1 会话管理（30分钟）
- [ ] 定义会话类型 `src/session/types.ts`
- [ ] 实现SQLite存储 `src/storage/sqlite.ts`
- [ ] 实现会话管理器 `src/session/manager.ts`
- [ ] **验证**: 多轮对话上下文保持

#### 2.2 Worker管理器（45-60分钟）
- [ ] 实现tmux封装 `src/utils/tmux.ts`
- [ ] 定义Worker类型 `src/worker/types.ts`
- [ ] 实现Worker工厂 `src/worker/factory.ts`
- [ ] 实现Worker管理器 `src/worker/manager.ts`
- [ ] **验证**: 能创建tmux会话并启动claude CLI

#### 2.3 Hooks通知系统（45-60分钟）
- [ ] 编写 `scripts/notify_xdev.sh`
- [ ] 编写 `scripts/worker_completed.sh`
- [ ] 编写 `scripts/subagent_notify.sh`
- [ ] 实现Hooks接收器 `src/worker/hooks-receiver.ts`
- [ ] **验证**: Worker的Hook事件能触发通知

---

### Phase 3: 整合与部署（1-2小时）

#### 3.1 消息处理整合（30分钟）
- [ ] 实现消息处理器 `src/core/message-handler.ts`
- [ ] 整合任务复杂度判断
- [ ] 实现Worker工具函数（给Claude调用）
- [ ] **验证**: 完整流程：飞书→艾克斯→Worker→通知

#### 3.2 Systemd部署（20分钟）
- [ ] 编写 `xdev.service`
- [ ] 编写安装脚本 `install-xdev.sh`
- [ ] 创建环境变量模板
- [ ] **验证**: systemctl start xdev 正常启动

#### 3.3 Token优化（可选，30分钟）
- [ ] 实现对话历史压缩
- [ ] 实现通知节流

---

## 任务清单（可执行顺序）

```
□ 1. mkdir -p xdev/src/{core,feishu,session,worker,storage,utils}
□ 2. mkdir -p xdev/{scripts,config}
□ 3. 初始化 package.json 和 tsconfig.json
□ 4. 安装依赖
□ 5. 实现 src/feishu/client.ts
□ 6. 实现 src/feishu/types.ts
□ 7. 实现 src/core/xdev.ts
□ 8. 实现 src/index.ts
□ 9. 测试飞书消息收发
□ 10. 实现 src/session/types.ts
□ 11. 实现 src/storage/sqlite.ts
□ 12. 实现 src/session/manager.ts
□ 13. 实现 src/utils/tmux.ts
□ 14. 实现 src/worker/types.ts
□ 15. 实现 src/worker/factory.ts
□ 16. 实现 src/worker/manager.ts
□ 17. 编写 scripts/*.sh
□ 18. 实现 src/worker/hooks-receiver.ts
□ 19. 实现 src/core/message-handler.ts
□ 20. 编写 systemd 服务文件
□ 21. 编写安装脚本
□ 22. 端到端测试
```

---

## 预估总时间

| 阶段 | 预估时间 | 累计 |
|------|----------|------|
| Phase 1: 基础框架 | 1-2小时 | 1-2小时 |
| Phase 2: 核心功能 | 2-3小时 | 3-5小时 |
| Phase 3: 整合部署 | 1-2小时 | 4-7小时 |
| 调试迭代（缓冲） | 1-2小时 | **5-9小时** |

**实际可能更快**，取决于：
- Claude Code 对任务的理解程度
- 调试时遇到的问题数量
- 是否需要查阅额外文档

---

## 立即开始

```bash
# Step 1: 创建目录
mkdir -p xdev/src/{core,feishu,session,worker,storage,utils}
mkdir -p xdev/{scripts,config}

# Step 2: 初始化
cd xdev
npm init -y

# Step 3: 安装依赖
npm install typescript ts-node @types/node \
  @larksuiteoapi/node-sdk \
  better-sqlite3 \
  express \
  dotenv
npm install -D @types/better-sqlite3 @types/express

# Step 4: 创建tsconfig
npx tsc --init
```

---

**计划版本**: v2.0
**创建日期**: 2026-02-18
**估算方式**: 基于 Claude Code 实现速度
