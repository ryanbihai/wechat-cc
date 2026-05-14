---
name: wechat-cc
version: 0.5.1
description: OB Gateway — WeChat ⇄ OB L0 ⇄ Agents。多窗口自动命名，前缀路由分发，Monitor 注入交互会话。
---

# wechat-cc

微信 Channel 插件 for Claude Code。扫码即连，从微信直接操控 Claude Code。

基于 `weixin-bot-plugin` (iLink Bot API) + `@modelcontextprotocol/sdk` (MCP 工具) + `oceanbus` (L0 P2P)。

## 功能

- 微信扫码登录，自动绑定 OB 身份
- 微信消息通过 OB L0 + Monitor 实时投递到 CC 交互会话
- CC 通过 MCP `reply` 工具回复微信，自动带窗口签名 `🔔<name>：`
- MCP `send` 工具主动发微信消息
- **多窗口自动命名**：以项目目录名作为窗口名，同名自动避让（-2, -3）
- 多 Agent 路由前缀分发（`/oceanbus`、`/myapp` 等）
- 微信端 `/use /<name>` 切换默认窗口，`/<name> 消息` 发给指定窗口
- 基于 OceanBus L0 的 Store-and-Forward，CC 离线时消息不丢

## 安装

```
/plugin marketplace add ryanbihai/claude-plugins && /plugin install wechat-cc@oceanbus-plugins
```

> 如果已安装过 oceanbus-plugins 市场，只需：`/plugin install wechat-cc@oceanbus-plugins`

安装完成后**重启 Claude Code**。

## 首次使用

1. 说"启动微信" → 自动检查连接状态
2. 如未连接 → 调用 MCP `login` → 扫码
3. 自动启动 Monitor 监听 OB 消息
4. 微信发消息 → Monitor 事件推送 → CC 在会话中看到并处理
5. CC 用 MCP `reply` 工具回复（自动带窗口名）

## "启动微信" 工作流

当用户说"启动微信"时，执行以下步骤：

1. 调用 MCP `status` 确认 Gateway 状态
   - `wechat_connected: false` → 调用 `login` 扫码
   - `bound: false` → status 自动恢复（P0 修复已生效）
2. 找到 agent.js：`<项目根>/skills/wechat-cc/dist/agent.js`
3. 用 Monitor (persistent) 启动 agent：
   ```
   node <项目根>/skills/wechat-cc/dist/agent.js
   ```
   agent.js 自动从当前目录名检测窗口名，无需手动 `--name`。
   手动覆盖：`--name "custom"` 仍生效。
4. Monitor 启动后，每条微信消息以 JSON 事件形式推送

Monitor 事件格式：
```json
{"type":"wechat_msg","chat_id":"o9cq8...","sender":"o9cq8...","text":"消息内容","route":"/oceanbus","agent":"oceanbus","time":"12:34:56"}
```

## 回复微信消息

使用 MCP `reply` 工具，**必须传 `name` 参数**（来自 Monitor 事件的 `agent` 字段）：

```
reply(chat_id, "回复内容", name="oceanbus")
→ 微信显示: 🔔oceanbus：
回复内容
```

## 多窗口自动命名

agent.js 从 `process.cwd()` 目录名自动生成窗口名：

```
~/projects/oceanbus  →  oceanbus     →  路由 /oceanbus
~/projects/小龙虾     →  小龙虾       →  路由 /小龙虾
~/projects/my-doc    →  my-doc      →  路由 /my-doc
```

同名项目自动避让：`/oceanbus` → `/oceanbus-2` → `/oceanbus-3`

中文目录名直接保留（可在微信输入中文路由）。

每个窗口使用独立的数据目录（`--data-dir`），首次运行自动注册 OB 身份。

## 微信端操作

| 微信发送 | 效果 |
|----------|------|
| 直接发消息 | → 默认窗口 |
| `/<name> 消息` | → 指定窗口（临时，不改变默认） |
| `/use /<name>` | → 切换默认窗口 |
| `/who` | → 查看当前会话和所有窗口 |
| `/help` | → 完整命令列表 |
| `/myid` | → 你的微信 OB 地址 |
| `/routes` | → 路由表 |

## 停止监听

说"停止监听"或"停止微信"，stop 对应的 Monitor task。

## 架构

```
微信用户 (ilink_user_id)
    ↕ iLink
┌─ WeChat Gateway (MCP 插件) ─────────────┐
│  OB OpenID: 7OpWz... (bot)              │
│           : ozXQy... (wx 永久身份)       │
│  绑定: {ilink_user_id → wxOpenId}       │
│  路由: /oceanbus → qMaPCu...            │
│        /myapp → TxbDK...                │
│  MCP 工具: login/status/logout          │
│            reply/send (支持 name 参数)   │
└──────────┬──────────────────────────────┘
           ↕ OceanBus L0 P2P
┌─ CC Agent · 窗口1 (agent.js) ───────────┐
│  OB OpenID: qMaPCu...                   │
│  窗口名: oceanbus                        │
│  运行方式: Monitor (persistent)          │
│  输出: JSON 事件 → stdout → CC 会话      │
└─────────────────────────────────────────┘
┌─ CC Agent · 窗口2 (agent.js) ───────────┐
│  OB OpenID: TxbDK...                    │
│  窗口名: myapp                           │
│  运行方式: Monitor (persistent)          │
└─────────────────────────────────────────┘
```

## 消息流

```
微信 "重构 user-service"
  → iLink 长轮询
    → Gateway: ob.send(CC_OpenID, {action:"command", text, meta:{from_wx_user}})
      → OB L0 投递
        → agent.js stdout: {"type":"wechat_msg","chat_id":"...","text":"重构 user-service","agent":"oceanbus"}
          → Monitor 捕获 → CC 会话显示
            → CC 处理
              → CC 调用 MCP reply(chat_id, result, name="oceanbus")
                → Gateway: iLink sendMessage("🔔oceanbus：\nresult")
                  → 微信收到回复
```

## 冲突说明

如果已安装 `weixin-claude-code@dcatfly-plugins`，两个插件会竞争同一个微信账号的消息。建议禁用其一：

```
/plugin disable weixin-claude-code@dcatfly-plugins
```

## 数据文件

```
~/.oceanbus-chat/credentials.json        CC OB 身份
~/.claude/channels/wechat-cc/
  ├── wx-identity.json                   微信永久 OB 身份
  ├── bot-ob.json                        Gateway OB 身份
  ├── binding.json                       iLink ↔ OB 绑定
  └── routes.json                        路由表
```

## 反馈与贡献

项目早期，你的每一条反馈都很宝贵。

- **Bug 反馈**：[GitHub Issues](https://github.com/ryanbihai/wechat-cc/issues)
- **功能建议**：微信直接发给 CC 窗口，开发者在线接收
- **代码贡献**：Fork + PR 欢迎，先看看 [PRD.md](./PRD.md) 了解架构
- **使用技巧**：分享你的用法，好用的会收录进文档

一起把 wechat-cc 做得更好 🤝

## 依赖

- `weixin-bot-plugin` — iLink API 通信（QR 登录、长轮询、消息收发）
- `@modelcontextprotocol/sdk` — MCP 工具协议
- `oceanbus` — L0 P2P 身份和消息路由
