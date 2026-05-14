# WeChat → Agent 架构详解

## 角色表

| 名称 | 这是什么 | 谁提供的 | 在哪运行 |
|------|---------|---------|---------|
| **微信** | 你手机上的微信 App | 腾讯 | 你的手机 |
| **iLink API** | 腾讯的微信 Bot 接口。Bot 通过它收消息、发消息、出二维码 | 腾讯（ilinkai.weixin.qq.com） | 腾讯服务器 |
| **weixin-bot-plugin** | npm 包，封装了 iLink API。开发者不需要手写 HTTP 请求和 AES 解密 | MIT 开源社区 | wechat-cc 的依赖 |
| **Bot** | 微信 Bot 账号。每个 Bot 是一个独立的微信"联系人"，有自己的二维码和 token | wechat-cc 进程 | 用户本地机器 |
| **OceanBus L0** | P2P 身份和消息网络。每个参与者有一个 OpenID，彼此可以发加密消息 | OceanBus SDK | OceanBus 服务器 |
| **Agent** | 接收命令并执行的实体。CC 是其中一个 Agent，Trae/Cursor/OpenClaw 可以是其他 Agent | 各自 | 各自本地 |

---

## 三张图看懂

### 图1：iLink 负责什么

```
你手机微信
    │
    │ "帮我重构"
    ▼
┌─────────────┐
│  iLink API  │  ← 腾讯的微信 Bot 接口
│             │     二维码给你扫 → Bot 获得 token
│  get_bot_   │     getUpdates → Bot 收到消息（长轮询）
│  qrcode     │     sendMessage → Bot 回复消息
│  getUpdates │     getUploadUrl → Bot 收发图片/文件
│  sendMessage│
│  getUpload  │
└──────┬──────┘
       │
       │ HTTPS POST（Bearer token 鉴权）
       │
  ┌────┴────┐
  │  Bot    │   ← wechat-cc 进程
  └─────────┘
```

### 图2：weixin-bot-plugin 做什么

```
iLink API（原始 HTTP + AES 解密）
  │
  │ getUpdates 返回的是加密 JSON，CDN 文件需要 AES-ECB 解密
  │ 直接手写很痛苦
  │
  ▼
┌─────────────────────────┐
│  weixin-bot-plugin      │  ← npm install weixin-bot-plugin
│                         │
│  封装了：               │
│  - 扫码登录流程          │    开发者只需要：
│  - 长轮询 getUpdates    │    
│  - AES 加解密           │    bot.login()          → 出二维码
│  - CDN 上传下载         │    bot.on("message")    → 收到消息
│  - SILK 语音转码        │    bot.sendText(id,msg) → 回复消息
│  - Markdown→纯文本      │
│  - 会话过期检测          │
│                         │
│  暴露为 EventEmitter    │
└──────────┬──────────────┘
           │
           ▼
     我们的代码（wechat-cc）
     ┌──────────────────┐
     │ client.on(       │
     │  "message",      │  ← 收到微信消息的回调
     │  async (msg) => {│
     │    // 路由到     │
     │    // OB Agent   │
     │  }               │
     │ )                │
     └──────────────────┘
```

### 图3：Bot 的双重身份

```
             微信侧身份                       OB 侧身份
        ┌──────────────────┐         ┌──────────────────┐
        │  bot_token (iLink)│         │  OpenID (OceanBus)│
        │  "97141008e5de-   │         │  "fkGrTF7xx6..."  │
        │   im-bot"         │         │                   │
        │                   │         │                   │
        │  用于：           │         │  用于：           │
        │  - 微信收消息      │         │  - OB 收 Agent 回复│
        │  - 微信发消息      │         │  - OB 发消息给    │
        │  - 生成二维码      │         │    Agent           │
        └────────┬─────────┘         └────────┬─────────┘
                 │                            │
                 └──────────┬─────────────────┘
                            │
                    ┌───────┴──────┐
                    │   Bot 进程    │  ← 同一个 wechat-cc 进程
                    │               │     持有两把钥匙
                    │  路由逻辑     │
                    │  /cc → Agent1 │
                    │  /trae→Agent2 │
                    └───────────────┘
```

---

## 一个完整消息的旅行

```
  你的微信
    │
    │ "/cc 帮我重构"
    ▼
  iLink API（腾讯服务器）
    │ HTTPS 长轮询，Bot 拉到这条消息
    ▼
  weixin-bot-plugin
    │ 解密、解析 → 触发 "message" 事件
    ▼
  Bot（wechat-cc 进程）
    │ 解析前缀 "/cc"
    │ 查路由表 → CC_OpenID
    ▼
  OceanBus L0
    │ ob.send(CC_OpenID, "帮我重构")
    ▼
  Agent（CC 进程）
    │ OB 监听器收到消息
    │ 显示在终端：
    │ ── wechat · 15:22 ──
    │ 帮我重构
    ▼
  CC 执行 Claude，完成重构
    │ 拿到结果
    ▼
  OceanBus L0
    │ ob.send(Bot_OpenID, "重构完成，改了3个文件...")
    ▼
  Bot（wechat-cc 进程）
    │ OB 监听器收到 Agent 回复
    │ 提取 to_wx_user
    ▼
  weixin-bot-plugin
    │ client.sendText("wxuser_abc...", "重构完成...")
    ▼
  iLink API
    │ HTTPS POST sendMessage
    ▼
  你的微信
    │ 收到："🔔 CC 回复：重构完成，改了3个文件..."
    ▼
```

---

## 对应你的问题

**iLink 是微信插件接口吗？**
是的。iLink 是腾讯为第三方 Bot 提供的 HTTP API。weixin-bot-plugin 封装了它。

**微信插件负责创建二维码、收发消息？**
是的。这就是 iLink 的职责：`get_bot_qrcode`（出二维码）、`getUpdates`（收）、`sendMessage`（发）。

**Bot 是指什么？是我们的 SDK 吗？**
Bot 是 wechat-cc 这个进程。它不是 SDK——它使用了两个 SDK：
- `weixin-bot-plugin`（对接微信）
- `oceanbus`（对接 OB P2P 网络）

Bot 的职责是**翻译和路由**：微信消息 ↔ OB 消息。
