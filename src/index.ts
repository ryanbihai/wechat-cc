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

// ── Route Helpers ──────────────────────────────────────────────
function findRoute(input: string, rt: RouteTable): { prefix: string; route: RouteEntry } | null {
  const lower = input.toLowerCase();
  for (const [key, val] of Object.entries(rt.routes)) {
    if (key.toLowerCase() === lower) return { prefix: key, route: val };
  }
  return null;
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
      const input = parts[1];
      if (!input.startsWith("/")) return "前缀必须以 / 开头";
      const found = findRoute(input, rt);
      if (!found) return `路由不存在: ${input}。可用: ${Object.keys(rt.routes).join(", ") || "(无)"}`;
      getSession(wxUserId).current = found.prefix;
      return `✅ 已切换到 ${found.prefix} → ${found.route.name}`;
    }
    case "/myid": {
      const wxId = loadWxIdentity();
      if (!wxId?.openid) return "微信 OB 身份尚未注册。请先扫码登录。";
      return `你的微信 OB OpenID:\n\n${wxId.openid}\n\nAgent 用这个地址连接你，不需要扫码。`;
    }
    case "/who": {
      const session = getSession(wxUserId);
      const prefixes = Object.keys(rt.routes);
      const def = prefixes.find(p => p === session.current) || rt.default || prefixes[0] || "";
      const others = prefixes.filter(p => p !== def);
      const defLine = `默认Agent：${def || "(无)"}`;
      const otherLines = others.length > 0
        ? `\n可用Agent：\n${others.join("\n")}`
        : "";
      const hint = prefixes.length > 1
        ? `\n\n不加前缀，与默认Agent会话；加上/<agent-name>，可以与指定的Agent会话`
        : "";
      return `${defLine}${otherLines}${hint}`;
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
function createMcpServer(client: WeixinBotClient) {
  const server = new Server(
    { name: "wechat", version: "0.4.0" },
    {
      capabilities: { tools: {} },
      instructions:
        '微信消息通过 OB L0 + Monitor 投递到 Agent。用 reply 回复微信消息（需 chat_id，可选 name 区分多窗口），用 send 主动发消息。用 login 扫码登录，用 status 查看状态。说"启动微信"开始监听。多窗口：每个窗口启动 agent.js 时用 --name 指定唯一名，微信端 /<name> 发给指定窗口，/use /<name> 切换默认窗口。',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "回复微信消息，自动带上窗口名前缀（如 🔔CC-Win1：）方便微信用户区分来源",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string", description: "目标用户 ID（微信消息 meta 中的 from_wx_user）" },
            text: { type: "string", description: "回复文本内容" },
            name: { type: "string", description: "窗口名（可选，用于 🔔<name>： 前缀，不传默认 Claude Code）" },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "send",
        description: "发送微信消息，自动带上窗口名前缀。chat_id 可选，不传则自动发给已绑定用户",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string", description: "目标用户 ID（可选，不传则发给已绑定用户）" },
            text: { type: "string", description: "发送的文本内容" },
            name: { type: "string", description: "窗口名（可选，用于 🔔<name>： 前缀，不传默认 Claude Code）" },
          },
          required: ["text"],
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
          const sender = args.name || "Claude Code";
          const prefix = args.text.startsWith('🔔') ? '' : `🔔${sender}：\n`;
          await client.sendText(args.chat_id, prefix + args.text);
          return { content: [{ type: "text" as const, text: "已发送" }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `发送失败: ${String(e)}` }] };
        }
      }
      case "send": {
        if (!args.text) {
          return { content: [{ type: "text" as const, text: "缺少 text 参数" }] };
        }
        const chatId = args.chat_id || loadBinding()?.ilinkUserId;
        if (!chatId) {
          return { content: [{ type: "text" as const, text: "无绑定用户且未指定 chat_id。请先扫码登录绑定。" }] };
        }
        try {
          const sender = args.name || "Claude Code";
          const prefix = args.text.startsWith('🔔') ? '' : `🔔${sender}：\n`;
          await client.sendText(chatId, prefix + args.text);
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
        const rt = loadRoutes();
        let binding = loadBinding();
        // Auto-recover binding if missing but iLink is connected
        const wxId = loadWxIdentity();
        if (!binding && s.connected && s.userId && wxId?.openid) {
          saveBinding({ ilinkUserId: s.userId, wxOpenId: wxId.openid, defaultRoute: rt.default, boundAt: new Date().toISOString() });
          binding = loadBinding();
          log(`auto-recovered binding via status: ${s.userId.slice(0, 12)}...`);
        }
        const ccCreds = loadCcObCreds();
        const botOb = loadBotObCreds();
        return { content: [{
          type: "text" as const,
          text: JSON.stringify({
            wechat_connected: s.connected,
            wechat_user: s.userId || "(未登录)",
            gateway_ob: botOb?.openid ? botOb.openid.slice(0, 5) + "..." : "(未注册)",
            cc_ob: ccCreds?.openid ? ccCreds.openid.slice(0, 5) + "..." : "(未注册)",
            bound: !!binding,
            default_route: rt.default,
            routes: Object.keys(rt.routes).length,
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

  return { server };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log("wechat-cc v0.4.0 gateway starting...");

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
  let currentBotOpenId = botOpenId;
  if (botObCreds) {
    try {
      const oceanbus = await import("oceanbus");
      obListener = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: botObCreds.agent_id, api_key: botObCreds.api_key, openid: botObCreds.openid },
      });
      const freshBotOpenId = await obListener.getAddress();
      if (freshBotOpenId !== botOpenId) {
        botObCreds.openid = freshBotOpenId;
        saveBotObCreds(botObCreds);
        currentBotOpenId = freshBotOpenId;
        log(`Bot OpenID refreshed`);
      }
      obListener.startListening(async (msg: any) => {
        if (msg.from_openid === currentBotOpenId) return;
        const content: string = msg.content || "";
        let parsed: any;
        try { parsed = JSON.parse(content); } catch (_) { parsed = null; }

        // JSON format
        let toWxUser = parsed?.meta?.to_wx_user || "";
        let replyText = parsed?.text || "";
        let agentName = parsed?.meta?.agent_name || "Agent";

        // Old format (plain text w/ routing headers): fallback to binding
        if (!toWxUser) {
          replyText = content.replace(/^from .+\nto .+\n/m, '').trim();
          agentName = "CC";
          const b = loadBinding();
          toWxUser = b?.ilinkUserId || "";
        }

        if (toWxUser) {
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
  let currentWxOpenId = wxOpenId;
  if (wxIdentity) {
    try {
      const oceanbus = await import("oceanbus");
      const obWx = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: wxIdentity.agent_id, api_key: wxIdentity.api_key, openid: wxIdentity.openid },
      });
      const freshWxOpenId = await obWx.getAddress();
      if (freshWxOpenId !== wxOpenId) {
        wxIdentity.openid = freshWxOpenId;
        saveWxIdentity(wxIdentity);
        currentWxOpenId = freshWxOpenId;
        log(`WX OpenID refreshed`);
      }
      obWx.startListening(async (msg: any) => {
        if (msg.from_openid === currentWxOpenId) return;
        const content: string = msg.content || "";
        let parsed: any;
        try { parsed = JSON.parse(content); } catch (_) { parsed = { action: "reply", text: content }; }

        const action = parsed.action || "reply";
        const meta = parsed.meta || {};

        // Agent announces itself → auto-add route
        if (action === "announce") {
          const agentName = meta.agent_name || ("Agent-" + msg.from_openid.slice(0, 4));
          const agentOpenId = meta.agent_openid || msg.from_openid;
          let routeName = agentName;
          let prefix = "/" + routeName.toLowerCase().replace(/\s+/g, '-');
          rt = loadRoutes();
          // Collision: same name, different agent → auto-increment
          if (rt.routes[prefix] && rt.routes[prefix].openId !== agentOpenId) {
            let suffix = 2;
            while (rt.routes[prefix + "-" + suffix]) suffix++;
            routeName = agentName + "-" + suffix;
            prefix = prefix + "-" + suffix;
          }
          const isNew = !rt.routes[prefix];
          if (isNew) {
            rt.routes[prefix] = { openId: agentOpenId, name: routeName, type: meta.agent_type || "agent", addedAt: new Date().toISOString() };
            if (!rt.default) rt.default = prefix;
            saveRoutes(rt);
            log(`[announce] auto-added route: ${prefix} → ${routeName}`);
          } else {
            // Agent re-connected → update OpenID (may have changed)
            rt.routes[prefix].openId = agentOpenId;
            rt.routes[prefix].name = routeName;
            saveRoutes(rt);
            log(`[announce] updated route: ${prefix} → ${routeName}`);
          }
          const binding = loadBinding();
          if (binding?.ilinkUserId) {
            const currentDefault = rt.default || "(无)";
            const switchHint = currentDefault === prefix
              ? `已自动设为你的默认会话。直接发消息给我即可。`
              : `发 /use ${prefix} 切换为默认会话，或发 ${prefix} 消息 临时对话。\n当前默认: ${currentDefault}`;
            const msg = isNew
              ? `🔔 ${agentName} 已连接！\n\n${switchHint}`
              : `🔄 ${agentName} 已重新连接。\n\n${switchHint}`;
            client.sendText(binding.ilinkUserId, msg).catch((e) => {
              log(`announce notify failed: ${e.message}`);
            });
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

  // Dedup: prevent duplicate processing of the same message (iLink may fire multiple events)
  const _recentFingerprints = new Set<string>();
  function _isDuplicate(chatId: string, text: string): boolean {
    const fp = `${chatId}:${text}`;
    if (_recentFingerprints.has(fp)) return true;
    _recentFingerprints.add(fp);
    if (_recentFingerprints.size > 200) {
      const it = _recentFingerprints.values();
      for (let i = 0; i < 100; i++) _recentFingerprints.delete(it.next().value);
    }
    return false;
  }

  client.on("message", async (msg: InboundMessage) => {
    const text = (msg.text || "").trim();
    if (!text) return;

    if (_isDuplicate(msg.chatId, text)) return;
    log(`[微信] ${msg.chatId.slice(0, 12)}...: ${text.slice(0, 80)}`);

    // Start typing indicator (matches reference plugin behavior)
    client.startTyping(msg.chatId);

    // Reload routes (may have been updated)
    rt = loadRoutes();

    // System commands
    const sysReply = handleSystemCommand(text, msg.chatId, rt);
    if (sysReply !== null) {
      await client.sendText(msg.chatId, sysReply).catch(() => {});
      return;
    }

    // Check binding — auto-recover if possible
    let binding = loadBinding();
    if (!binding) {
      const s = client.getStatus();
      if (s.userId && wxOpenId) {
        saveBinding({ ilinkUserId: s.userId, wxOpenId, defaultRoute: rt.default, boundAt: new Date().toISOString() });
        binding = loadBinding();
        log(`auto-recovered binding: ${s.userId.slice(0, 12)}... → ${rt.default}`);
      }
    }
    if (!binding) {
      await client.sendText(msg.chatId, "请先扫码绑定。发送 /help 查看说明。").catch(() => {});
      return;
    }

    // Parse route prefix (Model C: default session + single override)
    let prefix = "";
    let body = text;
    let isOverride = false;
    const m = text.match(/^(\/\S+)\s+(.*)/);
    if (m) {
      const found = findRoute(m[1], rt);
      if (found) {
        prefix = found.prefix;
        body = m[2];
        isOverride = true;
      }
    }
    if (!prefix) {
      const session = getSession(msg.chatId);
      const found = findRoute(session.current, rt);
      prefix = found ? found.prefix : session.current;
      body = text;
    }

    const route = lookupRoute(prefix, rt);
    if (!route) {
      await client.sendText(msg.chatId,
        `会话 ${prefix} 不可用。用 /use /xxx 切换，或 /help 查看可用 Agent。`
      ).catch(() => {});
      return;
    }

    // Forward to Agent via OB — primary delivery path.
    // CC receives messages via Monitor watching agent.ts stdout.
    if (!obListener && !botObCreds) {
      await client.sendText(msg.chatId, "网关 OB 未就绪，请稍后重试。").catch(() => {});
      return;
    }

    try {
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
      // Reuse persistent OB listener for sending; fallback to temp instance
      if (obListener) {
        await obListener.send(route.openId, obMsg);
      } else {
        const oceanbus = await import("oceanbus");
        const ob = await oceanbus.createOceanBus({
          keyStore: { type: "memory" },
          identity: { agent_id: botObCreds!.agent_id, api_key: botObCreds!.api_key, openid: botObCreds!.openid },
        });
        await ob.send(route.openId, obMsg);
        await ob.destroy();
      }
      log(`[→OB] → ${route.name} (${route.openId.slice(0, 5)}...)`);
    } catch (e: any) {
      log(`OB send failed: ${e.message}`);
      await client.sendText(msg.chatId, `转发失败: ${e.message}`).catch(() => {});
    }
  });

  client.on("sessionExpired", async () => {
    log("session expired — user should re-login via MCP login tool");
  });

  client.on("qrRefresh", async ({ qrcodeUrl, qrAscii }) => {
    log(`QR refreshed: ${qrcodeUrl}`);
    log("QR code refreshed — user should re-scan via MCP login tool");
  });

  client.on("error", (err: unknown) => log(`client error: ${String(err)}`));

  // 7. MCP server
  const { server: mcpServer } = createMcpServer(client);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("MCP connected (login/status/logout/send/reply)");

  // 8. Start Bot
  let shuttingDown = false;
  function shutdown() { if (shuttingDown) return; shuttingDown = true; client.stop(); process.exit(0); }
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const accounts = client.listAccounts();
  let launched = false;
  for (const acct of accounts) {
    log(`trying account ${acct.slice(0, 8)}...`);
    if (await client.start(acct)) { launched = true; break; }
  }
  if (!launched) {
    log("no valid accounts, will prompt login via MCP status");
  } else {
    log(`gateway ready — ${Object.keys(rt.routes).length} routes, default: ${rt.default || "(none)"}`);
  }

  await new Promise(() => {});
}

main().catch((err) => { log(`fatal: ${String(err)}`); process.exit(1); });
