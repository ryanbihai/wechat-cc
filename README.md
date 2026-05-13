# 🌊 wechat-cc

**微信扫码操控 Claude Code。** 一条命令，全自动完成。

[![GitHub](https://img.shields.io/badge/github-ryanbihai%2Fwechat--cc-blue)](https://github.com/ryanbihai/wechat-cc)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.1-brightgreen)](https://github.com/ryanbihai/wechat-cc/releases)

---

## 开始使用

把下面这条命令发给 Claude Code 即可：

```bash
if [ -d wechat-cc ]; then cd wechat-cc && git pull; else git clone https://github.com/ryanbihai/wechat-cc.git && cd wechat-cc; fi && npm install oceanbus@latest weixin-bot-plugin@latest && node standalone.cjs
```

Claude Code 会自动：安装依赖 → 注册身份 → 显示二维码。微信扫码 → 完成。

---

## 邀请朋友

把上面那条命令发给他们就行。**你不需要做任何事。**

---

## 连接已有 Gateway（高级）

如果你在微信 `/myid` 拿到了 wxOpenId，想让 Agent 自动注册到网关：

```bash
node standalone.cjs --wx WvuQ6QI...
```

Agent 启动时自动向网关 announce，微信端无需手动 `/addroute`。

---

## 多窗口

不同项目窗口用不同数据目录：

```bash
# 窗口 A
node standalone.cjs --data-dir ~/project-a/.wechat-cc

# 窗口 B
node standalone.cjs --data-dir ~/project-b/.wechat-cc
```

---

## Gateway 模式（高级）

如果需要统一路由管理多个 Agent：

```
/plugin marketplace add ryanbihai/claude-plugins
/plugin install wechat-cc@oceanbus-plugins
```

支持前缀路由、多 Agent 分发、会话管理。详见 [PRD.md](./PRD.md)。

---

## 架构

```
微信 ⇄ iLink ⇄ wechat-cc ⇄ spawn claude
              │
              └── OceanBus L0 身份（可选，用于多 Agent）
```

| 层 | 技术 |
|----|------|
| 微信通信 | `weixin-bot-plugin` |
| P2P 身份 | `oceanbus` (L0) |
| 执行引擎 | `spawn claude` |

---

## 相关项目

- [weixin-bot-plugin](https://github.com/Dcatfly/weixin_bot_plugin) — 微信 Bot SDK（灵感来源）
- [OceanBus](https://github.com/ryanbihai/oceanbus-monorepo) — P2P Agent 通信网络

---

MIT · [OceanBus](https://github.com/ryanbihai)
