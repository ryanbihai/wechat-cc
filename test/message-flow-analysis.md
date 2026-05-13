# WeChat → CC 消息链路分析

> 2026-05-13 · v0.1.8 测试结果

## 完整链路

```
1. 微信 App
   → iLink Bot API (https://ilinkai.weixin.qq.com)
   
2. weixin-bot-plugin (长轮询 getUpdates)
   → 收到 WeixinMessage { from_user_id, item_list: [{text_item}] }
   
3. WeixinBotClient 发出 "message" 事件
   → InboundMessage { chatId, text, raw }
   
4. 我们的 handler (client.on("message"))
   → 构造 { content: msg.text, meta: {type:"message", chat_id, sender} }
   → server.notification({method: "notifications/claude/channel", params})
   
5. MCP stdio transport
   → JSON-RPC notification → CC 进程 stdin
   
6. Claude Code 内部
   → 解析 notification → 路由到 Channel handler → 显示在会话中
```

## 各环节测试结果

| 环节 | 状态 | 验证方式 |
|------|------|---------|
| 1→2 iLink 长轮询 | ✅ | typing 指示器出现；OB L0 路径收到消息 |
| 2→3 message 事件 | ✅ | handler 中的 startTyping() 生效 |
| 3→4 handler 执行 | ✅ | OB 路径发送成功（老 monitor 收到） |
| 4→5 MCP notification | ✅ | 测试客户端收到 login prompt + _simulate 通知 |
| 5→6 CC 显示 | ❓ | login prompt 能显示，消息通知不显示 |

## 关键发现

### notification 发送确认正常
- `_simulate` 工具调用 `server.notification()` → 测试客户端立即收到
- login prompt notification → CC 显示"请调用 login 工具"
- 测试消息 notification → 测试客户端收到，CC 不确定是否显示

### 格式差异

**login prompt**（CC 显示）：
```json
{"meta": {"type": "login_required"}, "content": "微信 Channel 已启动..."}
```

**消息通知**（v0.1.8 格式，待验证）：
```json
{"meta": {"type": "message", "chat_id": "...", "sender": "..."}, "content": "hi"}
```

## 假设

1. **CC 需要 `type: "message"`** — v0.1.8 已添加，待重启验证
2. **CC Channel 路由问题** — weixin-claude-code 残留状态可能干扰，已清理
3. **通知被 CC 折叠** — 可能显示为折叠的 `<channel>` 块，CC agent 不处理
4. **时序问题** — 通知在 long-poll 循环中发送，可能被事件循环延迟

## 下一步测试

1. 重启 CC → `_simulate` 发送测试消息 → 检查 CC 会话中是否出现
2. 微信发真实消息 → 检查是否出现
3. 如果 _simulate 出现但真实消息不出现 → 问题在 handler 中
4. 如果都不出现 → 问题在 CC 对 message 类型通知的处理
