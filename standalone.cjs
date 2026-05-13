#!/usr/bin/env node
/**
 * wechat-cc standalone — 个人微信操控 CC
 *
 * 一条命令，全部自动完成：
 *   注册 OB 身份 → 微信扫码 → 自动绑定 → 接收消息 → spawn claude → 回复微信
 *
 * 不需要管理员。不需要 Gateway。不需要 OpenID 交换。
 *
 * 用法: node standalone.cjs
 *       node standalone.cjs --data-dir <dir>   (多窗口)
 */

const { createOceanBus, RosterService } = require('oceanbus');
const { WeixinBotClient } = require('weixin-bot-plugin');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────
function getArg(name) {
  const idx = process.argv.indexOf(name);
  return (idx >= 0 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : null;
}

const DATA_DIR = getArg('--data-dir') || path.join(os.homedir(), '.wechat-cc-standalone');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const STATE_DIR = path.join(DATA_DIR, 'wechat-state');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('🌊 wechat-cc standalone');
  console.log('');

  // 1. OB identity (auto-register)
  let creds;
  if (fs.existsSync(CRED_FILE)) {
    creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    if (!creds.agent_id || !creds.api_key) creds = null;
  }
  if (!creds) {
    console.log('🆔 正在注册 OceanBus 身份...');
    const ob = await createOceanBus({ keyStore: { type: 'memory' } });
    const reg = await ob.createIdentity();
    const openid = await ob.getAddress();
    creds = { agent_id: reg.agent_id, api_key: reg.api_key, openid, source: 'wechat-cc-standalone', created_at: new Date().toISOString() };
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
    await ob.destroy();
    console.log('   身份已保存');
  }

  const agentName = getArg('--name') || ('CC-' + creds.openid.slice(0, 4));
  console.log('   名称:    ' + agentName);
  console.log('   OpenID:  ' + creds.openid.slice(0, 5) + '...');
  console.log('');

  // 2. WeixinBotClient
  const client = new WeixinBotClient({
    stateDir: STATE_DIR,
    tempDir: path.join(os.tmpdir(), 'wechat-cc-standalone'),
    clientIdPrefix: 'wechat-cc-standalone',
  });

  // 3. WeChat login (QR code)
  const accounts = client.listAccounts();
  let loggedIn = false;
  if (accounts.length > 0) {
    loggedIn = await client.start(accounts[0]);
    if (loggedIn) {
      console.log('✅ 微信会话已恢复');
    }
  }

  if (!loggedIn) {
    console.log('📱 正在获取登录二维码...');
    const result = await client.login();
    if (!result.qrcodeUrl) {
      console.error('❌ 获取二维码失败: ' + result.message);
      process.exit(1);
    }
    console.log('');
    console.log('   请用手机微信扫描以下二维码（如被折叠请按 ctrl+o 展开）:');
    console.log('');
    if (result.qrAscii) console.log(result.qrAscii);
    console.log('   链接: ' + result.qrcodeUrl);
    console.log('');
    console.log('   等待扫码...');
  }

  // 4. Event: login success → send welcome
  client.on('loginSuccess', (accountId) => {
    const s = client.getStatus();
    if (s.userId) {
      client.sendText(s.userId,
        `🎉 欢迎来到 wechat-cc！\n\n` +
        `✅ 已绑定 ${agentName}\n` +
        `📍 OpenID: ${creds.openid.slice(0, 5)}...\n\n` +
        `现在可以直接给我发指令，我会自动执行并回复。\n` +
        `例如：帮我看看项目里有几个文件`
      ).catch(() => {});
    }
  });

  // 5. Event: message → spawn claude → reply
  client.on('message', async (msg) => {
    const text = (msg.text || '').trim();
    if (!text) return;
    console.log('[微信] ' + text.slice(0, 80));

    client.startTyping(msg.chatId);

    // Spawn claude
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

      console.log('[完成]');
      await client.sendText(msg.chatId, `🔔 ${agentName} 回复：\n\n${result}`);
      client.stopTyping(msg.chatId);
    } catch (e) {
      console.error('[失败] ' + e.message);
      await client.sendText(msg.chatId, `❌ 执行失败: ${e.message}`);
      client.stopTyping(msg.chatId);
    }
  });

  client.on('error', (err) => console.error('[错误] ' + String(err)));
  client.on('sessionExpired', () => console.log('[会话过期] 请重新扫码'));

  // Keep alive
  console.log('✅ 就绪！在微信给我发消息吧。按 Ctrl+C 停止。');
  await new Promise(() => {});
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
