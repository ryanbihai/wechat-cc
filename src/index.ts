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
const PAIRING_FILE = path.join(STATE_DIR, "pairing.json");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadPairing(): { ilinkUserId?: string; ccOpenId?: string; ccAgentId?: string } {
  try {
    if (fs.existsSync(PAIRING_FILE)) return JSON.parse(fs.readFileSync(PAIRING_FILE, "utf-8"));
  } catch (_) {}
  return {};
}

function savePairing(data: Record<string, string>) {
  ensureStateDir();
  fs.writeFileSync(PAIRING_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── OB L0 helpers ─────────────────────────────────────────────
const CC_CRED_FILE = path.join(os.homedir(), ".oceanbus-chat", "credentials.json");
const BOT_OB_FILE = path.join(STATE_DIR, "bot-ob.json");

function loadCcObCreds() {
  try {
    if (fs.existsSync(CC_CRED_FILE)) return JSON.parse(fs.readFileSync(CC_CRED_FILE, "utf-8"));
  } catch (_) {}
  return null;
}

function loadBotObCreds() {
  try {
    if (fs.existsSync(BOT_OB_FILE)) return JSON.parse(fs.readFileSync(BOT_OB_FILE, "utf-8"));
  } catch (_) {}
  return null;
}

function saveBotObCreds(data: unknown) {
  ensureStateDir();
  fs.writeFileSync(BOT_OB_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log("wechat-cc channel starting...");

  // 0. Detect conflict with weixin-claude-code
  const CONFLICT_STATE_DIR = path.join(os.homedir(), ".claude", "channels", "wechat");
  if (fs.existsSync(CONFLICT_STATE_DIR)) {
    const conflictAccounts = path.join(CONFLICT_STATE_DIR, "accounts");
    if (fs.existsSync(conflictAccounts) && fs.readdirSync(conflictAccounts).length > 0) {
      log("WARNING: weixin-claude-code accounts detected. Both plugins will compete for WeChat messages.");
      log("  To avoid conflicts, disable one plugin: /plugin disable weixin-claude-code@dcatfly-plugins");
      log("  Or: /plugin disable wechat-cc@oceanbus-plugins");
    }
  }

  // 1. CC OB identity (load existing or create)
  let ccCreds = loadCcObCreds();
  let ccOpenId: string;
  if (ccCreds?.openid) {
    ccOpenId = ccCreds.openid;
    log(`CC OB identity: ${ccOpenId.slice(0, 5)}...`);
  } else {
    log("CC OB identity not found — will be created on first OB use");
    ccOpenId = "";
  }

  // 2. Bot OB identity (load or create)
  let botObCreds = loadBotObCreds();
  if (!botObCreds?.openid) {
    log("Registering Bot OB identity...");
    const oceanbus = await import("oceanbus");
    const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
    try {
      const reg = await ob.createIdentity();
      const openid = await ob.getAddress();
      botObCreds = {
        agent_id: reg.agent_id,
        api_key: reg.api_key,
        openid,
        created_at: new Date().toISOString(),
      };
      saveBotObCreds(botObCreds);
      log(`Bot OB identity created: ${openid.slice(0, 5)}...`);
    } catch (e: any) {
      log(`Bot OB registration failed: ${e.message}`);
      await ob.destroy();
      // Continue without OB — direct iLink ↔ MCP mode
    }
    await ob.destroy();
  }
  const botOpenId: string = botObCreds?.openid || "";

  // In-memory pairings (synced with disk), for OB reply routing
  const pairings: Record<string, { ccOpenId: string; ccName: string }> = {};
  (function loadPairingsIntoMemory() {
    const p = loadPairing();
    if (p.ilinkUserId && p.ccOpenId) {
      pairings[p.ilinkUserId] = { ccOpenId: p.ccOpenId, ccName: "CC" };
      log(`loaded pairing: ${p.ilinkUserId.slice(0, 12)}... ↔ ${p.ccOpenId.slice(0, 5)}...`);
    }
  })();

  // 3. WeixinBotClient
  const client = new WeixinBotClient({
    stateDir: path.join(STATE_DIR, "wechat"),
    tempDir: path.join(os.tmpdir(), "wechat-cc"),
    clientIdPrefix: "wechat-cc",
  });

  await client.cleanupTempMedia().catch((err: unknown) =>
    log(`temp cleanup failed: ${String(err)}`)
  );

  // 4. MCP Server
  // Permission reply regex
  const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)(?:\s+([a-km-z]{5}))?\s*$/i;
  let pendingPermissionRequestId: string | undefined;

  const server = new Server(
    { name: "wechat-cc", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions:
        '微信消息以 <channel source="wechat" chat_id="..." sender="..."> 格式到达。' +
        '文本内容在标签体内。用 reply 工具回复，传入 chat_id。',
    }
  );

  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "回复微信消息",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string", description: "目标用户 ID（从 <channel> 标签的 chat_id 属性获取）" },
            text: { type: "string", description: "回复文本内容" },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "login",
        description: "发起微信扫码登录，返回二维码 URL",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "status",
        description: "查询当前微信连接状态和 OB 绑定信息",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "logout",
        description: "登出微信，清除凭证并停止消息接收",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments as Record<string, string>) || {};

    switch (name) {
      case "reply": {
        const chatId = args.chat_id;
        const text = args.text;
        if (!chatId || !text) {
          return { content: [{ type: "text" as const, text: "缺少 chat_id 或 text 参数" }] };
        }
        client.stopTyping(chatId);
        clearPendingPermissionRequestId();
        try {
          await client.sendText(chatId, text);
          // Also send via OB L0 if Bot identity exists
          if (botOpenId && ccOpenId) {
            try {
              const oceanbus = await import("oceanbus");
              const ob = await oceanbus.createOceanBus({
                keyStore: { type: "memory" },
                identity: { agent_id: ccCreds.agent_id, api_key: ccCreds.api_key, openid: ccOpenId },
              });
              await ob.send(botOpenId, `reply:${chatId}:${text}`);
              await ob.destroy();
            } catch (_) {}
          }
          return { content: [{ type: "text" as const, text: "已发送" }] };
        } catch (err: any) {
          log(`reply failed: ${String(err)}`);
          return { content: [{ type: "text" as const, text: `发送失败: ${String(err)}` }] };
        }
      }
      case "login": {
        const result = await client.login();
        if (!result.qrcodeUrl) {
          return { content: [{ type: "text" as const, text: `登录失败: ${result.message}` }] };
        }
        const responseText = result.qrAscii
          ? `请用手机微信扫描以下二维码登录（如被折叠请按 ctrl+o 展开）:\n\n${result.qrAscii}\n\n链接: ${result.qrcodeUrl}\n\n${result.message}`
          : `${result.message}\n\n链接: ${result.qrcodeUrl}`;
        return { content: [{ type: "text" as const, text: responseText }] };
      }
      case "status": {
        const s = client.getStatus();
        const pairing = loadPairing();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              wechat_connected: s.connected,
              wechat_user: s.userId || "(未登录)",
              cc_openid: ccOpenId ? ccOpenId.slice(0, 5) + "..." : "(未注册)",
              bot_openid: botOpenId ? botOpenId.slice(0, 5) + "..." : "(未注册)",
              paired: !!pairing.ilinkUserId,
              paired_user: pairing.ilinkUserId || "",
              session_paused: s.sessionPaused,
            }),
          }],
        };
      }
      case "logout": {
        const s = client.getStatus();
        if (!s.accountId) {
          return { content: [{ type: "text" as const, text: "当前没有已登录的微信账号" }] };
        }
        await client.logout();
        // Clear pairing
        try { fs.unlinkSync(PAIRING_FILE); } catch (_) {}
        log(`logout: ${s.accountId}`);
        return { content: [{ type: "text" as const, text: `已登出微信账号 ${s.accountId}，凭证和配对已清除。` }] };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  // Permission forwarding
  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const status = client.getStatus();
    if (!status.userId) return;
    const text =
      `Claude 请求执行 ${params.tool_name}:\n${params.description}\n` +
      (params.input_preview ? `输入: ${params.input_preview}\n` : "") +
      `\n回复 yes / no`;
    try {
      await client.sendText(status.userId, text, { raw: true });
      pendingPermissionRequestId = params.request_id;
    } catch (err) {
      log(`permission_request forward failed: ${String(err)}`);
    }
  });

  function clearPendingPermissionRequestId() {
    pendingPermissionRequestId = undefined;
  }

  // 5. Event bindings
  client.on("loginSuccess", (accountId: string) => {
    log(`login success: ${accountId}`);
    // Auto-bind: the user who just scanned is paired with CC
    const status = client.getStatus();
    if (status.userId && ccOpenId) {
      const pairing = loadPairing();
      pairing.ilinkUserId = status.userId;
      pairing.ccOpenId = ccOpenId;
      if (ccCreds) pairing.ccAgentId = ccCreds.agent_id;
      savePairing(pairing);
      // Sync in-memory pairings for OB reply routing
      pairings[status.userId] = { ccOpenId, ccName: "CC" };
      log(`auto-paired: ${status.userId.slice(0, 12)}... ↔ ${ccOpenId.slice(0, 5)}...`);
      // Send welcome message
      client.sendText(status.userId,
        `✅ 已连接 CC (OpenID: ${ccOpenId.slice(0, 5)}...)\n\n现在可以直接给我发指令了。`
      ).catch(() => {});
    }
  });

  client.on("message", async (msg: InboundMessage) => {
    // Permission reply interception
    const permMatch = PERMISSION_REPLY_RE.exec(msg.text);
    if (permMatch) {
      const requestId = permMatch[2]?.toLowerCase() ?? pendingPermissionRequestId;
      if (requestId) {
        await server.notification({
          method: "notifications/claude/channel/permission" as any,
          params: {
            request_id: requestId,
            behavior: permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny",
          },
        });
        clearPendingPermissionRequestId();
        return;
      }
    }

    // Normal message → typing + push to CC
    client.startTyping(msg.chatId);

    // Try OB L0 path first (store-and-forward)
    if (botOpenId && ccOpenId) {
      try {
        const oceanbus = await import("oceanbus");
        const ob = await oceanbus.createOceanBus({
          keyStore: { type: "memory" },
          identity: { agent_id: botObCreds.agent_id, api_key: botObCreds.api_key, openid: botOpenId },
        });
        const routeHeader = `from wechat ${msg.chatId.slice(0, 5)}\nto cc ${ccOpenId.slice(0, 5)}\n`;
        await ob.send(ccOpenId, routeHeader + msg.text);
        await ob.destroy();
        log(`[→OB] → CC (${ccOpenId.slice(0, 5)}...)`);
      } catch (e: any) {
        log(`OB send failed: ${e.message}`);
      }
    }

    // Also push via MCP notification (direct, real-time)
    const meta: Record<string, string> = {
      chat_id: msg.chatId,
      sender: msg.chatId,
    };
    if (msg.mediaPath) {
      meta.media_path = msg.mediaPath;
      meta.media_type = msg.mediaType || "";
    }

    let content = msg.text;
    if (msg.mediaPath) {
      const mt = msg.mediaType ?? "";
      const label = mt.startsWith("image") ? "图片"
        : mt.startsWith("video") ? "视频"
        : mt.startsWith("audio") ? "语音"
        : "媒体消息";
      content = `[${label}: ${path.basename(msg.mediaPath)}]`;
    }

    // Channel notification: CC expects <channel source="wechat" chat_id="..." sender="...">content</channel>
    const channelContent = `<channel source="wechat" chat_id="${msg.chatId}" sender="${msg.chatId}">${content}</channel>`;
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: channelContent, meta },
      });
      log(`[MCP] notification sent for ${msg.chatId.slice(0, 12)}...`);
    } catch (e: any) {
      log(`[MCP] notification failed: ${e.message}`);
    }
  });

  client.on("sessionExpired", async (accountId: string) => {
    log(`session expired: ${accountId}`);
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: "微信连接已断开（session 过期），请调用 login 工具重新扫码连接。",
        meta: { type: "session_expired" },
      },
    });
  });

  client.on("qrRefresh", async ({ qrcodeUrl, qrAscii }) => {
    log(`QR refreshed: ${qrcodeUrl}`);
    const text = qrAscii
      ? `二维码已过期，新二维码（如被折叠请按 ctrl+o 展开）:\n\n${qrAscii}\n链接: ${qrcodeUrl}`
      : `二维码已过期，请使用新链接扫码: ${qrcodeUrl}`;
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: text, meta: { type: "qr_refresh" } },
      });
    } catch (err) {
      log(`failed to send QR refresh: ${String(err)}`);
    }
  });

  client.on("error", (err: unknown) => {
    log(`client error: ${String(err)}`);
  });

  // 5b. OB listener: receives CC replies and forwards to WeChat
  if (botOpenId && botObCreds) {
    try {
      const oceanbus = await import("oceanbus");
      const obListener = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: botObCreds.agent_id, api_key: botObCreds.api_key, openid: botOpenId },
      });
      obListener.startListening(async (msg: any) => {
        if (msg.from_openid === botOpenId) return;
        const content: string = msg.content || "";
        const wxUid = Object.keys(pairings).find(
          uid => pairings[uid].ccOpenId === msg.from_openid
        );
        if (wxUid) {
          log(`[←OB] ${msg.from_openid.slice(0, 5)}... → WeChat ${wxUid.slice(0, 12)}...`);
          try {
            const body = content.replace(/^from .+\nto .+\n/m, "").trim();
            await client.sendText(wxUid, `🔔 CC 回复：\n\n${body}`);
          } catch (e: any) {
            log(`OB→WeChat forward failed: ${e.message}`);
          }
        }
      });
      log("OB reply listener started");
    } catch (e: any) {
      log(`OB listener start failed: ${e.message}`);
    }
  }

  // 6. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected via stdio");

  // 7. Start Bot (restore existing session or prompt login)
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down...");
    client.stop();
    process.exit(0);
  }
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const accounts = client.listAccounts();
  const launched = accounts.length > 0 && (await client.start(accounts[0]));
  if (!launched) {
    log("no accounts, sending login prompt");
    setTimeout(async () => {
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content:
              "微信 Channel 已启动，但尚未登录。\n" +
              "请调用 login 工具扫码连接微信。\n" +
              "扫码成功后自动绑定 CC OpenID，无需手动输入 pair 命令。",
            meta: { type: "login_required" },
          },
        });
      } catch (err) {
        log(`failed to send login prompt: ${String(err)}`);
      }
    }, 1000);
  }
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  process.exit(1);
});
