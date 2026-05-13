/**
 * wechat-cc v0.2.0 — OB Gateway
 *
 * WeChat ⇄ iLink ⇄ Gateway ⇄ OB L0 ⇄ Agents
 *
 * Gateway does NOT process commands. It only routes messages:
 *   Inbound:  parse prefix → lookup route → ob.send(Agent)
 *   Outbound: ob listener receives Agent reply → WeChat sendText
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WeixinBotClient } from "weixin-bot-plugin";
import type { InboundMessage } from "weixin-bot-plugin";
import { z } from "zod";

// ── Logging ───────────────────────────────────────────────────
function log(msg: string): void {
  process.stderr.write(`[wechat-cc] ${msg}\n`);
}

// ── State ─────────────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), ".claude", "channels", "wechat-cc");
const ROUTES_FILE = path.join(STATE_DIR, "routes.json");
const BINDING_FILE = path.join(STATE_DIR, "binding.json");
const BOT_OB_FILE = path.join(STATE_DIR, "bot-ob.json");
const WX_IDENTITY_FILE = path.join(STATE_DIR, "wx-identity.json");
const CC_CRED_FILE = path.join(os.homedir(), ".oceanbus-chat", "credentials.json");

function ensureDir() { fs.mkdirSync(STATE_DIR, { recursive: true }); }

// ── Route Table ────────────────────────────────────────────────
interface RouteEntry {
  openId: string;
  name: string;
  type?: string;
  addedAt: string;
}
interface RouteTable {
  routes: Record<string, RouteEntry>;
  default: string;
}

function loadRoutes(): RouteTable {
  try {
    if (fs.existsSync(ROUTES_FILE)) return JSON.parse(fs.readFileSync(ROUTES_FILE, "utf-8"));
  } catch (_) {}
  return { routes: {}, default: "" };
}

function saveRoutes(rt: RouteTable) {
  ensureDir();
  fs.writeFileSync(ROUTES_FILE, JSON.stringify(rt, null, 2), "utf-8");
}

function lookupRoute(prefix: string, rt: RouteTable): RouteEntry | null {
  return rt.routes[prefix] || null;
}

// ── Binding ────────────────────────────────────────────────────
interface Binding {
  ilinkUserId: string;
  wxOpenId?: string;
  defaultRoute: string;
  boundAt: string;
}

function loadBinding(): Binding | null {
  try {
    if (fs.existsSync(BINDING_FILE)) return JSON.parse(fs.readFileSync(BINDING_FILE, "utf-8"));
  } catch (_) {}
  return null;
}

function saveBinding(b: Binding) {
  ensureDir();
  fs.writeFileSync(BINDING_FILE, JSON.stringify(b, null, 2), "utf-8");
}

// ── OB Credentials ─────────────────────────────────────────────
function loadCcObCreds() {
  try { if (fs.existsSync(CC_CRED_FILE)) return JSON.parse(fs.readFileSync(CC_CRED_FILE, "utf-8")); } catch (_) {}
  return null;
}
function loadBotObCreds() {
  try { if (fs.existsSync(BOT_OB_FILE)) return JSON.parse(fs.readFileSync(BOT_OB_FILE, "utf-8")); } catch (_) {}
  return null;
}
function saveBotObCreds(data: unknown) { ensureDir(); fs.writeFileSync(BOT_OB_FILE, JSON.stringify(data, null, 2), "utf-8"); }
function loadWxIdentity() {
  try { if (fs.existsSync(WX_IDENTITY_FILE)) return JSON.parse(fs.readFileSync(WX_IDENTITY_FILE, "utf-8")); } catch (_) {}
  return null;
}
function saveWxIdentity(data: unknown) { ensureDir(); fs.writeFileSync(WX_IDENTITY_FILE, JSON.stringify(data, null, 2), "utf-8"); }

// ── Session State (Model C) ───────────────────────────────────
interface SessionState {
  current: string; // current default route prefix
}
const sessions: Record<string, SessionState> = {};

function getSession(wxUserId: string): SessionState {
  if (!sessions[wxUserId]) {
    sessions[wxUserId] = { current: loadRoutes().default || "/cc" };
  }
  return sessions[wxUserId];
}

// ── System Commands ────────────────────────────────────────────
function handleSystemCommand(text: string, wxUserId: string, rt: RouteTable): string | null {
  const parts = text.trim().split(/\s+/);

  switch (parts[0]) {
    case "/help": {
      const prefixes = Object.keys(rt.routes);
      const list = prefixes.length > 0
        ? prefixes.map(p => `  ${p} → ${rt.routes[p].name}`).join("\n")
        : "  (无)";
      const def = rt.default || "(未设置)";
      const session = getSession(wxUserId);
      return `当前会话: ${session.current}\n\n可用 Agent:\n${list}\n\n默认: ${def}\n\n命令: /help /use /who /routes /addroute /removeroute /default\n\n直接发消息 → 当前会话\n/xxx 消息 → 临时发给指定 Agent\n\n💡 重名 Agent? 删除旧路由后重新 /addroute 指定新名字`;
    }
    case "/use": {
      if (parts.length < 2) return `用法: /use /xxx\n当前会话: ${getSession(wxUserId).current}`;
      const prefix = parts[1];
      if (!prefix.startsWith("/")) return "前缀必须以 / 开头";
      if (!rt.routes[prefix]) return `路由不存在: ${prefix}。可用: ${Object.keys(rt.routes).join(", ") || "(无)"}`;
      getSession(wxUserId).current = prefix;
      return `✅ 已切换到 ${prefix} → ${rt.routes[prefix].name}`;
    }
    case "/myid": {
      const wxId = loadWxIdentity();
      if (!wxId?.openid) return "微信 OB 身份尚未注册。请先扫码登录。";
      return `你的微信 OB OpenID:\n\n${wxId.openid}\n\nAgent 用这个地址连接你，不需要扫码。`;
    }
    case "/who": {
      const session = getSession(wxUserId);
      const route = rt.routes[session.current];
      const info = route ? `${session.current} → ${route.name}` : session.current;
      const all = Object.keys(rt.routes).map(p =>
        p === session.current ? `* ${p} → ${rt.routes[p].name}` : `  ${p} → ${rt.routes[p].name}`
      ).join("\n");
      const wxId = loadWxIdentity();
      const wxLine = wxId?.openid ? `\n📱 你的微信 OB: ${wxId.openid.slice(0, 5)}... (发给agent管理员即可连接)` : '';
      return `当前会话: ${info}\n\n所有 Agent:\n${all}${wxLine}`;
    }
    case "/routes": {
      const entries = Object.entries(rt.routes);
      if (entries.length === 0) return "路由表为空。使用 /addroute /xxx OpenID 名称 添加。";
      return entries.map(([k, v]) => `${k} → ${v.name} (${v.openId.slice(0, 5)}...)`).join("\n")
        + `\n\n默认: ${rt.default || "(未设置)"}`;
    }
    case "/addroute": {
      if (parts.length < 4) return "用法: /addroute /xxx OpenID 名称\n例如: /addroute /trae trae_openid_xxx Trae";
      const prefix = parts[1];
      if (!prefix.startsWith("/")) return "前缀必须以 / 开头，例如 /trae";
      const openId = parts[2];
      const name = parts.slice(3).join(" ");
      rt.routes[prefix] = { openId, name, addedAt: new Date().toISOString() };
      if (!rt.default) rt.default = prefix;
      saveRoutes(rt);
      return `✅ 已添加路由: ${prefix} → ${name} (${openId.slice(0, 5)}...)`;
    }
    case "/removeroute": {
      if (parts.length < 2) return "用法: /removeroute /xxx";
      const prefix = parts[1];
      if (!rt.routes[prefix]) return `路由不存在: ${prefix}`;
      const removed = rt.routes[prefix];
      delete rt.routes[prefix];
      if (rt.default === prefix) {
        const remaining = Object.keys(rt.routes);
        rt.default = remaining.length > 0 ? remaining[0] : "";
      }
      saveRoutes(rt);
      return `✅ 已移除: ${prefix} → ${removed.name}`;
    }
    case "/default": {
      if (parts.length < 2) return "用法: /default /xxx";
      const prefix = parts[1];
      if (!rt.routes[prefix]) return `路由不存在: ${prefix}。先用 /addroute 添加。`;
      rt.default = prefix;
      saveRoutes(rt);
      return `✅ 默认 Agent 已设为: ${prefix} → ${rt.routes[prefix].name}`;
    }
    default:
      return null; // not a system command
  }
}

// ── MCP Server ─────────────────────────────────────────────────
function createMcpServer(client: WeixinBotClient, getState: () => {
  rt: RouteTable; binding: Binding | null; ccOpenId: string; botOpenId: string;
}) {
  const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)(?:\s+([a-km-z]{5}))?\s*$/i;
  let pendingPermissionRequestId: string | undefined;

  const server = new Server(
    { name: "wechat", version: "0.2.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
        tools: {},
      },
      instructions:
        '微信消息通过 OB L0 投递到 Agent。用 reply 工具回复微信消息，传入 chat_id。',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "回复微信消息",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string", description: "目标用户 ID（微信消息 meta 中的 from_wx_user）" },
            text: { type: "string", description: "回复文本内容" },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "login",
        description: "发起微信扫码登录（如被折叠按 ctrl+o 展开）",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "status",
        description: "查询网关状态：微信连接 + 路由表 + OB 身份",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "logout",
        description: "登出微信，清除凭证",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments as Record<string, string>) || {};

    switch (name) {
      case "reply": {
        if (!args.chat_id || !args.text) {
          return { content: [{ type: "text" as const, text: "缺少 chat_id 或 text 参数" }] };
        }
        client.stopTyping(args.chat_id);
        try {
          await client.sendText(args.chat_id, args.text);
          return { content: [{ type: "text" as const, text: "已发送" }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `发送失败: ${String(e)}` }] };
        }
      }
      case "login": {
        const result = await client.login();
        if (!result.qrcodeUrl) {
          return { content: [{ type: "text" as const, text: `登录失败: ${result.message}` }] };
        }
        const text = result.qrAscii
          ? `请用手机微信扫描以下二维码登录（如被折叠请按 ctrl+o 展开）:\n\n${result.qrAscii}\n\n链接: ${result.qrcodeUrl}`
          : `${result.message}\n\n链接: ${result.qrcodeUrl}`;
        return { content: [{ type: "text" as const, text }] };
      }
      case "status": {
        const s = client.getStatus();
        const st = getState();
        return { content: [{
          type: "text" as const,
          text: JSON.stringify({
            wechat_connected: s.connected,
            wechat_user: s.userId || "(未登录)",
            gateway_ob: st.botOpenId ? st.botOpenId.slice(0, 5) + "..." : "(未注册)",
            cc_ob: st.ccOpenId ? st.ccOpenId.slice(0, 5) + "..." : "(未注册)",
            bound: !!st.binding,
            default_route: st.rt.default,
            routes: Object.keys(st.rt.routes).length,
          }),
        }] };
      }
      case "logout": {
        const s = client.getStatus();
        if (!s.accountId) return { content: [{ type: "text" as const, text: "当前没有已登录的微信账号" }] };
        await client.logout();
        try { fs.unlinkSync(BINDING_FILE); } catch (_) {}
        return { content: [{ type: "text" as const, text: `已登出 ${s.accountId}` }] };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  // Permission forwarding
  server.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(), tool_name: z.string(),
        description: z.string(), input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const s = client.getStatus();
      if (!s.userId) return;
      try {
        await client.sendText(s.userId,
          `Claude 请求执行 ${params.tool_name}:\n${params.description}\n` +
          (params.input_preview ? `输入: ${params.input_preview}\n` : "") +
          `\n回复 yes / no`,
          { raw: true }
        );
        pendingPermissionRequestId = params.request_id;
      } catch (e) { log(`perm forward failed: ${String(e)}`); }
    }
  );

  return server;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log("wechat-cc v0.2.0 gateway starting...");

  // 1. Load state
  let rt = loadRoutes();
  const binding = loadBinding();
  let ccCreds = loadCcObCreds();
  let ccOpenId = ccCreds?.openid || "";
  if (ccOpenId) log(`CC OB: ${ccOpenId.slice(0, 5)}...`);
  else log("CC OB not registered yet");

  // 2. Bot OB identity
  let botObCreds = loadBotObCreds();
  if (!botObCreds?.openid) {
    log("Registering Bot OB identity...");
    const oceanbus = await import("oceanbus");
    const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
    try {
      const reg = await ob.createIdentity();
      const openid = await ob.getAddress();
      botObCreds = { agent_id: reg.agent_id, api_key: reg.api_key, openid, created_at: new Date().toISOString() };
      saveBotObCreds(botObCreds);
      log(`Bot OB created: ${openid.slice(0, 5)}...`);
    } catch (e: any) { log(`Bot OB failed: ${e.message}`); }
    await ob.destroy();
  }
  const botOpenId = botObCreds?.openid || "";

  // 2b. WeChat user OB identity (permanent, survives iLink session expiry)
  let wxIdentity = loadWxIdentity();
  if (!wxIdentity?.openid) {
    log("Registering WeChat user OB identity...");
    try {
      const oceanbus = await import("oceanbus");
      const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
      const reg = await ob.createIdentity();
      const openid = await ob.getAddress();
      wxIdentity = { agent_id: reg.agent_id, api_key: reg.api_key, openid, created_at: new Date().toISOString() };
      saveWxIdentity(wxIdentity);
      log(`wxOpenId created: ${openid.slice(0, 5)}...`);
      await ob.destroy();
    } catch (e: any) { log(`wxOpenId registration failed: ${e.message}`); }
  } else {
    log(`wxOpenId: ${wxIdentity.openid.slice(0, 5)}...`);
  }
  const wxOpenId = wxIdentity?.openid || "";

  // 3. Auto-add CC to route table if not present
  if (ccOpenId && !rt.routes["/cc"]) {
    rt.routes["/cc"] = {
      openId: ccOpenId,
      name: "CC-" + ccOpenId.slice(0, 4),
      type: "claude-code",
      addedAt: new Date().toISOString(),
    };
    if (!rt.default) rt.default = "/cc";
    saveRoutes(rt);
    log(`auto-added /cc route → ${ccOpenId.slice(0, 5)}...`);
  }

  // 4. WeixinBotClient
  const client = new WeixinBotClient({
    stateDir: path.join(STATE_DIR, "wechat"),
    tempDir: path.join(os.tmpdir(), "wechat-cc"),
    clientIdPrefix: "wechat-cc",
  });
  await client.cleanupTempMedia().catch(() => {});

  // 5. OB listener: receives Agent replies → WeChat
  let obListener: any = null;
  if (botOpenId && botObCreds) {
    try {
      const oceanbus = await import("oceanbus");
      obListener = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: botObCreds.agent_id, api_key: botObCreds.api_key, openid: botOpenId },
      });
      obListener.startListening(async (msg: any) => {
        if (msg.from_openid === botOpenId) return;
        const content: string = msg.content || "";
        let parsed: any;
        try { parsed = JSON.parse(content); } catch (_) { parsed = { action: "reply", text: content }; }

        const meta = parsed.meta || {};
        const toWxUser = meta.to_wx_user || "";

        if (toWxUser) {
          const replyText = parsed.text || content;
          const agentName = meta.agent_name || "Agent";
          log(`[←OB] Agent → WeChat ${toWxUser.slice(0, 12)}...`);
          try {
            await client.sendText(toWxUser, `🔔 ${agentName} 回复：\n\n${replyText}`);
          } catch (e: any) { log(`OB→WeChat failed: ${e.message}`); }
        }
      });
      log("OB reply listener started (botOpenId)");
    } catch (e: any) { log(`OB listener failed: ${e.message}`); }
  }

  // 5b. OB listener for wxOpenId: receives Agent announces + replies sent to WeChat user
  if (wxOpenId && wxIdentity) {
    try {
      const oceanbus = await import("oceanbus");
      const obWx = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: wxIdentity.agent_id, api_key: wxIdentity.api_key, openid: wxOpenId },
      });
      obWx.startListening(async (msg: any) => {
        if (msg.from_openid === wxOpenId) return;
        const content: string = msg.content || "";
        let parsed: any;
        try { parsed = JSON.parse(content); } catch (_) { parsed = { action: "reply", text: content }; }

        const action = parsed.action || "reply";
        const meta = parsed.meta || {};

        // Agent announces itself → auto-add route
        if (action === "announce") {
          const agentName = meta.agent_name || ("Agent-" + msg.from_openid.slice(0, 4));
          const agentOpenId = meta.agent_openid || msg.from_openid;
          const prefix = "/" + agentName.toLowerCase().replace(/\s+/g, '-');
          rt = loadRoutes();
          if (!rt.routes[prefix]) {
            rt.routes[prefix] = { openId: agentOpenId, name: agentName, type: meta.agent_type || "agent", addedAt: new Date().toISOString() };
            if (!rt.default) rt.default = prefix;
            saveRoutes(rt);
            log(`[announce] auto-added route: ${prefix} → ${agentName}`);
            const binding = loadBinding();
            if (binding?.ilinkUserId) {
              client.sendText(binding.ilinkUserId, `🔔 ${agentName} 已连接！/use ${prefix} 切换为主Agent`).catch(() => {});
            }
          }
          return;
        }

        // Normal reply: forward to WeChat
        const toWxUser = meta.to_wx_user || "";
        const replyText = parsed.text || content;
        const agentName = meta.agent_name || "Agent";

        if (toWxUser) {
          log(`[←wxOB] Agent → WeChat ${toWxUser.slice(0, 12)}...`);
          try {
            await client.sendText(toWxUser, `🔔 ${agentName} 回复：\n\n${replyText}`);
          } catch (e: any) { log(`OB→WeChat failed: ${e.message}`); }
        }
      });
      log("OB reply listener started (wxOpenId)");
    } catch (e: any) { log(`OB listener failed: ${e.message}`); }
  }

  // 6. Event bindings
  client.on("loginSuccess", (accountId: string) => {
    log(`login success: ${accountId}`);
    const s = client.getStatus();
    if (s.userId) {
      saveBinding({ ilinkUserId: s.userId, wxOpenId, defaultRoute: rt.default, boundAt: new Date().toISOString() });
      log(`bound: ${s.userId.slice(0, 12)}... ↔ wxOpenId ${wxOpenId.slice(0, 5)}... → default ${rt.default}`);
      const routesList = Object.keys(rt.routes).map(p => `  ${p} → ${rt.routes[p].name}`).join("\n");
      client.sendText(s.userId,
        `🎉 欢迎来到 OceanBus 网关！\n\n` +
        `✅ 已自动绑定\n` +
        `📍 当前会话: ${rt.default}\n` +
        `📱 你的微信 OB OpenID: ${wxOpenId.slice(0, 5)}...\n\n` +
        `可用 Agent:\n${routesList || "  (暂无)"}\n\n` +
        `快速上手:\n` +
        `  直接发消息 → 发给当前会话\n` +
        `  /myid → 查看你的微信 OB 地址\n` +
        `  /use /xxx → 切换默认会话\n` +
        `  /who → 查看所有 Agent\n` +
        `  /help → 完整命令列表\n\n` +
        `💡 让 Agent 管理员把你的 wxOpenId 发给 Agent，Agent 启动时自动连接，不需要扫码。`
      ).catch(() => {});
    }
  });

  client.on("message", async (msg: InboundMessage) => {
    const text = (msg.text || "").trim();
    if (!text) return;
    log(`[微信] ${msg.chatId.slice(0, 12)}...: ${text.slice(0, 80)}`);

    // Reload routes (may have been updated)
    rt = loadRoutes();

    // System commands
    const sysReply = handleSystemCommand(text, msg.chatId, rt);
    if (sysReply !== null) {
      await client.sendText(msg.chatId, sysReply).catch(() => {});
      return;
    }

    // Check binding
    const binding = loadBinding();
    if (!binding) {
      await client.sendText(msg.chatId, "请先扫码绑定。发送 /help 查看说明。").catch(() => {});
      return;
    }

    // Parse route prefix (Model C: default session + single override)
    let prefix = "";
    let body = text;
    let isOverride = false;
    const m = text.match(/^(\/\S+)\s+(.*)/);
    if (m && rt.routes[m[1]]) {
      // Known prefix → single-message override (doesn't change session)
      prefix = m[1];
      body = m[2];
      isOverride = true;
    } else {
      // No prefix (or unknown prefix) → use current session
      const session = getSession(msg.chatId);
      prefix = session.current;
      body = text;
    }

    const route = lookupRoute(prefix, rt);
    if (!route) {
      await client.sendText(msg.chatId,
        `会话 ${prefix} 不可用。用 /use /xxx 切换，或 /help 查看可用 Agent。`
      ).catch(() => {});
      return;
    }

    // Forward to Agent via OB
    if (!botOpenId || !botObCreds) {
      await client.sendText(msg.chatId, "网关 OB 未就绪，请稍后重试。").catch(() => {});
      return;
    }

    try {
      const oceanbus = await import("oceanbus");
      const ob = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: botObCreds.agent_id, api_key: botObCreds.api_key, openid: botOpenId },
      });
      const obMsg = JSON.stringify({
        action: "command",
        text: body,
        meta: {
          from_wx_user: msg.chatId,
          route_prefix: prefix,
          agent_name: route.name,
          is_override: isOverride,
          session_current: getSession(msg.chatId).current,
          message_id: `wx_${Date.now()}`,
        },
      });
      await ob.send(route.openId, obMsg);
      await ob.destroy();
      log(`[→OB] → ${route.name} (${route.openId.slice(0, 5)}...)`);
      const label = isOverride ? `[→${route.name}] ` : '';
      await client.sendText(msg.chatId, `${label}已转发，等待回复...`).catch(() => {});
    } catch (e: any) {
      log(`OB send failed: ${e.message}`);
      await client.sendText(msg.chatId, `转发失败: ${e.message}`).catch(() => {});
    }
  });

  client.on("sessionExpired", async () => {
    log("session expired");
  });

  client.on("qrRefresh", async ({ qrcodeUrl, qrAscii }) => {
    log(`QR refreshed: ${qrcodeUrl}`);
  });

  client.on("error", (err: unknown) => log(`client error: ${String(err)}`));

  // 7. MCP server
  const server = createMcpServer(client, () => ({ rt, binding: loadBinding(), ccOpenId, botOpenId }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP connected (login/status/logout tools only)");

  // 8. Start Bot
  let shuttingDown = false;
  function shutdown() { if (shuttingDown) return; shuttingDown = true; client.stop(); process.exit(0); }
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const accounts = client.listAccounts();
  const launched = accounts.length > 0 && (await client.start(accounts[0]));
  if (!launched) {
    log("no accounts, will prompt login via MCP status");
  } else {
    log(`gateway ready — ${Object.keys(rt.routes).length} routes, default: ${rt.default || "(none)"}`);
  }

  await new Promise(() => {});
}

main().catch((err) => { log(`fatal: ${String(err)}`); process.exit(1); });
