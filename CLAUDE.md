# wechat-cc

WeChat Channel for Claude Code — MCP Channel adapter over OceanBus L0.

## Commands

```bash
bun run build      # Bun build → dist/index.js (single file)
bun run start      # Start MCP server
bun run typecheck  # tsc --noEmit
bun run dev        # tsc --watch
```

## Architecture

```
src/index.ts  — Entry point: WeixinBotClient + MCP Server + OB L0
                All logic in one file (~280 lines).

Dependencies:
  weixin-bot-plugin     — iLink API (QR login, long-poll, send/recv)
  @modelcontextprotocol/sdk — MCP Channel protocol (stdio server)
  oceanbus              — L0 P2P identity and messaging
```

## Key Design Decisions

- **Auto-bind on QR scan**: When `loginSuccess` fires, `ilink_user_id` is
  automatically paired with CC's OpenID. No manual pair command needed.
- **Dual message path**: WeChat messages go to CC via both MCP notification
  (real-time) and OB L0 (store-and-forward). OB L0 delivery can fail silently.
- **Permission forwarding**: `PERMISSION_REPLY_RE` intercepts yes/no replies
  from WeChat and forwards them as `claude/channel/permission` notifications.
- **OB L0 is secondary**: The primary path is direct MCP notification.
  OB L0 exists for offline queuing and future multi-agent scenarios.

## State Files

```
~/.claude/channels/wechat-cc/
  ├── pairing.json     — {ilinkUserId, ccOpenId, ccAgentId}
  ├── bot-ob.json      — Bot's OB L0 identity
  └── wechat/          — WeixinBotClient state (accounts, sync)
```

CC's OB identity is read from `~/.oceanbus-chat/credentials.json` (shared with ocean-chat).

## Publishing

```bash
/plugin publish wechat-cc@oceanbus-plugins
```
