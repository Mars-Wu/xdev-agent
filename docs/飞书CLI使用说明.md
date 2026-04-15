# 飞书 CLI 使用说明

## 1. 飞书 CLI 是什么

飞书 CLI（`lark-cli`）是一个把飞书开放能力暴露给终端和 AI Agent 的命令行工具。按官方文档，它可以让 Agent 直接操作飞书里的消息、文档、日历、多维表格、知识库、邮箱、任务等对象，而不是只生成一段让人手工复制的文本。

官方文档：

- <https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu>
- 开源仓库：<https://github.com/larksuite/cli>

## 2. 快速开始

官方推荐流程如下：

```bash
npm install -g @larksuite/cli
npx skills add https://github.com/larksuite/cli -y -g
lark-cli config init --new
```

如果要让 AI 以**你的身份**访问你的日历、私信、邮箱等个人数据，还需要执行：

```bash
lark-cli auth login
```

说明：

- `config init` 负责配置应用（App ID / App Secret / 品牌）。
- `auth login` 负责用户授权。
- 只完成 `config init` 但**不做 `auth login`** 时，CLI 仍可用，但通常只能以应用 bot 身份工作。

## 3. 当前安装版本里最常用的命令

### 3.1 全局帮助与健康检查

```bash
lark-cli help
lark-cli doctor
```

`doctor` 会检查本地配置、登录状态和飞书端点连通性。

### 3.2 配置与授权

```bash
lark-cli config init --new
lark-cli auth status
lark-cli auth login
lark-cli auth scopes
lark-cli auth check --scope <scope>
```

常见用途：

| 命令 | 用途 |
| --- | --- |
| `lark-cli config init --new` | 新建或初始化一个飞书应用配置 |
| `lark-cli auth status` | 查看当前是 user / bot 哪种身份可用 |
| `lark-cli auth login` | 登录用户身份 |
| `lark-cli auth scopes` | 查看应用当前启用的 scopes |
| `lark-cli auth check --scope ...` | 检查某项权限是否具备 |

### 3.3 常见业务域

当前 CLI 内置的主命令包括：

- `im`：消息与群组
- `docs`：云文档
- `drive`：云空间文件
- `calendar`：日历
- `sheets`：电子表格
- `base`：多维表格
- `wiki`：知识库
- `mail`：邮箱
- `task`：任务
- `contact`：通讯录

可以通过下面的方式继续查看细节：

```bash
lark-cli <command> --help
lark-cli schema <service.resource.method> --format pretty
```

## 4. 消息相关的典型用法

### 4.1 查找群聊

```bash
lark-cli im +chat-search --as bot --query "项目群" --format table
```

常用参数：

- `--as user|bot`：指定身份
- `--query`：按名称或成员关键词搜索
- `--format table|json|pretty`：控制输出格式

### 4.2 发送消息

给群聊发消息：

```bash
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "你好"
```

给用户发消息：

```bash
lark-cli im +messages-send --as user --user-id ou_xxx --text "你好"
```

发送 Markdown：

```bash
lark-cli im +messages-send --as user --chat-id oc_xxx --markdown "# 今日同步\n- 事项 A\n- 事项 B"
```

命令帮助显示，`+messages-send` 支持：

- `--chat-id` / `--user-id`
- `--text`
- `--markdown`
- `--image`
- `--file`
- `--video`
- `--audio`
- `--idempotency-key`

### 4.3 回复已有消息

```bash
lark-cli im +messages-reply --help
```

适合在已有线程或话题下继续回复，而不是新发一条消息。

## 5. 与 AI Agent 配合时的推荐方式

如果是给 Claude Code、Codex、Cursor、TRAE 之类的 Agent 用，推荐：

```bash
npx skills add larksuite/cli -g -y
```

或者按业务域安装：

```bash
npx skills add larksuite/cli -s lark-im -y
npx skills add larksuite/cli -s lark-calendar -y
```

这样 Agent 不只是“能调用命令”，还会带上飞书场景的操作约束和工作流知识。

## 6. 官方能力地图（浓缩版）

按官方文档，飞书 CLI 覆盖的核心能力包括：

| 业务域 | 能做什么 |
| --- | --- |
| 消息与群组 | 搜索群聊、查消息、发消息、回复话题 |
| 云文档 | 创建、读取、更新正文、评论协作 |
| 云空间 | 上传下载文件、权限管理、评论管理 |
| 电子表格 | 创建表格、读写单元格、追加数据 |
| 多维表格 | 建表、字段、记录、视图、仪表盘、自动化 |
| 日历 | 查日程、查忙闲、约会议、找空闲时间 |
| 视频会议 | 搜会议、取纪要、取逐字稿 |
| 邮箱 | 搜索、读取、起草、发送、归档 |
| 任务 | 创建任务、更新状态、管理清单 |
| 知识库 / 通讯录 | 查空间、查用户、查部门、查节点 |

## 7. 当前仓库里的“小智”接入方式

从当前代码和配置看，小智是一个**飞书应用机器人**：

- `xiaozhi/src/feishu/client.ts` 使用 `@larksuiteoapi/node-sdk`
- 通过 `WSClient` 订阅 `im.message.receive_v1`
- 收到飞书消息后进入 `xiaozhi/src/index.ts` 的 `handleMessage(...)`
- 回复通过 `client.im.message.create(...)` 发回飞书

仓库文档 `xiaozhi/docs/GUIDE.md` 也明确写了：

1. 在飞书中找到小智机器人
2. 直接发送消息

也就是说，**小智的主交互入口本来就是飞书 IM。**

## 8. 当前环境评估：已验证可以通过飞书 CLI 给小智发消息

### 8.1 已确认的事实

1. **小智服务当前在运行中**  
   `systemctl --user status xiaozhi` 显示服务为 `active (running)`。

2. **小智飞书通道已启用**  
   服务日志显示 WebSocket 客户端 ready，并通过飞书收发消息。

3. **本机 lark-cli 已完成用户登录**  
   `lark-cli auth status` 显示当前身份为 **user**，token 状态有效。

4. **当前 lark-cli 配置的应用，与小智运行所用应用不是同一个**  
   本机 `lark-cli` 当前解析到的是一个独立的 app；`xiaozhi/.env` 中配置的是另一个 app。

5. **按会话名不一定能直接搜到“小智”**  
   即使切到 `--as user`，`lark-cli im +chat-search --query 小智` 也可能返回 0 条；机器人 P2P 会话在搜索和列举上的表现与普通群聊并不完全一致。

6. **已完成两次实际发送验证**  
   一次是以 `--as user` 向“飞书新用户体验群”发送测试消息，并在手机客户端确认同步可见；另一次是先向小智发送一条消息，再通过消息搜索反查出与小智的 P2P `chat_id`，随后确认可以直接使用该 `chat_id` 发送消息。

### 8.2 结论

**当前环境已经验证：可以通过飞书 CLI 给小智发消息。**

注意点有两个：

- 应优先使用 **user 身份**（`--as user`），而不是 bot 身份
- 给机器人发消息时，**不能只依赖 `+chat-search` 按名字查会话**；必要时要通过 `+messages-search` 先从消息记录里反查 `chat_id`

### 8.3 理论上可行的两条路径

#### 路径 A：用用户身份发给小智（更推荐）

适用场景：你本人在飞书里能看到并能直接给“小智”发消息。

步骤：

```bash
lark-cli auth login

# 如果能直接搜到会话
lark-cli im +chat-search --as user --query "小智" --format table
lark-cli im +messages-send --as user --chat-id <xiaozhi_chat_id> --text "你好，小智"
```

如果按名字搜不到，改用下面的方法先反查 `chat_id`：

```bash
# 先在飞书里手动给小智发一条消息

# 再从消息记录反查会话
lark-cli im +messages-search --as user --query "你好，小智" --format json

# 得到 chat_id 后直接发送
lark-cli im +messages-send --as user --chat-id <xiaozhi_chat_id> --text "继续测试"
```

这条路径已经在当前环境中验证成功。

#### 路径 B：让 lark-cli 和小智共用同一个应用

适用场景：希望 CLI 直接站在“小智这个 bot”的身份上工作。

做法是把 `lark-cli config init` 指向与小智服务相同的飞书应用，再补齐需要的 IM scopes。

这条路径更像“让 CLI 直接操控小智的 bot 身份”，适合联调和自动化，但要注意：

- 需要复用同一应用配置
- 需要确认消息发送 scope

### 8.4 针对当前环境的判断

基于实际验证，更准确的说法是：

- **小智具备接收飞书消息的能力**
- **飞书 CLI 具备以 user 身份发送消息的能力**
- **当前这台机器已经可以通过飞书 CLI 与小智对话**

当前最稳妥的使用方式，是优先走**路径 A（用户身份）**。如果后续再次遇到“按名称搜不到小智会话”，不要先怀疑消息链路，优先用 `+messages-search` 从已有消息反查 `chat_id`。

## 9. 当前仓库里的 lark-cli 工具层集成状态

截至当前版本，`xiaozhi/` 已经把 `lark-cli` 接成一组可供 Agent 直接调用的结构化工具，定位是**飞书能力工具层**，而不是消息入口。

当前已接入两批工具：

| 工具名 | 作用 |
| --- | --- |
| `lark_auth_status` | 检查当前 `lark-cli` 的身份、token 校验和 doctor 状态 |
| `lark_contact_search_user` | 搜索用户并返回 `open_id` |
| `lark_im_send` | 向 `chat_id` 或 `user_id` 发送文本 / Markdown 消息 |
| `lark_im_search_messages` | 搜索消息并返回 `message_id`、`chat_id`、时间和摘要 |
| `lark_docs_search` | 搜索飞书文档、知识库和表格文件 |
| `lark_docs_fetch` | 读取指定文档内容 |
| `lark_docs_create` | 创建文档，支持 Markdown 和 dry-run |
| `lark_docs_update` | 更新文档内容或标题，支持多种 mode 和 dry-run |
| `lark_calendar_agenda` | 读取 agenda 日程 |
| `lark_calendar_freebusy` | 查询忙闲状态 |
| `lark_calendar_create` | 创建日程，支持参会人和 dry-run |

实现方式：

- 工具代码位于 `xiaozhi/src/tools/lark/`
- 通过共享 runner 调用 `lark-cli`
- 使用结构化参数，而不是让 Agent 直接拼接 shell
- 默认注册到 `createDefaultToolRegistry()` 中

当前架构仍保持：

- **飞书直连 SDK / WebSocket**：负责小智收消息、回消息
- **lark-cli 工具层**：负责让小智主动调用飞书能力

这也是当前仓库里更推荐的职责划分。

### 9.1 当前环境里的实际可用性

已做过运行态验证：

- `lark_docs_search` 可以直接返回真实文档结果
- `lark_docs_create` 的 `dry_run` 可正常返回结构化预览
- `lark_calendar_agenda` / `lark_calendar_freebusy` / `lark_calendar_create` 已具备工具封装，但当前用户授权**缺少 calendar 相关 scopes**，因此会明确返回缺少权限的错误，而不是静默失败

也就是说，**代码层面日历工具已接入，小智已经会调用；当前阻塞点是本机 `lark-cli` 用户授权范围，而不是代码实现。**
