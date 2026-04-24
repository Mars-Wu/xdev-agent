# xdev 飞书端到端测试用例

## 目标

验证 xdev 在飞书 P2P / 群聊场景下的核心可用能力：

1. 消息接收、回复与基础问答
2. 连续对话、多话题拆分与话题记忆
3. Clarify 澄清交互
4. 项目快照、任务 / 工作流、运维命令等工具链能力
5. 异常输入、超长消息、图片消息等边界行为
6. 服务日志、导出产物与运行状态的一致性

## 前置条件

1. xdev 已完成构建并以 systemd 用户服务运行
2. `lark-cli auth status` 与 `lark-cli doctor` 均通过
3. 已获得目标会话 `chat_id`
4. 终端已导出测试变量：

```bash
export CHAT_ID=<target_chat_id>
```

## 执行辅助命令

```bash
cd /home/wxy/data/claudeClaw/xdev
npm run build
npm run test:integration
systemctl --user restart xdev
systemctl --user status xdev --no-pager
journalctl --user -u xdev -f

lark-cli auth status --verify
lark-cli im +chat-messages-list --as user --chat-id "$CHAT_ID" --page-size 10 --format json
npm run test:live:feishu -- --list
npm run test:live:feishu -- --focus unfinished
```

## 自动化执行层

- **本地集成测试层**：`src/integration/**/*.test.ts`
  - 由 `npm run test:integration` 执行
  - 当前覆盖：同 chat 串行队列、clarify reply 等待/超时、多轮 topic history 续接、交错话题隔离
- **Live Feishu 执行层**：`tests/live-feishu/`
  - `tests/live-feishu/cases.ts` 维护 IM-001 ~ IM-012 的可执行/手动 case 定义
  - `tests/live-feishu/run-live-suite.ts` 通过 `lark-cli` 执行自动化 case、抓取回复并落盘 `summary.json`
  - 默认执行全部 automated case；`--focus unfinished` 用于聚焦未签收重点（当前为 IM-005 ~ IM-010）

## 测试矩阵

| ID | 能力面 | 优先级 | CLI 可执行 |
| --- | --- | --- | --- |
| IM-001 | 基础连通性与身份回复 | P0 | 是 |
| IM-002 | 连续上下文承接 | P0 | 是 |
| IM-003 | 多话题拆分 | P0 | 是 |
| IM-004 | Clarify 澄清交互 | P0 | 是 |
| IM-005 | map 项目快照能力 | P1 | 是 |
| IM-006 | workflow 阶段化执行 | P1 | 是 |
| IM-007 | task DAG / ready tasks | P1 | 是 |
| IM-008 | 运维命令与导出产物 | P1 | 是 |
| IM-009 | Slash 未知命令兜底 | P1 | 是 |
| IM-010 | 超长消息拒绝 | P1 | 是 |
| IM-011 | 图片分析链路 | P2 | 条件执行 |
| IM-012 | 文件 / 资源消息处理 | P2 | 条件执行 |

## 详细用例

### IM-001 基础连通性与身份回复

- **目标**：验证消息入站、模型出站、飞书回包正常
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "你好，艾克斯。请用一句话说明你是谁，并列出你当前最核心的三项能力。"
```

- **预期回复**：
  - 返回 1 条正常文本或富文本回复
  - 回复中包含“艾克斯”身份说明
  - 能力描述与当前项目定位一致
- **预期日志 / 副作用**：
  - `收到飞书消息`
  - `Agent 回复`
  - 无 `处理消息失败`
- **通过标准**：消息成功送达，回复语义正确且无异常日志

### IM-002 连续上下文承接

- **目标**：验证“上一轮话题”连续性判断
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "把第二项能力展开成 3 条要点，并尽量结合当前 xdev 项目。"
```

- **预期回复**：
  - 不要求重复澄清“第二项能力”指什么
  - 能正确承接 IM-001 的上一轮回答
- **预期日志 / 副作用**：
  - 同一 chat 的连续处理日志
  - 不应出现明显的新话题误判症状
- **通过标准**：回复正确引用上一轮上下文

### IM-003 多话题拆分

- **目标**：验证路由器将一个消息拆成多个独立子问题
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "请分别回答两件事：第一，xdev doctor 是做什么的；第二，workflow 工具现在支持哪些阶段化能力。"
```

- **预期回复**：
  - 同时覆盖两个问题
  - 常见表现是使用分段或 `---` 分隔
- **预期日志 / 副作用**：
  - 出现 `多话题拆分`
  - 至少 2 个子问题并行处理
- **通过标准**：两个问题都被覆盖，且日志能看出拆分处理

### IM-004 Clarify 澄清交互

- **目标**：验证 Clarify 工具能主动追问，并接受用户后续回复
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "帮我在飞书里创建一个东西，我还没决定是文档、表格还是多维表。"
```

- **后续回复**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "先按电子表格理解。"
```

- **预期回复**：
  - 首轮应返回 Clarify 问题，通常是互动卡片或富文本追问
  - 次轮能把“电子表格”识别为澄清结果继续处理
- **预期日志 / 副作用**：
  - 不出现 `Clarify 工具交互失败`
  - 下一条用户消息被当作 clarify reply 消费
- **通过标准**：澄清问题成功触发，后续回复被正确承接

### IM-005 map 项目快照能力

- **目标**：验证 map 工具对当前仓库的结构化概览能力
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "请使用 map 能力概览当前 xdev 项目，给我核心目录、关键模块职责和常用命令。"
```

- **预期回复**：
  - 覆盖目录结构、核心模块、构建 / 测试 / 服务命令
  - 结果与当前仓库状态一致
- **预期日志 / 副作用**：
  - 可能触发 codebase map 生成或缓存命中
- **通过标准**：回复内容真实反映当前项目结构

### IM-006 workflow 阶段化执行

- **目标**：验证 workflow 工具的创建与阶段说明能力
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "请为“验证飞书测试链路”创建一个 3 阶段 workflow，并给出每个阶段的 pass criteria。"
```

- **预期回复**：
  - 返回 workflow 方案，包含阶段名与通过条件
  - 最好包含 workflow id 或结构化阶段说明
- **预期日志 / 副作用**：
  - workflow runtime 写入运行记录
- **通过标准**：回复体现阶段化工作流，而不是普通口头建议

### IM-007 task DAG / ready tasks

- **目标**：验证 task tool 和依赖关系表达
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "请创建 3 个与飞书联调相关的任务：先确认 chat_id，再发送测试消息，最后导出状态；其中后两者分别依赖前一项，然后告诉我当前 ready tasks。"
```

- **预期回复**：
  - 能表示任务依赖关系
  - 能给出 ready task 判断
- **预期日志 / 副作用**：
  - task system 状态发生更新
- **通过标准**：ready / blocked 关系符合依赖设定

### IM-008 运维命令与导出产物

- **目标**：验证 xdev 可通过工具调用本地运维入口
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "请执行 xdev export-status，并告诉我生成了哪些导出产物路径。"
```

- **预期回复**：
  - 至少提到 codebase map 与 observability artifacts
  - 路径指向 `XDEV_HOME/cache/...`
- **预期日志 / 副作用**：
  - 导出命令执行成功
  - 相关产物文件更新时间刷新
- **通过标准**：回复的路径与实际磁盘产物一致

### IM-009 Slash 未知命令兜底

- **目标**：验证 slash 未启用时的安全兜底
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "/status"
```

- **预期回复**：
  - `未知命令: /status`
- **预期日志 / 副作用**：
  - 不进入正常 Agent Loop
- **通过标准**：明确拒绝未知 slash 命令

### IM-010 超长消息拒绝

- **目标**：验证超长输入保护
- **发送内容**：

```bash
lark-cli im +messages-send --as user --chat-id "$CHAT_ID" --text "$(python - <<'PY'
print('超长消息测试' + 'A' * 12000)
PY
)"
```

- **预期回复**：
  - 明确提示消息过长、已拒绝处理
  - 包含长度与限制说明
- **预期日志 / 副作用**：
  - `消息过长被拒绝`
- **通过标准**：未进入正常处理链，且系统无异常

### IM-011 图片分析链路（条件执行）

- **目标**：验证飞书图片下载与 GLM 视觉分析
- **执行前提**：
  - 当前 app 已具备图片资源权限
  - `ZHIPU_API_KEY` 可访问视觉模型
- **发送方式**：
  - 先上传图片资源
  - 再发送图片消息或在飞书客户端手动给机器人发图
- **预期回复**：
  - 回复中出现图片内容描述
  - 若附带问题，应一并回答
- **预期日志 / 副作用**：
  - `收到飞书图片消息`
  - `图片已下载`
  - `图片分析完成`
- **通过标准**：图片被正确识别；若失败，至少回落为明确的失败提示

### IM-012 文件 / 资源消息处理（条件执行）

- **目标**：验证文件类资源消息的接收与后续处理能力
- **执行前提**：
  - 当前 app 已具备文件资源权限
  - 业务路径已实现对应文件解析或兜底说明
- **发送方式**：
  - 使用飞书客户端或 CLI 上传文件后发送给 xdev
- **预期回复**：
  - 至少能明确说明是否支持当前类型
  - 不应导致服务崩溃
- **预期日志 / 副作用**：
  - 资源下载 / 解析相关日志
- **通过标准**：链路可观测，失败时有清晰反馈

## 执行建议

1. P0 用例每次发布后必跑
2. P1 用例在工具、工作流、运维链路变更后必跑
3. P2 用例在权限、模型或资源处理链路变更后补跑
4. 每次跑完至少补查一次：

```bash
lark-cli im +chat-messages-list --as user --chat-id "$CHAT_ID" --page-size 20 --format json
xdev export-status
```

5. 若出现异常，优先保留：
  - 发送消息 ID
  - 对应回复消息 ID
  - `journalctl --user -u xdev` 关键日志片段
  - 导出产物路径与时间戳
