#!/usr/bin/env node
/**
 * CC Agent — OB message handler for WeChat Gateway
 *
 * Receives structured OB commands from wechat-cc Gateway,
 * auto-executes via claude spawn, and replies via OB.
 *
 * 用法:
 *   node cc-agent.cjs                  # 启动（自动检测 Gateway 配置）
 *   node cc-agent.cjs --name <name>    # 指定窗口名
 *   node cc-agent.cjs --no-auto-exec   # 禁用自动执行（只显示消息）
 *   node cc-agent.cjs --no-announce    # 不向 Gateway 发送 announce
 *   node cc-agent.cjs --wx <openid>    # 手动指定微信 OB OpenID
 *   node cc-agent.cjs --gateway <id>   # 手动指定 Gateway OB OpenID
 *   node cc-agent.cjs --data-dir <dir> # 指定 OB 身份目录
 */

const { createOceanBus, RosterService } = require('oceanbus');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config ────────────────────────────────────────────────────
function getArg(name) {
  const idx = process.argv.indexOf(name);
  return (idx >= 0 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : null;
}

// Auto-detect Gateway config from wechat-cc state files
const GW_STATE_DIR = path.join(os.homedir(), '.claude', 'channels', 'wechat-cc');
function loadGW(file) {
  try { return JSON.parse(fs.readFileSync(path.join(GW_STATE_DIR, file), 'utf-8')); } catch (_) { return null; }
}
const gwWxIdentity = loadGW('wx-identity.json');
const gwBotOb = loadGW('bot-ob.json');
const gwBinding = loadGW('binding.json');

const DATA_DIR = getArg('--data-dir') || path.join(__dirname, '.cc-data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const CURSOR_FILE = path.join(DATA_DIR, 'seq_cursor.json');
const AUTO_EXEC = !process.argv.includes('--no-auto-exec');
const NO_ANNOUNCE = process.argv.includes('--no-announce');
const WX_OPENID = getArg('--wx') || (gwWxIdentity?.openid || null);
const GATEWAY_OPENID = getArg('--gateway') || (gwBotOb?.openid || WX_OPENID);

// ── Main ──────────────────────────────────────────────────────
async function main() {
  // 1. Load or auto-register OB identity
  let creds;
  if (fs.existsSync(CRED_FILE)) {
    creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    if (!creds.agent_id || !creds.api_key) creds = null;
  }

  if (!creds) {
    console.log('🆔 首次运行，正在注册 OceanBus 身份...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const ob = await createOceanBus({ keyStore: { type: 'memory' } });
    try {
      const reg = await ob.createIdentity();
      const openid = await ob.getAddress();
      creds = { agent_id: reg.agent_id, api_key: reg.api_key, openid, source: 'cc-agent', created_at: new Date().toISOString() };
      fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
    } catch (e) {
      console.error('注册失败: ' + e.message);
      await ob.destroy();
      process.exit(1);
    }
    await ob.destroy();
    console.log('   身份已保存到: ' + CRED_FILE);
  }

  // Auto-name: --name flag > OpenID前4位
  const agentName = getArg('--name') || ('CC-' + creds.openid.slice(0, 4));

  const mode = AUTO_EXEC ? 'auto-exec' : 'display only';
  const wxIdDisplay = WX_OPENID ? WX_OPENID.slice(0, 4) : '(未检测到)';
  const agentIdDisplay = creds.openid.slice(0, 4);
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  窗口名:   ' + agentName.padEnd(24) + '║');
  console.log('║  本Agent:  ' + agentIdDisplay.padEnd(24) + '║');
  console.log('║  微信OB:   ' + wxIdDisplay.padEnd(24) + '║');
  console.log('║  模式:     ' + mode.padEnd(24) + '║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // Announce to Gateway if wxOpenId provided
  if (WX_OPENID && !NO_ANNOUNCE) {
    try {
      const obAnn = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
        mailbox: { cursorFilePath: CURSOR_FILE },
      });
      await obAnn.send(WX_OPENID, JSON.stringify({
        action: 'announce',
        meta: { agent_name: agentName, agent_openid: creds.openid, agent_type: 'claude-code' },
      }));
      await obAnn.destroy();
      const prefix = '/' + agentName.toLowerCase().replace(/\s+/g, '-');
      console.log('📡 已向微信 Gateway 发送 announce (OpenID: ' + creds.openid.slice(0,4) + '...)');
      console.log('   微信用户会收到连接通知（含使用说明）');
      console.log('   微信端发 ' + prefix + ' 消息 → 本窗口自动执行并回复');
      console.log('');
    } catch (e) {
      console.log('⚠️  announce 失败: ' + e.message);
      console.log('   Gateway 未运行？用 --no-announce 跳过');
      console.log('');
    }
  } else if (!WX_OPENID) {
    console.log('⚠️  未检测到微信 OB OpenID，跳过 announce');
    console.log('   手动指定: --wx <openid>');
    console.log('   或确保 ~/.claude/channels/wechat-cc/wx-identity.json 存在');
    console.log('');
  }

  // 2. Connect OB (use stable stored OpenID + dedicated cursor file)
  const ob = await createOceanBus({
    keyStore: { type: 'memory' },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
    mailbox: { cursorFilePath: CURSOR_FILE },
  });

  const roster = new RosterService();

  // 3. OB message handler
  ob.startListening(async (msg) => {
    if (msg.from_openid === creds.openid) return; // skip self

    // Resolve sender
    let contact = await roster.findByOpenId(msg.from_openid);
    if (!contact) {
      // Auto-add Gateway as contact
      try {
        await roster.add({ name: 'WeChat-Gateway', openIds: [msg.from_openid] });
        contact = await roster.findByOpenId(msg.from_openid);
        console.log('[Roster] 自动添加: WeChat-Gateway');
      } catch (_) {}
    }
    const fromName = contact?.name || 'Gateway';

    // Parse structured message
    const raw = msg.content || '';
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = { action: 'command', text: raw }; }

    const action = parsed.action || 'command';
    const text = parsed.text || raw;
    const meta = parsed.meta || {};

    const time = new Date(msg.created_at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });

    // Display
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log('── ' + fromName + ' · ' + time + ' ──');
    const mode = meta.is_override ? '[临时]' : '[会话]';
    console.log(`  ${mode} ${meta.route_prefix || '?'} → ${agentName}`);
    console.log('  ' + text.slice(0, 120));
    console.log('');

    // Auto-exec mode
    if (AUTO_EXEC && text.trim()) {
      console.log('[auto-exec] 开始执行: ' + text.slice(0, 80));
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn('claude', ['-p', text, '--dangerously-skip-permissions'], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const timer = setTimeout(() => { child.kill(); reject(new Error('执行超时 (5 分钟)')); }, 300000);
          let out = '', err = '';
          child.stdout.on('data', d => out += d);
          child.stderr.on('data', d => err += d);
          child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && out.trim()) resolve(out.trim());
            else reject(new Error(err.trim() || `exit ${code}`));
          });
          child.on('error', e => { clearTimeout(timer); reject(e); });
        });

        console.log('[auto-exec] 完成');

        // Reply via OB to Gateway
        const replyTo = GATEWAY_OPENID || msg.from_openid;
        if (replyTo.length < 20) {
          // Need valid OpenID
          console.error('[auto-exec] 无法回复: Gateway OpenID 未知。请用 --gateway 指定。');
          return;
        }

        const reply = JSON.stringify({
          action: 'reply',
          text: result,
          meta: {
            to_wx_user: meta.from_wx_user || '',
            reply_to: meta.message_id || '',
            agent_name: agentName,
          },
        });

        await ob.send(replyTo, reply);
        console.log('[→GW] 已回复 Gateway');
      } catch (e) {
        console.error('[auto-exec] 失败: ' + e.message);
        // Send error back
        const replyTo = GATEWAY_OPENID || msg.from_openid;
        if (replyTo.length > 20) {
          const errorReply = JSON.stringify({
            action: 'reply',
            text: '任务执行失败: ' + e.message,
            meta: {
              to_wx_user: meta.from_wx_user || '',
              reply_to: meta.message_id || '',
              agent_name: agentName,
            },
          });
          try { await ob.send(replyTo, errorReply); } catch (_) {}
        }
      }
    }
  });

  // 4. Send hello to WeChat via Gateway
  const ilinkUser = gwBinding?.ilinkUserId || '';
  if (GATEWAY_OPENID && ilinkUser) {
    try {
      const prefix = '/' + agentName.toLowerCase().replace(/\s+/g, '-');
      const hello = JSON.stringify({
        action: 'reply',
        text: `🔔${agentName}：我上线了，请用 ${prefix} 给我发消息`,
        meta: {
          to_wx_user: ilinkUser,
          agent_name: agentName,
        },
      });
      await ob.send(GATEWAY_OPENID, hello);
      console.log('👋 已向微信发送上线通知');
      console.log('');
    } catch (e) {
      console.log('⚠️  上线通知发送失败: ' + e.message);
      console.log('');
    }
  }

  // Keep alive
  await new Promise(() => {});
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
