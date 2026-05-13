---
name: wechat-cc
version: 0.1.0
description: WeChat Channel for Claude Code — 微信扫码操控 CC，基于 OceanBus L0 P2P
---

# wechat-cc

微信 Channel 插件 for Claude Code。扫码即连，从微信直接操控 Claude Code。

基于 `weixin-bot-plugin` (iLink Bot API) + `@modelcontextprotocol/sdk` (MCP Channel) + `oceanbus` (L0 P2P)。

## 功能

- 微信扫码登录，自动绑定 CC OpenID（无需手动输入 pair 命令）
- 微信消息实时推入 Claude Code 会话
- CC 通过 reply 工具回复微信消息
- 权限转发：CC 工具调用审批 → 微信 → 回复 yes/no 远程授权
- 基于 OceanBus L0 的 Store-and-Forward，CC 离线时消息不丢
- 长消息自动拆条防折叠
- ctrl+o 展开二维码提醒

## 安装

```
/plugin marketplace add oceanbus/claude-plugins
/plugin install wechat-cc@oceanbus-plugins
```

## 架构

```
微信用户 (ilink_user_id)
    ↕ iLink
┌─ WeChat Bot ──────────────────────────┐
│  OB OpenID: wxBot_xxxx                │
│  绑定: {ilink_user_id → CC_OpenID}    │
│  (扫码确认时自动完成)                   │
└──────────┬────────────────────────────┘
           ↕ OceanBus L0 P2P
┌─ CC Agent ────────────────────────────┐
│  OB OpenID: cc_qMaPC...               │
│  MCP Channel: OB消息 → CC会话          │
│  reply 工具: CC回复 → OB → Bot → 微信   │
└───────────────────────────────────────┘
```

## 消息流

```
微信 "重构 user-service"
  → iLink
    → Bot: ob.send(CC_OpenID, msg)
      → OB L0 delivers
        → CC MCP notification 注入会话
          → CC 处理
            → CC 调用 reply 工具
              → ob.send(Bot_OpenID, reply)
                → OB L0 delivers
                  → Bot: iLink sendMessage()
                    → 微信收到回复
```

## 依赖

- `weixin-bot-plugin` — iLink API 通信（QR 登录、长轮询、消息收发）
- `@modelcontextprotocol/sdk` — MCP Channel 协议
- `oceanbus` — L0 P2P 身份和消息路由
