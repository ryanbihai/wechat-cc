# 🌊 wechat-cc

**微信扫码操控 Claude Code。** 多窗口协同，自动命名，零配置。

[![GitHub](https://img.shields.io/badge/github-ryanbihai%2Fwechat--cc-blue)](https://github.com/ryanbihai/wechat-cc)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.0-brightgreen)](https://github.com/ryanbihai/wechat-cc/releases)

---

## 开始使用

在 Claude Code 中说：

> 去 https://clawhub.ai/ryanbihai/wechat-cc 更新最新版，然后**启动微信**

Claude Code 会自动：更新插件 → 检查连接 → 需要时展示二维码 → 启动消息监听。微信扫码 → 完成。

---

## 多窗口 / 多 Agent

每个 CC 窗口自动以**项目目录名**作为窗口名，无需手动配置。

```
~/projects/oceanbus  →  路由 /oceanbus  （微信发 /oceanbus 消息）
~/projects/小龙虾     →  路由 /小龙虾     （微信发 /小龙虾 消息）
~/projects/my-doc    →  路由 /my-doc    （微信发 /my-doc 消息）
```

**同名项目**自动避让：`/oceanbus` → `/oceanbus-2` → `/oceanbus-3`

**手动命名**：`--name "docs"` 优先于自动检测。

**消息路由规则**：

| 微信发送 | 效果 |
|----------|------|
| 直接发消息 | → 默认窗口 |
| `/<name> 消息` | → 指定窗口 |
| `/use /<name>` | → 切换默认窗口 |
| `/who` | → 查看所有窗口 |

**窗口回复带签名**：每条回复自动带 `🔔<窗口名>：` 前缀，方便微信端区分来源。

---

## 邀请朋友

把上面那句话发给他们就行：**"去 https://clawhub.ai/ryanbihai/wechat-cc 更新最新版，然后启动微信"**。你不需要做任何事。

---

## Gateway 模式（高级）

如果需要统一路由管理多个 Agent：

```
/plugin marketplace add ryanbihai/claude-plugins
/plugin install wechat-cc@oceanbus-plugins
```

支持前缀路由、多 Agent 分发、会话管理。详见 [PRD.md](./PRD.md)。

---

## 架构

```
微信 ⇄ iLink ⇄ [Gateway 插件] ⇄ OB L0 ⇄ [agent.js · Monitor] ⇄ CC 交互会话
                                    ↕
                            [agent.js · 窗口2]
                            [agent.js · 窗口3]
```

| 层 | 技术 |
|----|------|
| 微信通信 | `weixin-bot-plugin` (iLink API) |
| P2P 身份 | `oceanbus` (L0) |
| CC 集成 | `@modelcontextprotocol/sdk` (MCP) |
| 消息注入 | Monitor + stdout JSON |

---

## 微信命令速查

| 命令 | 作用 |
|------|------|
| `/help` | 查看所有命令 |
| `/who` | 查看当前会话和所有窗口 |
| `/use /<name>` | 切换默认窗口 |
| `/myid` | 查看你的微信 OB 地址 |
| `/routes` | 查看路由表 |
| `/addroute /x OpenID 名` | 手动添加路由 |
| `/removeroute /x` | 移除路由 |

---

## 相关项目

- [weixin-bot-plugin](https://github.com/Dcatfly/weixin_bot_plugin) — 微信 Bot SDK
- [OceanBus](https://github.com/ryanbihai/oceanbus-monorepo) — P2P Agent 通信网络

---

## 反馈与贡献

这个项目还在早期，你的反馈至关重要。

- **遇到 Bug？** [提交 Issue](https://github.com/ryanbihai/wechat-cc/issues)
- **有新想法？** 直接微信发给 CC 窗口 → 开发者在微信上就能收到
- **想贡献代码？** [Fork + PR](https://github.com/ryanbihai/wechat-cc) 欢迎
- **使用技巧分享？** 提交 Issue 或微信告知，好用法会收录到文档

每一条反馈都会被认真对待。让 wechat-cc 更好用，需要你的参与 🤝

---

MIT · [OceanBus](https://github.com/ryanbihai)
