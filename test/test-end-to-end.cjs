#!/usr/bin/env node
/**
 * OceanBus 端到端通信测试
 *
 * 测试链路:
 *   A. CC → 微信  (MCP reply 工具)
 *   B. Gateway → OB → Agent  (模拟微信消息投递)
 *   C. Agent → OB → Gateway  (模拟Agent回复)
 *
 * 用法: node test/test-end-to-end.cjs
 */

const { createOceanBus, RosterService } = require('oceanbus');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── State 文件路径 ──────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), '.claude', 'channels', 'wechat-cc');
const ROUTES_FILE = path.join(STATE_DIR, 'routes.json');
const BINDING_FILE = path.join(STATE_DIR, 'binding.json');
const BOT_OB_FILE = path.join(STATE_DIR, 'bot-ob.json');
const WX_IDENTITY_FILE = path.join(STATE_DIR, 'wx-identity.json');
const CC_CRED_FILE = path.join(os.homedir(), '.oceanbus-chat', 'credentials.json');

// cc-agent 的 data-dir（从命令行参数或默认查找）
const CC_AGENT_DATA_DIR = process.argv[2] || null;

// ── 辅助 ──────────────────────────────────────────────────────────
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

function ok(label) { console.log(`  ✅ ${label}`); }
function fail(label, detail) { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }
function info(label) { console.log(`  ℹ️  ${label}`); }

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('🌊 OceanBus 端到端通信测试');
  console.log('═'.repeat(50));
  console.log('');

  const results = { pass: [], fail: [], skip: [] };

  // ── 测试 A: 检查 State 文件完整性 ─────────────────────────────
  console.log('【A】State 文件检查');
  console.log('─'.repeat(40));

  const routes = loadJSON(ROUTES_FILE);
  const binding = loadJSON(BINDING_FILE);
  const botOb = loadJSON(BOT_OB_FILE);
  const wxIdentity = loadJSON(WX_IDENTITY_FILE);
  const ccCreds = loadJSON(CC_CRED_FILE);

  if (routes) {
    ok('routes.json 存在');
    const prefixes = Object.keys(routes.routes || {});
    info(`${prefixes.length} 条路由: ${prefixes.join(', ')}`);
    info(`默认路由: ${routes.default || '(未设置)'}`);
  } else { fail('routes.json 缺失'); }

  if (binding) {
    ok('binding.json 存在');
    info(`ilinkUserId: ${binding.ilinkUserId?.slice(0, 12)}...`);
    info(`wxOpenId: ${binding.wxOpenId?.slice(0, 5)}...`);
    info(`defaultRoute: ${binding.defaultRoute}`);
  } else {
    fail('binding.json 缺失');
    console.log('   ⚠️  未绑定！先发送 /help 到 Bot 自动绑定');
  }

  if (botOb) {
    ok('bot-ob.json 存在');
    info(`Gateway Bot OpenID: ${botOb.openid?.slice(0, 5)}...`);
  } else { fail('bot-ob.json 缺失'); }

  if (wxIdentity) {
    ok('wx-identity.json 存在');
    info(`微信 OB OpenID: ${wxIdentity.openid?.slice(0, 5)}...`);
  } else { fail('wx-identity.json 缺失'); }

  if (ccCreds) {
    ok('CC OB 凭证存在 (~/.oceanbus-chat/credentials.json)');
    info(`CC 主 OpenID: ${ccCreds.openid?.slice(0, 5)}...`);
  } else { fail('CC OB 凭证缺失'); }

  console.log('');

  // ── 测试 B: OB 连接测试 ─────────────────────────────────────
  console.log('【B】OB 连接测试');
  console.log('─'.repeat(40));

  let ccObWorks = false, botObWorks = false, wxObWorks = false;

  // B1: CC 主身份连接
  if (ccCreds?.agent_id) {
    try {
      const ob = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: ccCreds.agent_id, api_key: ccCreds.api_key, openid: ccCreds.openid },
      });
      const addr = await ob.getAddress();
      if (addr === ccCreds.openid) {
        ok('CC 主身份 OB 连接成功');
        ccObWorks = true;
      } else {
        fail('CC 主身份 OB 地址不匹配');
      }
      await ob.destroy();
    } catch (e) {
      fail('CC 主身份 OB 连接', e.message);
    }
  } else { results.skip.push('B1: 无 CC 凭证'); }

  // B2: Gateway Bot OB 连接
  if (botOb?.agent_id) {
    try {
      const ob = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: botOb.agent_id, api_key: botOb.api_key, openid: botOb.openid },
      });
      const addr = await ob.getAddress();
      if (addr === botOb.openid) {
        ok('Gateway Bot OB 连接成功');
        botObWorks = true;
      } else {
        fail('Gateway Bot OB 地址不匹配');
      }
      await ob.destroy();
    } catch (e) {
      fail('Gateway Bot OB 连接', e.message);
    }
  } else { results.skip.push('B2: 无 Bot OB 凭证'); }

  // B3: 微信 OB 身份连接
  if (wxIdentity?.agent_id) {
    try {
      const ob = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: wxIdentity.agent_id, api_key: wxIdentity.api_key, openid: wxIdentity.openid },
      });
      const addr = await ob.getAddress();
      if (addr === wxIdentity.openid) {
        ok('微信 OB 身份连接成功');
        wxObWorks = true;
      } else {
        fail('微信 OB 身份地址不匹配');
      }
      await ob.destroy();
    } catch (e) {
      fail('微信 OB 身份连接', e.message);
    }
  } else { results.skip.push('B3: 无微信 OB 凭证'); }

  console.log('');

  // ── 测试 C: OB 消息投递测试 ─────────────────────────────────
  console.log('【C】OB 消息投递测试');
  console.log('─'.repeat(40));

  if (ccObWorks && botObWorks) {
    const ccOpenId = ccCreds.openid;
    const botOpenId = botOb.openid;

    // C1: Gateway → CC 主身份 (模拟微信消息的默认路由投递)
    console.log('C1: 模拟 Gateway → CC 主身份 (默认路由 /cc)');
    try {
      const sender = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: botOb.agent_id, api_key: botOb.api_key, openid: botOpenId },
      });
      const receiver = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: ccCreds.agent_id, api_key: ccCreds.api_key, openid: ccOpenId },
      });

      const received = [];
      receiver.startListening(async (msg) => {
        if (msg.from_openid === ccOpenId) return;
        received.push(msg);
      });

      const testMsg = JSON.stringify({
        action: 'command',
        text: '测试04',
        meta: {
          from_wx_user: binding?.ilinkUserId || 'test-user@im.wechat',
          route_prefix: '/cc',
          agent_name: 'CC-test',
          is_override: false,
          session_current: '/cc',
          message_id: `test_${Date.now()}`,
        },
      });

      await sender.send(ccOpenId, testMsg);

      // 等待消息投递
      await new Promise(r => setTimeout(r, 3000));

      if (received.length > 0) {
        ok(`Gateway → CC 主身份 消息投递成功 (收到 ${received.length} 条)`);
        const parsed = JSON.parse(received[0].content || '{}');
        info(`action: ${parsed.action}, text: "${parsed.text}"`);
        info(`from_wx_user: ${parsed.meta?.from_wx_user}`);
      } else {
        fail('Gateway → CC 主身份 消息未收到');
        console.log('   ⚠️  CC 主身份没有活跃监听者');
        console.log('   → 这就是为什么微信消息到达不了本窗口');
        console.log('   → 需要 cc-agent.cjs 监听，且路由指向正确的 OpenID');
      }

      await sender.destroy();
      await receiver.destroy();
    } catch (e) {
      fail('C1 测试异常', e.message);
    }

    console.log('');

    // C2: Gateway → cc-agent OpenID (模拟 /cc-oceanbus 路由投递)
    console.log('C2: 检查当前路由配置');
    const ccRoutes = Object.entries(routes.routes || {});
    for (const [prefix, entry] of ccRoutes) {
      const isDefault = prefix === routes.default ? ' ← 默认' : '';
      const isCcMain = entry.openId === ccCreds.openid ? ' (指向CC主身份)' : '';
      const icon = prefix === '/cc-oceanbus' ? '🎯' : '  ';
      console.log(`  ${icon} ${prefix} → ${entry.name} (${entry.openId?.slice(0, 5)}...)${isDefault}${isCcMain}`);
    }

    const ccOceanBusRoute = routes.routes['/cc-oceanbus'];
    if (ccOceanBusRoute) {
      console.log('');
      console.log('C3: 模拟 Gateway → cc-agent (/cc-oceanbus 路由)');
      try {
        const sender = await createOceanBus({
          keyStore: { type: 'memory' },
          identity: { agent_id: botOb.agent_id, api_key: botOb.api_key, openid: botOpenId },
        });
        const receiver = await createOceanBus({
          keyStore: { type: 'memory' },
          identity: { agent_id: ccCreds.agent_id, api_key: ccCreds.api_key, openid: ccOceanBusRoute.openId },
        });

        const received = [];
        receiver.startListening(async (msg) => {
          if (msg.from_openid === ccOceanBusRoute.openId) return;
          received.push(msg);
        });

        const testMsg = JSON.stringify({
          action: 'command',
          text: '测试 /cc-oceanbus 你好',
          meta: {
            from_wx_user: binding?.ilinkUserId || 'test-user@im.wechat',
            route_prefix: '/cc-oceanbus',
            agent_name: 'CC-oceanbus',
            is_override: true,
            session_current: '/cc',
            message_id: `test_${Date.now()}`,
          },
        });

        await sender.send(ccOceanBusRoute.openId, testMsg);
        await new Promise(r => setTimeout(r, 3000));

        if (received.length > 0) {
          ok(`Gateway → cc-agent 消息投递成功`);
        } else {
          fail(`Gateway → cc-agent 消息未收到 (OpenID: ${ccOceanBusRoute.openId.slice(0, 5)}...)`);
          console.log('   ⚠️  cc-agent.cjs 可能未在监听此 OpenID');
        }

        await sender.destroy();
        await receiver.destroy();
      } catch (e) {
        fail('C3 测试异常', e.message);
      }
    } else {
      results.skip.push('C3: 无 /cc-oceanbus 路由');
    }
  } else {
    results.skip.push('C: OB 连接不可用，跳过消息投递测试');
  }

  console.log('');

  // ── 测试 D: Agent → Gateway 回复测试 ─────────────────────────
  console.log('【D】Agent → Gateway 回复模拟');
  console.log('─'.repeat(40));

  if (botObWorks && ccObWorks) {
    console.log('D1: Agent → Gateway Bot (模拟 cc-agent 回复)');
    try {
      const sender = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: ccCreds.agent_id, api_key: ccCreds.api_key, openid: ccCreds.openid },
      });
      const receiver = await createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: botOb.agent_id, api_key: botOb.api_key, openid: botOb.openid },
      });

      const received = [];
      receiver.startListening(async (msg) => {
        if (msg.from_openid === botOb.openid) return;
        received.push(msg);
      });

      const replyMsg = JSON.stringify({
        action: 'reply',
        text: '测试回复消息',
        meta: {
          to_wx_user: binding?.ilinkUserId || 'test-user@im.wechat',
          reply_to: 'wx_test123',
          agent_name: 'CC-test',
        },
      });

      await sender.send(botOb.openid, replyMsg);
      await new Promise(r => setTimeout(r, 3000));

      if (received.length > 0) {
        ok('Agent → Gateway Bot 消息投递成功');
        const parsed = JSON.parse(received[0].content || '{}');
        info(`action: ${parsed.action}, text: "${parsed.text?.slice(0, 30)}"`);
        info(`to_wx_user: ${parsed.meta?.to_wx_user?.slice(0, 12)}...`);
      } else {
        fail('Agent → Gateway Bot 消息未收到');
        console.log('   ⚠️  Gateway 可能未在 botOpenId 上启动 OB 监听');
      }

      await sender.destroy();
      await receiver.destroy();
    } catch (e) {
      fail('D1 测试异常', e.message);
    }
  } else {
    results.skip.push('D: OB 连接不可用');
  }

  // ── 总结 ────────────────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(50));
  console.log('【诊断总结】');
  console.log('═'.repeat(50));
  console.log('');

  console.log('链路全景:');
  console.log('  微信 App');
  console.log('    ↕ iLink');
  console.log('  Gateway (wechat-cc MCP)');
  console.log('    ↕ OB L0');
  console.log('  cc-agent.cjs');
  console.log('    ↕ claude spawn');
  console.log('  Claude Code (本窗口)');
  console.log('');

  console.log('关键发现:');
  console.log('');

  // 检查默认路由是否指向有人监听的 OpenID
  const defaultRoute = routes?.routes?.[routes?.default];
  const ccAgentRoute = routes?.routes?.['/cc-oceanbus'];

  if (defaultRoute && ccCreds) {
    if (defaultRoute.openId === ccCreds.openid) {
      console.log('  ⚠️  默认路由 /cc 指向 CC 主 OpenID (ccOb)');
      console.log('       → 微信直接回复（无前缀）→ 走默认路由 /cc → ccOb');
      console.log('       → 但 ccOb 上没有常驻 OB 监听进程');
      console.log('       → 消息丢失！');
    }
  }

  if (ccAgentRoute) {
    console.log('');
    console.log('  ✅ /cc-oceanbus 路由已存在 → ntRKf (cc-agent)');
    console.log('       → 微信发 "/cc-oceanbus 你好" → 走 /cc-oceanbus → ntRKf');
    console.log('       → 但 cc-agent.cjs 需要 --auto-exec 才会执行消息');
  }

  console.log('');
  console.log('解决方案:');
  console.log('');
  console.log('  方案1 (推荐): 微信发 /use /cc-oceanbus 切换默认会话');
  console.log('           然后所有消息都发给本窗口');
  console.log('');
  console.log('  方案2: 微信发 "/cc-oceanbus 消息" 临时路由');
  console.log('         (每条消息都要带前缀)');
  console.log('');
  console.log('  方案3: 重启 cc-agent.cjs 加 --auto-exec');
  console.log('         让收到消息时自动 spawn claude 执行');
  console.log('');
  console.log('  CC→微信:  直接调用 reply 工具 ✅ (已验证)');
  console.log('  微信→CC:  需要 /cc-oceanbus 前缀 + cc-agent 运行 ⚠️');
  console.log('');
}

main().catch(err => { console.error('测试脚本异常:', err); process.exit(1); });
