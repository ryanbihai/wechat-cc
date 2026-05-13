# wechat-cc PRD：OB 网关模式

> 2026-05-13 · v0.4.0 · 已实现

## 一、产品定位

wechat-cc 是**微信和 OceanBus Agent 之间的网关**。不处理任务，不执行命令，只做翻译和路由。

```
微信(人类) ⇄ iLink ⇄ [wechat-cc 网关] ⇄ OB L0 ⇄ Agent(CC/OpenClaw/Trae/...)
```

## 二、角色

| 角色 | 身份 | 职责 |
|------|------|------|
| **微信用户** | iLink `user_id` + **OB wxOpenId**（永久） | 发指令、收结果 |
| **网关 Bot** | iLink `bot_token` + OB OpenID | iLink↔OB 翻译、前缀路由 |
| **Agent** | OB OpenID | 收指令、执行、回复、自报家门 |

## 三、wxOpenId 架构

微信用户拥有永久 OB OpenID，与 iLink session 解耦。

```
首次扫码:
  iLink 返回 ilink_user_id
  Gateway 注册 OB 身份 → wxOpenId "wxUser_abc..."
  绑定: wxOpenId ↔ ilink_user_id（持久化到 wx-identity.json）

之后:
  Agent 只需要知道 wxOpenId → OB 直接发消息
  iLink session 过期 → Gateway 自动恢复
  wxOpenId 永久不变
```

**Gateway 迁移：** 复制 5 个文件到新机器，不需要重新扫码。

```
~/.claude/channels/wechat-cc/
├── wx-identity.json      ← 微信永久 OB OpenID
├── bot-ob.json           ← Bot OB 身份
├── binding.json          ← wxOpenId ↔ ilink_user_id
├── routes.json           ← 路由表
└── wechat/accounts/*     ← iLink bot_token
```

## 四、Agent Announce 协议

Agent 不需要扫码。知道 wxOpenId 后，向它发送 announce 即可自动注册。

```
Agent → ob.send(wxOpenId, {
  action: "announce",
  meta: {
    agent_name: "CC-qMaP",
    agent_openid: "qMaP...",
    agent_type: "claude-code"
  }
})

Gateway 收到 → 自动添加路由 /cc-qMaP → qMaP... → CC-qMaP
Gateway → 微信通知: "🔔 CC-qMaP 已连接！使用 /use /cc-qMaP 切换"
```

## 五、消息路由（Model C：默认会话 + 单条覆盖）

### 入向：微信 → Agent

```
1. 用户发消息 "/cc-svg 重构代码"
2. iLink → weixin-bot-plugin → "message" 事件
3. Gateway 解析前缀
    已知前缀 → 本次路由到指定 Agent（不改变默认会话）
    无前缀 → 路由到当前主 Agent
4. Gateway 查路由表 → ob.send(Agent_OpenID, JSON命令)
5. Agent 收到 → 执行 → 回复
```

### 出向：Agent → 微信

```
1. Agent 执行完毕 → ob.send(wxOpenId, JSON回复)
2. Gateway OB 监听器收到 → 查 binding → 获取 ilink_user_id
3. Gateway → client.sendText(wx用户, "🔔 Agent名 回复：\n\n结果")
4. 微信收到
```

## 六、微信命令

```
/use /cc-qMaP           → 切换主 Agent
/cc-svg 重构代码         → 临时发给 /cc-svg（不改变主 Agent）
重构代码                 → 发给当前主 Agent
/myid                   → 查看微信 OB OpenID
/who                    → 查看当前会话 + 所有 Agent
/help                   → 完整命令列表
/routes                 → 查看路由表
/addroute /xxx OpenID   → 手动添加路由
/removeroute /xxx       → 移除路由
```

## 七、路由表

```json
{
  "routes": {
    "/cc-qMaP": {
      "openId": "qMaPCuSjJjZYAEKYN_spK5...",
      "name": "CC-qMaP",
      "type": "claude-code",
      "addedAt": "2026-05-13T08:00:00Z"
    }
  },
  "default": "/cc-qMaP"
}
```

Agent announce 时自动注册，也可手动 `/addroute`。

## 八、自动命名

```
优先级:
  1. --name "CC-oceanbus"     → 手动指定
  2. 都没指定                  → "CC-" + OpenID 前 4 位 → "CC-qMaP"

碰撞处理（概率 ~1/1600 万）:
  /removeroute /cc-qMaP
  /addroute /cc-qMaP-2 <OpenID> CC-qMaP-2
```

## 九、多用户隔离

Gateway 通过 `from_user_id`（iLink 提供的发送者 ID）区分不同微信用户。

```
ilink_user_id_A → 自己的路由表 + 会话状态
ilink_user_id_B → 自己的路由表 + 会话状态
```

**绝对不串台。** 每个用户的 `/use`、路由表、Agent 列表完全独立。

## 十、A 消息

### 个人 standalone 模式

```bash
if [ -d wechat-cc ]; then cd wechat-cc && git pull; else git clone https://github.com/ryanbihai/wechat-cc.git && cd wechat-cc; fi && npm install oceanbus@latest weixin-bot-plugin@latest && node standalone.cjs --wx <微信OB_OpenID>
```

先从微信 `/myid` 拿到 wxOpenId。CC Agent 启动时自动 announce 到微信网关。

### Gateway 管理员模式

```
/plugin marketplace add ryanbihai/claude-plugins
/plugin install wechat-cc@oceanbus-plugins
```

## 十一、技术栈

| 层 | 技术 |
|----|------|
| 微信通信 | `weixin-bot-plugin` (iLink API) |
| CC 集成 | `@modelcontextprotocol/sdk` (login/reply/status/logout) |
| P2P 身份+路由 | `oceanbus` (L0) |
| 单文件分发 | `bun build` → `dist/index.js` |

## 十二、数据文件

```
~/.oceanbus-chat/
  └── credentials.json        ← Agent OB 身份（共享）

~/.claude/channels/wechat-cc/
  ├── wx-identity.json        ← 微信 OB 永久身份
  ├── bot-ob.json             ← Bot OB 身份
  ├── binding.json            ← wxOpenId ↔ ilink_user_id
  ├── routes.json             ← 路由表
  └── wechat/accounts/        ← iLink bot_token
```
