# wechat-cc PRD：OB 网关模式

> 2026-05-13 · v0.2.0 设计

## 一、产品定位

wechat-cc 是**微信和 OceanBus Agent 之间的网关**。

- 不负责处理消息
- 不负责执行命令
- 只负责**接收 → 查路由 → 转发 → 回传**

```
微信(人类) ⇄ iLink ⇄ [wechat-cc 网关] ⇄ OB L0 ⇄ Agent(程序)
                         │
                    路由表 + 身份映射
```

---

## 二、角色定义

### 微信用户

- **做什么**：发送指令给 Agent，接收 Agent 的回复
- **身份**：iLink `user_id`（随扫码自动获取）
- **特殊地位**：是**人类在 OB 网络上的代理**，不处理任务，只收发

### Bot / 网关

- **做什么**：翻译微信消息为 OB 消息，翻译 OB 消息为微信消息
- **身份**：iLink `bot_token` + OB OpenID `fkGrT...`
- **核心职责**：解析路由前缀、查表转发、回传结果

### Agent

- **做什么**：接收指令、执行任务、返回结果
- **身份**：OB OpenID `qMaPC...`
- **示例**：CC、Trae、Cursor、OpenClaw

---

## 三、消息路由

### 3.1 入向：微信 → Agent（12 步）

```
1  用户在微信给 Bot 发消息
    例: "/cc 帮我重构 user-service"

2  iLink API 长轮询 → weixin-bot-plugin 拉取到消息

3  WeixinBotClient 触发 "message" 事件
     { chatId: "o9cq801VfF...", text: "/cc 帮我重构 user-service" }

4  网关收到事件 → 检查 chatId 是否已绑定
     未绑定 → 回复: "请先扫码绑定"
     已绑定 → 继续

5  网关解析路由前缀
     text 首段匹配 "/xxx" 格式 → prefix="/cc", body="帮我重构 user-service"
     无前缀 → 使用预设的默认 Agent

6  网关查路由表
     routes["/cc"] → { openId: "qMaPC...", name: "CC-oceanbus" }
     未匹配 → 回复: "未知的 Agent 前缀: /cc。可用前缀: /cc, /trae, /cursor"

7  网关构造 OB 入向消息体
     {
       action: "command",
       text: "帮我重构 user-service",
       meta: {
         from_wx_user: "o9cq801VfF...",   // 回复时用于查找微信用户
         route_prefix: "/cc",
         message_id: "msg_xxx"             // 用于关联回复
       }
     }

8  网关以 Bot OB 身份发送
     ob.send("qMaPCuSjJjZYAEKYN_spK5...", message)

9  OB P2P 网络投递到 Agent 的 OB 地址

10 Agent OB 监听器收到消息
     解析: action="command", text="帮我重构 user-service"

11 Agent 执行任务
     CC: Claude 分析代码、修改文件
     Trae: 执行对应的 Trae task
     Cursor: 导航到指定文件

12 Agent 获得结果，准备回复
```

### 3.2 出向：Agent → 微信（8 步）

```
1  Agent 执行完毕，获得结果
     "重构完成。修改了 src/user.ts, src/auth.ts"

2  Agent 从原始消息 meta 中提取回复所需信息
     to_wx_user: "o9cq801VfF..."
     message_id: "msg_xxx"

3  Agent 构造 OB 出向消息体
     {
       action: "reply",
       text: "重构完成。修改了 src/user.ts, src/auth.ts",
       meta: {
         to_wx_user: "o9cq801VfF...",    // ← 网关据此查找微信用户
         reply_to: "msg_xxx",            // ← 关联原消息
         agent_name: "CC-oceanbus"
       }
     }

4  Agent 以自身 OB 身份发送
     ob.send("fkGrTF7xx6WRYCN0...", reply)     // 发给网关的 OB 地址

5  OB P2P 网络投递到网关的 OB 地址

6  网关 OB 监听器收到 Agent 的回复
     from_openid 匹配到 Agent（在路由表中）
     提取: to_wx_user="o9cq801VfF..."

7  网关 → iLink
     client.sendText("o9cq801VfF...", "🔔 CC-oceanbus 回复：\n\n重构完成。修改了 src/user.ts, src/auth.ts")

8  用户微信收到回复
```

---

## 四、路由表设计

### 4.1 数据结构

```json
{
  "routes": {
    "/cc": {
      "openId": "qMaPCuSjJjZYAEKYN_spK5_UADPCQ-wprIH5MNDo4u0Yayt6caKHIq4iHsuBAZLgFBXptlkH43_wHKOV",
      "name": "CC-oceanbus",
      "type": "claude-code",
      "addedAt": "2026-05-13T08:00:00Z"
    },
    "/trae": {
      "openId": "trae_agent_openid_here",
      "name": "Trae-oceanbus",
      "type": "trae",
      "addedAt": "2026-05-13T09:00:00Z"
    },
    "/cursor": {
      "openId": "cursor_agent_openid_here", 
      "name": "Cursor-oceanbus",
      "type": "cursor",
      "addedAt": "2026-05-13T10:00:00Z"
    }
  },
  "default": "/cc",
  "gateway": {
    "name": "WeChat Bot",
    "obOpenId": "fkGrTF7xx6WRYCN0Z3gMJg3A8Mz_svOCF_3rK3d8MdCWgzYmMfSUDSX7O6pksCWMj2hF_tcKcApV49N0",
    "wxUserId": "o9cq801VfFeQyUYAUsYdOXFUpuQg@im.wechat"
  }
}
```

### 4.2 路由规则

| 用户输入 | 解析 | 路由到 |
|---------|------|--------|
| `/cc 重构代码` | prefix=/cc, body=重构代码 | CC Agent |
| `/trae 打开文件` | prefix=/trae, body=打开文件 | Trae Agent |
| `/cursor 跳转定义` | prefix=/cursor, body=跳转定义 | Cursor Agent |
| `重构代码`（无前缀） | prefix=无, body=重构代码 | 默认 Agent（/cc） |
| `/help` | 系统命令 | 返回可用前缀列表 |
| `/addroute /xxx OpenID 名称` | 系统命令 | 添加路由项 |
| `/routes` | 系统命令 | 返回路由表 |

---

## 五、系统命令

微信端可直接管理的网关命令（以 `/` 开头，网关自己处理，不转发给 Agent）：

| 命令 | 功能 | 示例 |
|------|------|------|
| `/help` | 列出可用前缀和 Agent | `/help` |
| `/routes` | 查看当前路由表 | `/routes` |
| `/addroute /xxx OpenID 名称` | 添加新 Agent | `/addroute /trae trae_xxx Trae` |
| `/removeroute /xxx` | 删除 Agent | `/removeroute /trae` |
| `/default /xxx` | 设置默认 Agent | `/default /cc` |
| `/status` | 查看连接状态 | `/status` |

---

## 六、绑定流程

```
用户扫码（仅一次）
  → 微信授权
    → 网关获取 ilink_user_id
      → 保存绑定: { ilink_user_id → 默认路由 }

之后所有消息：
  网关根据绑定 → 查路由 → 转发 Agent
```

**不再需要手动发 pair 命令。扫码即绑定。**

---

## 七、身份模型

```
┌─────────────────────────────────────────┐
│              微信侧身份                  │
│  ilink_user_id: "o9cq801VfF..."         │
│  绑定: { ilink_user_id → 默认路由 "/cc" }│
├─────────────────────────────────────────┤
│              网关 OB 身份                │
│  agent_id: "36de5627..."                │
│  openid: "fkGrTF7xx6..."                │
│  路由表: {"/cc"→OB1, "/trae"→OB2, ...}  │
├─────────────────────────────────────────┤
│           Agent OB 身份（多个）          │
│  /cc:     "qMaPCuSjJjZ..."              │
│  /trae:   "trae_agent_..."              │
│  /cursor: "cursor_agent_..."            │
└─────────────────────────────────────────┘
```

---

## 八、与 MCP Channel 的关系

MCP Channel 保留，但**降级为 Agent 的入向投递方式之一**。

```
OB 投递到 CC 后：
  ├── 路径1：CC OB 监听器直接打印到终端（通用）
  └── 路径2：MCP notification 注入 CC 会话（CC 专属优化）
```

Agent 自己决定如何接收 OB 消息。CC 可以用 MCP，Trae 可以用文件监听，Cursor 可以用 WebSocket。网关不关心。

---

## 九、实施变更

| 模块 | 当前（v0.1.x） | 目标（v0.2.0） |
|------|--------------|--------------|
| 入向投递 | MCP notification（Path A） | **OB L0（Path B）** |
| 出向投递 | MCP reply + OB 监听器 | **统一 OB 监听器** |
| 路由 | 单一 CC | 前缀路由表，多 Agent |
| 绑定 | loginSuccess 写 pairings | 扫码直接保存默认路由 |
| 系统命令 | 无 | /help /routes /addroute |
| MCP 角色 | 主通道 | 降级为 CC 专属适配 |
