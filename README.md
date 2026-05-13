# 🌊 wechat-cc

**微信 ↔ OceanBus 网关。** 扫码即连，从微信操控 Claude Code 和任何 OB Agent。

[![GitHub](https://img.shields.io/badge/github-ryanbihai%2Fwechat--cc-blue)](https://github.com/ryanbihai/wechat-cc)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.2-brightgreen)](https://github.com/ryanbihai/wechat-cc/releases)

---

## 安装

```
/plugin marketplace add ryanbihai/claude-plugins
/plugin install wechat-cc@oceanbus-plugins
```

重启 Claude Code。说"登录微信"，扫码，完成。

---

## A 消息 — 邀请朋友

发给朋友，一条命令即可加入：

```bash
if [ -d ocean-chat ]; then cd ocean-chat && git pull; else git clone https://github.com/ryanbihai/ocean-chat.git && cd ocean-chat; fi && npm install && npm install oceanbus@latest && node cc-agent.cjs --auto-exec
```

朋友告诉你 OB OpenID（前 4 位），你在微信 `/addroute /朋友名 OpenID` 添加路由。朋友扫你的 Gateway 二维码，完成。

---

## 使用

### 微信操控 CC

```
帮我重构 user-service          → 发给当前默认 Agent
/cc 检查代码                    → 临时发给 /cc
/use /cc-svg                   → 切换到 CC-svg 窗口
/who                           → 查看当前会话 + 所有 Agent
/help                          → 完整命令
```

### 多窗口

```bash
# 窗口 A（oceanbus 项目）
node cc-agent.cjs --data-dir ~/oceanbus/.oceanbus-cc --auto-exec --name "CC-oceanbus"

# 窗口 B（svg 项目）
node cc-agent.cjs --data-dir ~/svg/.oceanbus-cc --auto-exec --name "CC-svg"
```

### 多 Agent

```
/addroute /trae  trae_openid_xxx  Trae-main
/addroute /cursor cursor_openid_xxx Cursor
```

---

## 架构

```
微信 ⇄ iLink ⇄ [wechat-cc 网关] ⇄ OceanBus L0 ⇄ Agent(CC/Trae/Cursor/...)
                  │
             路由表 + 会话状态
```

| 层 | 技术 |
|----|------|
| 微信通信 | `weixin-bot-plugin` — iLink API 长轮询 |
| CC 集成 | `@modelcontextprotocol/sdk` — login/reply/status/logout |
| P2P 路由 | `oceanbus` — L0 身份 + 消息收发 |
| CC Agent | `cc-agent.cjs` — spawn claude 自动执行 |
| 构建 | `bun build` → 单文件分发 |

---

## 权限转发

CC 请求执行 Bash/Write/Edit 时，弹窗转发到微信：

> Claude 请求执行 Bash: rm -rf node_modules
> 回复 yes / no

手机上回 `y`，CC 继续执行。真正的远程操控。

---

## 与 weixin-claude-code 的区别

| | weixin-claude-code | wechat-cc |
|------|------|------|
| 消息路由 | iLink ↔ CC 直连 | **iLink ↔ OB L0 ↔ Agent** |
| 多 Agent | 不支持 | **前缀路由，多 Agent/多窗口** |
| 离线消息 | 丢失 | **OB 存储转发，不丢** |
| 会话模型 | 无 | **Model C：默认 + 覆盖** |
| 身份 | 无 OB | **Bot + CC 各有 OB OpenID** |
| 欢迎消息 | 无 | **扫码绑定欢迎 + 快速上手** |

---

## 相关项目

- [OceanBus SDK](https://github.com/ryanbihai/oceanbus-sdk) — P2P Agent 通信
- [ocean-chat](https://github.com/ryanbihai/ocean-chat) — Agent 会面协商工具
- [weixin-bot-plugin](https://github.com/Dcatfly/weixin_bot_plugin) — 微信 Bot SDK
- [weixin-claude-code](https://github.com/Dcatfly/weixin_claude_code) — 微信 CC 插件（灵感来源）

---

MIT · [OceanBus](https://github.com/ryanbihai)
