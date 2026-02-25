# Hooks 通知测试报告

## 任务完成状态
✅ 已完成

## 问题诊断

通过测试发现，Worker 的 hooks 通知功能无法正常工作，原因是**脚本中的 API 路径与 hooks-receiver 服务监听的路径不匹配**。

## 详细分析

### 1. 脚本发送的路径

**notify_xiaozhi.sh** (第30行):
```bash
curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/notify"
```

**worker_completed.sh** (第36行):
```bash
curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/complete"
```

### 2. hooks-receiver 监听的路径

**hooks-receiver.ts** (第41-44行):
```typescript
this.app.post('/hooks/notification', this.handleNotification.bind(this));
this.app.post('/hooks/stop', this.handleComplete.bind(this));
this.app.post('/hooks/subagent-stop', this.handleSubagent.bind(this));
this.app.post('/hooks/post-tool-use', this.handlePostToolUse.bind(this));
```

### 3. 路径对照表

| 功能 | 脚本使用的路径 | 服务监听的路径 | 状态 |
|------|--------------|--------------|------|
| 进度通知 | `/internal/worker/notify` | `/hooks/notification` | ❌ 不匹配 |
| 完成通知 | `/internal/worker/complete` | `/hooks/stop` | ❌ 不匹配 |

## 测试验证

```bash
# /hooks/notification 路由存在
$ curl -X POST http://localhost:8081/hooks/notification -d '{"worker_id": "test"}'
Worker not found  # 正常响应（只是没有找到 worker）

# /internal/worker/notify 路由不存在
$ curl -X POST http://localhost:8081/internal/worker/notify -d '{"worker_id": "test"}'
Cannot POST /internal/worker/notify  # 404 错误
```

## 解决方案

有两种修复方式：

### 方案 A: 修改脚本路径（推荐）

修改两个脚本文件，将 API 路径改为与 hooks-receiver 一致：

**notify_xiaozhi.sh**:
```diff
- curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/notify"
+ curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/hooks/notification"
```

**worker_completed.sh**:
```diff
- curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/complete"
+ curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/hooks/stop"
```

### 方案 B: 在 hooks-receiver 添加别名路由

在 `hooks-receiver.ts` 的 `setupRoutes()` 方法中添加兼容路由：

```typescript
// 兼容旧路径
this.app.post('/internal/worker/notify', this.handleNotification.bind(this));
this.app.post('/internal/worker/complete', this.handleComplete.bind(this));
```

## 其他发现

1. Hooks 服务正常运行在端口 8081
2. 健康检查端点 `/health` 工作正常
3. 数据库和 Worker 元数据结构设计合理

## 建议

推荐采用**方案 A**，修改脚本路径。这样可以保持 API 路径的语义清晰：
- `/hooks/notification` - 更清晰地表达这是 hooks 的通知端点
- `/hooks/stop` - 对应 Claude 的 Stop hook 事件
