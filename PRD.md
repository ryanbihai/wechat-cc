# wechat-cc PRD：OB 网关模式

> 2026-05-13 · v0.2.2 · 已实现

## 一、产品定位

wechat-cc 是**微信和 OceanBus Agent 之间的网关**。不处理任务，不执行命令，只做路由。

```
微信(人类) ⇄ iLink ⇄ [wechat-cc 网关] ⇄ OB L0 ⇄ Agent(程序)
```

## 二、角色

| 角色 | 身份 | 职责 |
|------|------|------|
| **微信用户** | iLink `user_id` | 发指令、收结果 |
| **网关 Bot** | iLink `bot_token` + OB OpenID | 解析前缀、查路由、转发、回传 |
| **CC Agent** | OB OpenID | 收指令、执行 Claude、回复 |
| **其他 Agent** | OB OpenID | 收指令、执行、回复 |

## 三、消息路由（Model C：默认会话 + 单条覆盖）

### 入向：微信 → Agent

```
1. 用户发消息 "/cc-svg 重构代码"
2. iLink → weixin-bot-plugin → "message" 事件
3. 网关解析前缀
    已知 /cc-svg → 本次路由到 CC-svg（不改变默认会话）
    无前缀 → 路由到当前默认 Agent
4. 网关查路由表 → OB.send(Agent_OpenID, JSON命令)
5. Agent 收到 → 执行 → 回复
```

### 出向：Agent → 微信

```
1. Agent 执行完毕 → ob.send(Gateway_OpenID, JSON回复)
2. 网关 OB 监听器收到 → 提取 to_wx_user
3. 网关 → client.sendText(wx用户, "🔔 Agent名 回复：\n\n结果")
4. 微信收到
```

## 四、会话模型

```
/use /cc-svg           → 切换默认 Agent
/cc-svg 重构代码        → 临时发给 CC-svg（不改变默认）
重构代码                → 发给当前默认 Agent
/who                   → 查看当前会话 + 所有 Agent
/help                  → 完整命令列表
/addroute /trae xxx    → 添加新 Agent
/removeroute /trae     → 移除 Agent
/default /cc           → 设全局默认
```

## 五、路由表

```json
{
  "routes": {
    "/cc": {
      "openId": "qMaPCuSjJjZYAEKYN_spK5...",
      "name": "CC-qMaP",
      "type": "claude-code",
      "addedAt": "2026-05-13T08:00:00Z"
    }
  },
  "default": "/cc"
}
```

## 六、自动命名

```
优先级:
  1. --name "CC-oceanbus"     → 手动指定
  2. 都没指定                  → "CC-" + OpenID 前 4 位
                                → "CC-qMaP"

碰撞处理（概率 ~1/1600 万）:
  /removeroute /cc-qMaP
  /addroute /cc-qMaP-2 <OpenID> CC-qMaP-2
```

OpenID 前 4 位是 OB 网络公开地址，暴露无风险。

## 七、身份模型

```
┌─────────────────────────────────────────┐
│           微信侧绑定                      │
│  ilink_user_id → 默认路由 "/cc"          │
│  扫码即绑定，无需手动操作                   │
├─────────────────────────────────────────┤
│           网关 OB 身份                    │
│  "fkGrTF7xx6..."                        │
│  路由表: {"/cc"→OB1, "/trae"→OB2, ...}  │
├─────────────────────────────────────────┤
│        Agent OB 身份（多个）              │
│  /cc:     "qMaP..."                     │
│  /trae:   "trae_agent_..."              │
│  /cursor: "cursor_agent_..."            │
└─────────────────────────────────────────┘
```

## 八、A 消息

**传播者不需要做任何事。** 拿到 A 消息的朋友自己完成全部操作。

```bash
if [ -d wechat-cc ]; then cd wechat-cc && git pull; else git clone https://github.com/ryanbihai/wechat-cc.git && cd wechat-cc; fi && npm install oceanbus@latest weixin-bot-plugin@latest && node standalone.cjs
```

**朋友体验：**

```
1. 把 A 消息粘贴到 CC
2. CC 自动：克隆 → 安装 → 注册身份 → 出二维码
3. 微信扫码（如被折叠按 ctrl+o 展开）
4. 手机上确认授权
5. 微信收到欢迎消息：🎉 已绑定 CC-xxxx
6. 微信发 "帮我看看项目里有几个文件"
7. CC 收到 → spawn claude → 执行 → 回复推回微信
```

**不需要：** 管理员、Gateway、OpenID 交换、pair 命令、路由表。

## 九、多窗口

每个窗口用不同 `--data-dir`，获得独立 OB 身份：

```bash
# 窗口 A
node cc-agent.cjs --data-dir ~/project-a/.oceanbus-cc --auto-exec

# 窗口 B
node cc-agent.cjs --data-dir ~/project-b/.oceanbus-cc --auto-exec
```

微信 `/use /cc-xxxx` 切换窗口，或 `/cc-xxxx 消息` 临时发给指定窗口。

## 十、欢迎消息

扫码绑定后微信立即收到：

```
🎉 欢迎来到 OceanBus 网关！

✅ 已自动绑定
📍 当前会话: /cc

可用 Agent:
  /cc → CC-qMaP

快速上手:
  直接发消息 → 发给当前会话
  /cc 消息 → 临时发给 /cc
  /use /xxx → 切换默认会话
  /who → 查看所有 Agent
  /help → 完整命令列表
```

## 十一、技术栈

| 层 | 技术 |
|----|------|
| 微信通信 | `weixin-bot-plugin` (iLink API) |
| CC 集成 | `@modelcontextprotocol/sdk` (MCP 工具: login/reply/status/logout) |
| P2P 路由 | `oceanbus` (L0: 身份 + 消息收发 + 监听) |
| CC Agent | `cc-agent.cjs` (Node.js, spawn claude) |
| 构建分发 | `bun build` → 单文件 `dist/index.js` |
