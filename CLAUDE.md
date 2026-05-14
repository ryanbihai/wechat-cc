# wechat-cc

WeChat Channel for Claude Code — OB Gateway + Agent over OceanBus L0.

## Commands

```bash
bun run build      # Build: dist/index.js (gateway) + dist/agent.js (CC listener)
bun run start      # Start MCP server (gateway)
bun run typecheck  # tsc --noEmit
```

## Architecture

```
src/index.ts  — Gateway: WeixinBotClient + MCP Server + OB L0 routing
src/agent.ts  — CC Agent: OB listener → stdout JSON → Monitor → CC session

Dependencies:
  weixin-bot-plugin     — iLink API (QR login, long-poll, send/recv)
  @modelcontextprotocol/sdk — MCP stdio server (tools only, no channels)
  oceanbus              — L0 P2P identity and messaging
```

## Key Design Decisions

- **OB + Monitor, no MCP channels**: Messages route through OB L0 to agent.js,
  which prints JSON to stdout. CC Monitor captures stdout and pushes events
  into the conversation. No `--channels` flag required.
- **Auto-bind on QR scan**: When `loginSuccess` fires, `ilink_user_id` is
  automatically paired. No manual pair command needed.
- **Gateway routes only**: Gateway does NOT process commands. It parses
  route prefixes, looks up OpenIDs, and forwards via OB.
- **Agent announces on startup**: agent.js sends an `announce` action to
  Gateway's wxOpenId, which auto-adds the route and notifies WeChat user.

## State Files

```
~/.claude/channels/wechat-cc/
  ├── routes.json       — Route table {/cc → {openId, name}, /trae → ...}
  ├── binding.json      — {ilinkUserId, wxOpenId, defaultRoute}
  ├── bot-ob.json       — Gateway's OB identity
  ├── wx-identity.json  — WeChat user's OB identity (permanent)
  └── wechat/           — WeixinBotClient state (accounts, sync)

<project>/.cc-data/      — CC Agent OB identity (agent.js --data-dir)
  ├── credentials.json
  └── cursor.json
```

CC's OB identity is also read from `~/.oceanbus-chat/credentials.json` (shared with ocean-chat).

## Publishing

```bash
/plugin publish wechat-cc@oceanbus-plugins
```
