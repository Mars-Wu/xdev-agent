# OpenClaw 项目分析

本目录用于持续跟踪和分析 [OpenClaw](https://github.com/openclaw/openclaw) 项目，
识别对 claudeClaw（小智）有帮助的技术方案和最佳实践。

## 目录结构

```
openclaw-analysis/
├── README.md                    # 本文件 - 分析目录说明
├── 2026-03-21-evaluation.md     # 项目评估文档
└── future/                      # 未来分析报告存放目录
```

## OpenClaw 项目简介

OpenClaw 是一个开源的个人 AI 助手框架，支持多渠道消息接入（WhatsApp、Telegram、Slack、Discord、飞书等 20+ 渠道）。

### 核心特点
- **Gateway 架构**：WebSocket 控制平面，管理会话、通道、工具和事件
- **插件系统**：通过 `extensions/` 目录实现可扩展性
- **多模型支持**：支持 OpenAI、Anthropic、Google 等多种 AI 模型
- **跨平台**：支持 macOS、iOS、Android、Linux、Windows

### 版本追踪
- 当前追踪版本：`2026.3.14`
- 当前 commit：`6db6e117df9d0d1054fe3d1ec1043342d41f107b`
- 最后更新：2026-03-21

## 与 claudeClaw 的关系

| 维度 | OpenClaw | claudeClaw（小智） |
|------|----------|-------------------|
| 定位 | 多渠道 AI 助手框架 | 飞书个人助手 |
| 架构 | Gateway + Plugin SDK | 单体服务 + Worker |
| 渠道 | 20+ 消息平台 | 飞书 |
| 模型 | 多模型支持 | 主要使用 Claude |

## 学习方向

1. **Gateway 架构** - WebSocket 控制平面设计
2. **插件系统** - `plugin-sdk` 的模块化设计
3. **通道抽象** - 多渠道消息的统一处理
4. **会话管理** - 会话生命周期和状态管理
5. **安全模型** - 配对、认证和权限控制

## 相关链接

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [OpenClaw Discord](https://discord.gg/clawd)
