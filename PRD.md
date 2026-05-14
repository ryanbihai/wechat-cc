# wechat-cc PRD：消息通路全链路分析

> 2026-05-14 · v0.5.0 · Monitor 模式生效版

## 一、架构总览

```
微信(人类) ⇄ iLink ⇄ [wechat-cc Gateway 插件] ⇄ OB L0 ⇄ [agent.js · Monitor 模式] ⇄ Claude Code 交互会话
              (a)              (b)                 (c)            (d)                    (e)
```

### 全部组件与身份（6 个身份）

| 缩写 | 组件 | 运行位置 | OpenID（前 5 位） | 文件 |
|------|------|----------|-------------------|------|
| **iLink** | 微信机器人会话凭证 | GW 进程内 | `o9cq801V...@im.wechat` | `wechat/accounts/{id}-im-bot.json` |
| **Bot OB** | Gateway 发/收 OB 消息用的身份 | GW 进程内 | `7OpWz...` | `bot-ob.json` |
| **wxOB** | 微信用户永久 OB 身份 | GW 进程内 | `ozXQy...` | `wx-identity.json` |
| **CC OB** | Claude Code 的 OB 身份 | agent.js 进程 | `qMaPCu...` | `~/.oceanbus-chat/credentials.json` |
| **CC-alt** | 历史遗留的备选身份 | — | `2kkWz...` | `.cc-data/credentials.json` |
| **GW** | Gateway 插件进程本身 | CC 子进程 | — | — |

### 路由表（routes.json）

| 前缀 | 目标 | 含义 |
|------|------|------|
| `/cc` | `qMaPCu...` | 默认路由，消息发到此 OB 地址 |
| `/cc-oceanbus` | `qMaPCu...` | 别名 |
| `/cc-svg` | `qMaPCu...` | 别名 |

> 三个路由指向同一个 CC OB 身份，因为当前只有一个 CC 实例。

### OB 地址全貌

```
Bot OB:  7OpWztzyRb40872unG-cvZTLDrR9IyEa-FFMlAbuwC3LFKSL7M7XJxLGrHfhIVrHCTHkiRycBB2LsjP8
wxOB:    ozXQySCJJQJXWgqdQ9uYnzPR72OYvRODEabBwcg_R4YGlIOExdLalUAGx5jGhzOotqqDxdQi3DpMiHRG
CC OB:   qMaPCuSjJjZYAEKYN_spK5_UADPCQ-wprIH5MNDo4u0Yayt6caKHIq4iHsuBAZLgFBXptlkH43_wHKOV
CC-alt:  2kkWzt4FwwEhX85DN7tJ48868xUuSsl-gUTKxDPaVQhkXZoz-1ALB9ndrRfh9mS_KFDFsewlGn6VJFU3
```

---

## 二、当前生效的完整通路（双向）

### 2.1 入站：微信 → CC 交互会话 ✅

```
微信发"测试15"
  │
  ▼
[1] iLink 长轮询
    接口: POST https://ilinkai.weixin.qq.com/v2/bot/{token}/updates
    方式: weixin-bot-plugin 持续长轮询，~30s 超时重连
    cursor: wechat/sync/{id}-im-bot.sync.json (get_updates_buf 字段)
    返回: { type:"message", chat_id:"o9cq801V...", text:"测试15" }
  │
  ▼
[2] Gateway: client.on("message", msg)
    文件: src/index.ts:555-642
    a) 检查 binding.json → 必须存在（否则回复"请先扫码绑定"）
    b) 解析前缀 → 无前缀走默认路由 /cc
    c) 查 routes.json → target = "qMaPCu..."
    d) 创建临时 OB 实例，用 Bot OB 身份发送:
       ob.send("qMaPCu...", JSON.stringify({
         action: "command",
         text: "测试15",
         meta: {
           from_wx_user: "o9cq801V...@im.wechat",
           route_prefix: "/cc",
           agent_name: "CC-f88802e8",
           message_id: "wx_1715..."
         }
       }))
    e) Gateway 回复微信: "已转发，等待回复..."
  │
  ▼
[3] OceanBus L0 P2P
    发送方: Bot OB (7OpWz...)
    接收方: CC OB (qMaPCu...)
    加密直连投递
  │
  ▼
[4] agent.js: ob.startListening(callback)
    文件: src/agent.ts:116-148
    过滤: msg.from_openid !== 自己的 openid
    解析: JSON.parse(msg.content) → action === "command"
    输出到 stdout:
      {"type":"wechat_msg","chat_id":"o9cq801V...@im.wechat","sender":"o9cq801V...@im.wechat","text":"测试15","route":"/cc","agent":"CC","time":"19:08:59"}
  │
  ▼
[5] Claude Code Monitor 捕获 stdout → 推送到当前交互会话
    工具: Monitor (persistent mode)
    命令: node dist/agent.js --data-dir ~/.oceanbus-chat --name "CC"
    ★ 每一行 stdout JSON 作为一个事件出现在 CC 会话中
```

### 2.2 出站：CC 交互会话 → 微信 ✅

```
CC 会话回复
  │
  ▼
[1] MCP 工具调用 reply(chat_id, text)
    工具名: "reply"
    chat_id: "o9cq801V...@im.wechat"  ← 来自入站消息的 chat_id 字段
    text: "收到：测试15（来自交互会话）"
  │
  ▼
[2] Gateway MCP Server: CallToolRequestSchema handler
    文件: src/index.ts:266-278 (case "reply")
    client.sendText(chat_id, "🔔 Claude Code：\n" + text)
    ★ 纯 iLink 通道，不走 OceanBus
  │
  ▼
[3] weixin-bot-plugin → iLink API
    接口: POST https://ilinkai.weixin.qq.com/v2/bot/{token}/message/send
    参数: { to_user_id, content_type:"text", content:"🔔 Claude Code：\n..." }
    token: {id}@im.bot:{secret} (来自 wechat/accounts/{id}-im-bot.json)
  │
  ▼
[4] 微信客户端收到消息
```

---

## 三、辅助通路

### 3.1 MCP send（无 chat_id 时自动发给已绑定用户）✅

```
CC 会话 → MCP send(text) → chat_id = loadBinding()?.ilinkUserId → iLink → 微信
文件: src/index.ts:279-293
与 reply 的区别: 不加 "🔔 Claude Code：\n" 前缀
```

### 3.2 Agent Announce（启动时自动注册）✅

```
agent.js 启动
  → ob.send("ozXQy...", { action:"announce", meta:{ agent_name, agent_openid, agent_type } })
  → Gateway wxOpenId 监听器收到 (src/index.ts:470-511)
  → 自动添加/更新路由到 routes.json
  → 通知微信用户: "🔔 CC 已连接！"
```

### 3.3 系统命令（Gateway 直接处理，不走 OB）✅

```
/help, /who, /use, /routes, /addroute, /removeroute, /default, /myid
→ Gateway 在 client.on("message") 中拦截
→ client.sendText() 直接回复微信
→ 不走 OB
```

---

## 四、当前不使用的通路

### 4.1 OB 回复路径：CC Agent → OB → Gateway Bot OB → 微信 ❌

```
cc-agent.cjs → ob.send("7OpWz...", reply)
→ Gateway bot OB 监听器应该接收 → client.sendText() → 微信
```

**状态：cc-agent 侧显示 "已回复 Gateway" 无报错，但微信收不到。**
Gateway 的 bot OB 监听器日志中无对应接收记录，怀疑 OB 地址不一致。

**为什么当前不使用：** 我们改用 MCP reply 直接走 iLink 回复，不再依赖此路径。

### 4.2 cc-agent.cjs standalone 模式（已弃用）❌

```
微信 → OB → cc-agent.cjs → spawn('claude', ['-p', text]) → 新的 Claude 进程 → 回复微信
```

**问题：**
- 为每条消息创建独立的 `claude -p` 进程，消息不进入当前交互会话
- 依赖 OB 回复路径（Path 4.1，也是断的）
- 默认 data-dir 使用 .cc-data/（身份 `2kkWz...`），与 routes.json 不匹配

---

## 五、通信矩阵（当前生效状态）

| 方向 | 通道 | 发送接口 | 监听方式 | 状态 |
|------|------|----------|----------|------|
| CC 会话 → 微信 | iLink 直连 | `client.sendText(chat_id, text)` | — | ✅ |
| 微信 → Gateway | iLink 长轮询 | — | `client.on("message", cb)` | ✅ |
| Gateway → CC Agent | OceanBus | `ob.send("qMaPCu...", json)` | `ob.startListening(cb)` | ✅ |
| CC Agent → CC 会话 | stdout JSON | `emit({type:"wechat_msg",...})` | Monitor 捕获 stdout | ✅ |
| Agent → Gateway wxOB | OceanBus | `ob.send("ozXQy...", announce)` | `obWx.startListening(cb)` | ✅ |
| 系统命令 | iLink 双向 | `client.sendText()` | `client.on("message")` | ✅ |
| Agent → Gateway Bot OB | OceanBus | `ob.send("7OpWz...", reply)` | `obListener.startListening(cb)` | ❌ 未用 |

---

## 六、两个 CC Agent 模式对比

| | **Monitor 模式（当前）** | **Standalone 模式（已弃用）** |
|---|---|---|
| **入口文件** | `dist/agent.js` (src/agent.ts) | `cc-agent.cjs` |
| **输出方式** | stdout JSON → Monitor 捕获 → CC 会话 | stdout 控制台打印 |
| **回复方式** | CC 会话通过 MCP reply 回复 | spawn claude -p + OB 回复 |
| **消息注入** | ✅ 出现在交互会话 | ❌ 独立进程 |
| **启动命令** | `node dist/agent.js --data-dir ~/.oceanbus-chat --name "CC"` | `node cc-agent.cjs --data-dir ~/.oceanbus-chat` |
| **OB 身份** | `qMaPCu...` (需 --data-dir) | 默认 `2kkWz...` (需 --data-dir 覆盖) |

---

## 七、关键操作知识（踩坑记录）

### 7.1 iLink 会话过期

**症状：** 双向消息不通，但 `wechat_connected: true` 显示正常。
**原因：** iLink bot_token 有过期时间。长轮询 cursor 会持续更新（看起来正常），但 `sendText` 静默失败。
**修复：**
```
/logout  →  登出，清除旧 token + binding.json
/login   →  扫码重新获取 token
→ 手动恢复 binding.json（见 7.2）
```

### 7.2 binding.json 丢失

**症状：** 微信发消息，Gateway 回复"请先扫码绑定"。
**原因：** logout 时 `fs.unlinkSync(BINDING_FILE)` 删除了 binding.json。重新登录后 loginSuccess 事件可能未触发（取决于 session 是否是新登录还是恢复），导致 binding 未自动重建。
**修复：** 手动创建 binding.json：
```json
{
  "ilinkUserId": "o9cq801VfFeQyUYAUsYdOXFUpuQg@im.wechat",
  "wxOpenId": "ozXQySCJJQJXWgqdQ9uYnzPR72OYvRODEabBwcg_R4YGlIOExdLalUAGx5jGhzOotqqDxdQi3DpMiHRG",
  "defaultRoute": "/cc",
  "boundAt": "<当前时间 ISO>"
}
```
ilinkUserId 从 `wechat/accounts/{id}-im-bot.json` 的 `userId` 字段获取。
wxOpenId 从 `wx-identity.json` 的 `openid` 字段获取。

### 7.3 CC OB 身份必须与 routes.json 一致

**症状：** Gateway 显示"已转发，等待回复..."但 agent.js 收不到消息。
**原因：** routes.json 指向 `qMaPCu...`，但 agent 用了 `.cc-data/` 的身份 `2kkWz...`。Gateway 发送到 `qMaPCu...`，agent 在 `2kkWz...` 上监听，收不到。
**修复：** 始终用 `--data-dir ~/.oceanbus-chat` 启动 agent。

### 7.4 agent.js 必须通过 Monitor 运行

**症状：** 后台运行 agent.js 但 CC 会话收不到消息。
**原因：** agent.js stdout 必须被 Monitor 捕获才能注入 CC 会话。用 Bash 后台运行 stdout 去了文件。
**修复：** 使用 Monitor 工具启动 agent.js（persistent: true）。

### 7.5 完整的启动/恢复流程

当双向通信中断时，按以下顺序恢复：

```
1. /status              → 确认 wechat_connected 和 bound 状态
2. 如果 disconnected    → /login 扫码
3. 如果 bound: false    → 手动创建 binding.json（见 7.2）
4. 如果 agent 未运行    → Monitor 启动 agent.js:
   node dist/agent.js --data-dir ~/.oceanbus-chat --name "CC"
5. 微信发测试消息       → 验证入站到达 CC 会话
6. CC 会话 reply 回复   → 验证出站到达微信
```

---

## 八、数据文件索引

```
~/.oceanbus-chat/
  └── credentials.json               CC OB 身份 (qMaPCu...) ★ agent.js --data-dir 必须指向这里

~/.claude/channels/wechat-cc/
  ├── wx-identity.json               微信用户永久 OB 身份 (ozXQy...)
  ├── bot-ob.json                    Gateway Bot OB 身份 (7OpWz...)
  ├── binding.json                   ★ iLink ↔ OB 绑定（可能需手动恢复）
  ├── routes.json                    前缀 → Agent OpenID 路由表
  └── wechat/
      ├── accounts/{id}-im-bot.json  ★ iLink bot_token + userId
      └── sync/{id}-im-bot.sync.json 长轮询 cursor

skills/wechat-cc/
  ├── src/
  │   ├── index.ts                   Gateway MCP 服务器（插件入口）
  │   └── agent.ts                   ★ Monitor 模式 Agent（stdout JSON）
  ├── dist/
  │   ├── index.js                   Gateway 构建产物（bun build）
  │   └── agent.js                   ★ Agent 构建产物（node 运行）
  ├── cc-agent.cjs                   已弃用的 standalone Agent
  ├── standalone.cjs                 独立网关（非 MCP 插件场景）
  └── .cc-data/
      └── credentials.json           备选身份 (2kkWz...) ★ 不要用
```

---

## 九、代码关键路径速查

| 功能 | 文件 | 行号 |
|------|------|------|
| MCP reply 工具处理 | `src/index.ts` | 266-278 |
| MCP send 工具处理 | `src/index.ts` | 279-293 |
| MCP login 处理 | `src/index.ts` | 294-302 |
| MCP status 处理 | `src/index.ts` | 304-321 |
| MCP logout 处理 | `src/index.ts` | 323-328 |
| 微信消息入口 | `src/index.ts` | 555-642 |
| Gateway → OB 转发 | `src/index.ts` | 615-638 |
| Bot OB 监听器（Agent 回复） | `src/index.ts` | 424-449 |
| wxOB 监听器（Announce + 回复） | `src/index.ts` | 470-527 |
| 系统命令处理 | `src/index.ts` | 125-204 |
| Agent OB 监听 + stdout emit | `src/agent.ts` | 116-148 |
| Agent announce | `src/agent.ts` | 86-104 |
| Agent 启动通知 | `src/agent.ts` | 151-165 |
