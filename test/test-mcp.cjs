#!/usr/bin/env node
/**
 * MCP Channel 测试脚本
 *
 * 启动 wechat-cc MCP Server，通过 stdio 发送 MCP JSON-RPC 消息，
 * 验证 initialize / tools/list / notifications 全流程。
 *
 * 用法: node test/test-mcp.js
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const DIST = path.join(PLUGIN_DIR, 'dist', 'index.js');

let msgId = 0;
let server;
let rl;

function send(method, params) {
  const id = ++msgId;
  const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  process.stdout.write(`\n→ ${method}\n`);
  server.stdin.write(req + '\n');
  return id;
}

function notify(method, params) {
  const req = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`\n→ [notif] ${method}\n`);
  server.stdin.write(req + '\n');
}

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  server.kill();
  process.exit(1);
}

function ok(msg) {
  console.log(`   ✅ ${msg}`);
}

async function main() {
  console.log('🧪 MCP Channel 测试');
  console.log(`   Server: ${DIST}\n`);

  // 1. Start server
  server = spawn('bun', [DIST], {
    cwd: PLUGIN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_DIR },
  });

  rl = readline.createInterface({ input: server.stdout });

  const responses = [];
  let notificationCount = 0;
  const notifications = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        responses.push(msg);
      } else {
        // Notification
        notificationCount++;
        notifications.push(msg);
        console.log(`\n📨 Notification: ${msg.method}`);
        if (msg.params) {
          console.log(`   params: ${JSON.stringify(msg.params).slice(0, 200)}`);
        }
      }
    } catch (_) { /* ignore non-JSON stderr interleaving */ }
  });

  // Collect stderr for debugging
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 2000));

  if (server.exitCode !== null) {
    console.error('stderr:', stderr);
    fail(`Server exited with code ${server.exitCode}`);
  }
  ok('Server process started');

  // 2. Initialize MCP
  send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { 'claude/channel': {} } },
    clientInfo: { name: 'test', version: '1.0' },
  });

  const initResp = await waitForResponse(5000);
  if (!initResp || initResp.error) {
    console.error('stderr:', stderr);
    fail(`Initialize failed: ${JSON.stringify(initResp?.error)}`);
  }
  ok(`Initialize: server=${initResp.result?.serverInfo?.name} v${initResp.result?.serverInfo?.version}`);
  ok(`Capabilities: ${JSON.stringify(initResp.result?.capabilities?.experimental)}`);

  // Send initialized notification (required by MCP protocol)
  notify('notifications/initialized', {});

  // 3. List tools
  send('tools/list', {});
  const toolsResp = await waitForResponse(5000);
  if (!toolsResp || toolsResp.error) fail(`tools/list failed: ${JSON.stringify(toolsResp?.error)}`);

  const tools = toolsResp.result?.tools || [];
  const toolNames = tools.map(t => t.name).join(', ');
  ok(`Tools (${tools.length}): ${toolNames}`);

  if (!toolNames.includes('login')) fail('Missing login tool');
  if (!toolNames.includes('reply')) fail('Missing reply tool');
  if (!toolNames.includes('status')) fail('Missing status tool');
  if (!toolNames.includes('logout')) fail('Missing logout tool');

  // 4. Call status
  send('tools/call', { name: 'status', arguments: {} });
  const statusResp = await waitForResponse(5000);
  if (!statusResp || statusResp.error) fail(`status failed: ${JSON.stringify(statusResp?.error)}`);
  const statusText = statusResp.result?.content?.[0]?.text || '';
  const status = JSON.parse(statusText);
  console.log(`   Status: wechat=${status.wechat_connected}, paired=${status.paired}, cc=${status.cc_openid}, bot=${status.bot_openid}`);

  // 5. Check for login prompt notification
  // Server should send a notification when no accounts exist
  console.log(`\n📊 Notifications received: ${notificationCount}`);
  if (notificationCount > 0) {
    ok('Server sent notification(s) — MCP channel push working');
    for (const n of notifications) {
      if (n.params?.meta?.type === 'login_required') {
        ok('Login prompt notification received');
      }
      console.log(`   method=${n.method} type=${n.params?.meta?.type || 'none'}`);
    }
  } else {
    console.log('   ⚠️  No notifications yet (may have existing session)');
  }

  // 6. Summary
  console.log('\n📋 测试结果:');
  console.log('   ✅ Server starts');
  console.log('   ✅ MCP initialize');
  console.log('   ✅ Tools registered (login, reply, status, logout)');
  console.log('   ✅ Status returns valid JSON');
  if (notificationCount > 0) {
    console.log('   ✅ MCP notifications working');
  }
  console.log('   ⚠️  login/reply 需要真实微信扫码，无法自动化测试');

  if (stderr.includes('ERROR') || stderr.includes('fatal')) {
    console.log('\n⚠️  stderr 有错误:');
    console.log(stderr.split('\n').filter(l => l.includes('ERROR') || l.includes('fatal')).join('\n'));
  }

  console.log('\n✅ 基础 MCP 协议测试通过');
  server.kill();
  process.exit(0);

  function waitForResponse(timeoutMs) {
    return new Promise((resolve) => {
      const startLen = responses.length;
      const check = () => {
        if (responses.length > startLen) {
          resolve(responses[responses.length - 1]);
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 100);
      };
      const startTime = Date.now();
      check();
    });
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
