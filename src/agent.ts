/**
 * wechat-cc Agent — OB listener for CC (Path B)
 *
 * Runs under Claude Code Monitor (persistent mode).
 * Receives WeChat messages via OB from Gateway, prints structured JSON to stdout.
 *
 * Usage:
 *   node dist/agent.js                        # auto-detect config
 *   node dist/agent.js --name <name>          # custom agent name
 *   node dist/agent.js --no-announce          # skip Gateway announce
 *   node dist/agent.js --data-dir <dir>       # custom OB identity dir
 *   node dist/agent.js --gateway <openid>     # manual Gateway OB OpenID
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ── Config ────────────────────────────────────────────────────
function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const GW_STATE_DIR = path.join(os.homedir(), ".claude", "channels", "wechat-cc");
function loadGW(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(path.join(GW_STATE_DIR, file), "utf-8")); } catch (_) { return null; }
}

const gwWxIdentity = loadGW("wx-identity.json") as { openid?: string } | null;
const gwBotOb = loadGW("bot-ob.json") as { openid?: string } | null;
const gwBinding = loadGW("binding.json") as { ilinkUserId?: string } | null;
const gwRoutes = loadGW("routes.json") as { default?: string; routes?: Record<string, unknown> } | null;

const HOME_OB_CHAT = path.join(os.homedir(), ".oceanbus-chat");
const DEFAULT_DATA_DIR = path.join(__dirname, "..", ".cc-data");
function resolveDataDir(): string {
  const arg = getArg("--data-dir");
  if (arg) return arg;
  // Prefer shared CC OB identity to avoid identity mismatch with routes.json
  if (fs.existsSync(path.join(HOME_OB_CHAT, "credentials.json"))) return HOME_OB_CHAT;
  return DEFAULT_DATA_DIR;
}
const DATA_DIR = resolveDataDir();
const CRED_FILE = path.join(DATA_DIR, "credentials.json");
const CURSOR_FILE = path.join(DATA_DIR, "cursor.json");
const NO_ANNOUNCE = process.argv.includes("--no-announce");
const WX_OPENID = getArg("--wx")
  || (gwWxIdentity?.openid ?? null);
const GATEWAY_OPENID = getArg("--gateway")
  || (gwBotOb?.openid ?? WX_OPENID);

// ── Output ─────────────────────────────────────────────────────
function emit(evt: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(evt) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[agent] ${msg}\n`);
}

// ── Auto-naming ─────────────────────────────────────────────────
// Converts a directory name to a route-safe slug. Chinese chars preserved.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s._]+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
}

function resolveAgentName(): string {
  // 1. Manual override always wins
  const manual = getArg("--name");
  if (manual) return manual;

  // 2. Auto-detect from working directory
  const dirName = path.basename(process.cwd());
  const slug = slugify(dirName);
  if (slug && slug.length > 0) {
    // 3. Check for route collisions
    const rt = loadGW("routes.json") as { routes?: Record<string, { openId?: string }> } | null;
    const prefix = "/" + slug;
    if (rt?.routes?.[prefix]) {
      let suffix = 2;
      while (rt.routes[prefix + "-" + suffix]) suffix++;
      return slug + "-" + suffix;
    }
    return slug;
  }

  // 4. Fallback (empty or unreadable dir name) — caller fills with openid
  return "";
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  // 1. Load or auto-register OB identity
  let creds: { agent_id: string; api_key: string; openid: string } | null = null;
  if (fs.existsSync(CRED_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
      if (raw.agent_id && raw.api_key && raw.openid) creds = raw;
    } catch (_) { /* corrupt — re-register below */ }
  }

  if (!creds) {
    log("first run — registering OceanBus identity...");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const oceanbus = await import("oceanbus");
    const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
    try {
      const reg = await ob.createIdentity();
      const openid = await ob.getAddress();
      creds = { agent_id: reg.agent_id, api_key: reg.api_key, openid };
      fs.writeFileSync(CRED_FILE, JSON.stringify({
        ...creds, source: "wechat-cc-agent", created_at: new Date().toISOString(),
      }, null, 2));
    } catch (e: any) { log(`registration failed: ${e.message}`); await ob.destroy(); process.exit(1); }
    await ob.destroy();
  }

  const agentName = resolveAgentName() || ("cc-" + creds.openid.slice(0, 4));
  const routePrefix = "/" + agentName.toLowerCase().replace(/\s+/g, '-');
  const defaultRoute = gwRoutes?.default || "/cc";

  log(`agent: ${agentName}  openid: ${creds.openid.slice(0, 5)}...  route: ${routePrefix}  (default: ${defaultRoute})`);

  // 2. Announce to Gateway
  if (WX_OPENID && !NO_ANNOUNCE) {
    try {
      const oceanbus = await import("oceanbus");
      const obAnn = await oceanbus.createOceanBus({
        keyStore: { type: "memory" },
        identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
      });
      await obAnn.send(WX_OPENID, JSON.stringify({
        action: "announce",
        meta: { agent_name: agentName, agent_openid: creds.openid, agent_type: "claude-code" },
      }));
      await obAnn.destroy();
      log(`announced to Gateway (wxOpenId: ${WX_OPENID.slice(0, 5)}...)`);
    } catch (e: any) {
      log(`announce failed (Gateway not running?): ${e.message}`);
    }
  } else if (!WX_OPENID) {
    log("wxOpenId not found — skipping announce (Gateway auto-detection)");
  }

  // 3. Start OB listener
  log("starting OB listener...");

  const oceanbus = await import("oceanbus");
  const ob = await oceanbus.createOceanBus({
    keyStore: { type: "memory" },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
    mailbox: { cursorFilePath: CURSOR_FILE },
  } as any);

  ob.startListening(async (msg: any) => {
    if (msg.from_openid === creds!.openid) return; // skip self

    const content: string = msg.content || "";
    let parsed: any;
    try { parsed = JSON.parse(content); } catch (_) { parsed = null; }

    if (!parsed || parsed.action !== "command") return; // only handle commands

    const text: string = parsed.text || "";
    const meta: Record<string, unknown> = parsed.meta || {};
    const time: string = new Date(msg.created_at || Date.now())
      .toLocaleTimeString("zh-CN", { hour12: false });

    // Detect media (fallback: plain text with media markers)
    let mediaPath: string = "";
    let mediaType: string = "";
    const mediaMatch = text.match(/^\[([^\]]+):\s*(.+)\]$/);
    if (mediaMatch) {
      mediaPath = mediaMatch[2];
      mediaType = mediaMatch[1];
    }

    emit({
      type: "wechat_msg",
      chat_id: meta.from_wx_user || "",
      sender: meta.from_wx_user || "",
      text: text,
      route: meta.route_prefix || defaultRoute,
      agent: agentName,
      time,
      ...(mediaPath ? { media_path: mediaPath, media_type: mediaType } : {}),
    });
  });

  // 4. Send startup notification if Gateway has bound user
  const ilinkUser = gwBinding?.ilinkUserId || "";
  const helloRecipient = WX_OPENID || GATEWAY_OPENID; // prefer wxOB path (verified working)
  if (helloRecipient && ilinkUser) {
    try {
      const hello = JSON.stringify({
        action: "reply",
        text: `🔔${agentName}：我上线了，请用 ${routePrefix} 给我发消息`,
        meta: { to_wx_user: ilinkUser, agent_name: agentName },
      });
      await ob.send(helloRecipient, hello);
      log(`startup notification sent to WeChat user`);
    } catch (e: any) {
      log(`startup notification failed: ${e.message}`);
    }
  }

  // Keep alive
  log("ready — waiting for messages...");
  await new Promise(() => {});
}

main().catch((err: any) => {
  process.stderr.write(`[agent] fatal: ${String(err)}\n`);
  process.exit(1);
});
