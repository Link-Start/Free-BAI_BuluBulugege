# Reverse Engineering Report: chat.bankofai.io

## 1. 任务摘要

**目标**: 逆向分析 chat.bankofai.io 前端代码，重点关注钱包登录/注册流程。
**来源**: Next.js 静态资源包（138 个 JS chunks + HAR 网络请求）
**应用身份**: 基于 LobeChat 开源项目白标改造的 AI 聊天平台，品牌名为 AINFT
**防护等级**: T1（变量重命名 + 压缩，无混淆/无VMP/无WASM）
**分析重点**: 钱包登录/注册流程

---

## 2. 核心发现（≤5项）

1. **双链钱包登录架构（TRON + EVM）**：支持 7 种钱包（TronLink/MetaMask/OKX/Binance/TokenPocket/Trust/Bybit），TRON 和 EVM 各自有独立的 adapter 类和签名流程。
2. **SIWE-like 签名认证**：签名消息由前端构造，TRON 链使用完整 SIWE 格式（hostname + address + chainId + expiry + nonce），EVM 链使用简化格式（account + chainId + nonce）。timestamp 从服务端 `basicConfig.getBasicConfig` 获取。
3. **AES 加密密钥硬编码**：`1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=` 用于加密 claim token，模块 `166472`。
4. **双数据库模式**：根据 `NEXT_PUBLIC_CLIENT_DB` 环境变量切换 PGLite（客户端 SQLite）和 PostgreSQL 后端。PGLite 模式下 userId 固定为 `DEFAULT_LOBE_CHAT_USER`，claimSignupBonus 抛出 "Not implemented"。
5. **新用户注册赠送 100,000 credits**，通过 tRPC `user.claimSignupBonus` 领取，需携带 AES 加密 token + 钱包签名。`creditsPerDollar = 1,000,000`。

---

## 3. 证据表

| # | 发现 | 证据锚点 | 置信度 |
|---|------|----------|--------|
| 1 | TronAdapter 类实现 TRON 签名 | `26057-8322daa47a4f566f.js` (class b, signMessage/signMessageWallet) | HIGH |
| 2 | EVM 钱包 MetaMask/Binance/Trust | `26057-8322daa47a4f566f.js` (class _ extends v.Y3 for MetaMask, class I for TrustWallet) | HIGH |
| 3 | TRON 签名消息格式 (SIWE) | `26057-8322daa47a4f566f.js` (function c = buildSignMessage, module 28386) | HIGH |
| 4 | EVM 签名消息格式 (简化) | `26057-8322daa47a4f566f.js` (module 968943, function b) | HIGH |
| 5 | AES 加密密钥硬编码 | `27386-8fe193aece9ded00.js` (module 166472) | HIGH |
| 6 | claimSignupBonus tRPC 调用 | `51557-aa187ffd640a8e02.js` (class A, claimSignupBonus method) | HIGH |
| 7 | 支持的钱包列表 (TRON + EVM) | `26057-8322daa47a4f566f.js` (M/TRON, N/EVM, D5/Ro adapter 映射, module 971660) | HIGH |
| 8 | basicConfig 获取服务端 timestamp | `trpc/lambda/basicConfig.getBasicConfig` HAR 返回 `{"timestamp":1776004848635}` | HIGH |
| 9 | 支付地址配置 | `basicConfig.getBasicConfig` HAR (TRON + 各 EVM 链支付地址) | HIGH |
| 10 | creditsPerDollar = 1,000,000 | `basicConfig.getBasicConfig` HAR | HIGH |
| 11 | 双数据库模式 (PGLite/PostgreSQL) | `51557-aa187ffd640a8e02.js` (`"pglite"===env.NEXT_PUBLIC_CLIENT_DB?new S:new o`) | HIGH |
| 12 | 用户状态管理 (Zustand store) | `51557-aa187ffd640a8e02.js` (module 551557, openLogin/logout/setWalletInfo) | HIGH |
| 13 | 登录态 localStorage 存储 | `26057-8322daa47a4f566f.js` (module 96867, localStorage keys) | HIGH |
| 14 | TronGrid API Key 硬编码 | `26057-8322daa47a4f566f.js` (module 539924, tronGridKey) | HIGH |
| 15 | TronScan API Key 硬编码 | `26057-8322daa47a4f566f.js` (module 539924, tronScanKey) | HIGH |

---

## 4. 调用链

### 4.1 钱包登录流程（详细版）

```
用户点击钱包登录
  │
  ├─ 选择链类型: TRON 或 EVM
  │
  ├─ TRON 链 (TronLink/Binance/Bybit/OKX/TokenPocket)
  │   ├─ 检测钱包: window.tronLink / window.bybitWallet / 其他
  │   ├─ 桌面端: tronLink.request({method: "tron_requestAccounts"})
  │   ├─ 移动端: tronlinkoutside:// deep link + 轮询 callback
  │   ├─ 获取地址后 → signMessageWallet(adapter, provider)
  │   │   ├─ buildSignMessage(address, chainIdHex)
  │   │   │   ├─ timestamp: 从 basicConfig.getBasicConfig.query() 获取
  │   │   │   ├─ expiry: timestamp + 86400000ms (24h)
  │   │   │   ├─ nonce: crypto.randomUUID()
  │   │   │   └─ hostname: window.location.hostname
  │   │   └─ adapter.signMessage(message)
  │   │       ├─ Bybit: tronWebObj.trx.sign(sha3(hexMessage))
  │   │       ├─ OKX mobile: signMessage(message)
  │   │       └─ 默认: adapter.signMessage(message)
  │   └─ 签名结果: {result, signMsg, type}
  │
  ├─ EVM 链 (MetaMask/Binance/Trust)
  │   ├─ 检测钱包: window.ethereumProviders.MetaMask / TrustWallet
  │   ├─ connect() → eth_requestAccounts
  │   ├─ switchChain("0x1") (Ethereum mainnet)
  │   ├─ buildSignMessage(address, chainIdHex) — 简化格式
  │   └─ personal_sign / eth_sign
  │
  └─ 统一提交: openLogin(address, signature, chain, providerType, signMsg, version)
      │
      ├─ Zustand store: setWalletInfo({address, chain, providerType})
      ├─ localStorage 存储: isLogin, login, address, login_chain, wallet
      ├─ 新用户: claimSignupBonus({address, chain, encryptedToken, message, signature, type:"wallet", version:"3"})
      └─ 老用户: 恢复 session
```

### 4.2 签名消息构造（精确还原）

**TRON 链签名消息** (`26057-8322daa47a4f566f.js`, module 28386):
```
${hostname} wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiryISO}
Nonce: ${randomUUID}
```

**EVM 链签名消息** (`26057-8322daa47a4f566f.js`, module 968943):
```
Account:
${address}
Chain ID: ${chainIdHex}
Nonce: ${randomUUID}
```

注意：TRON 使用完整 SIWE 格式（含 hostname + expiry），EVM 使用简化格式（仅 account + chainId + nonce）。

### 4.3 支持的钱包列表

**TRON 钱包** (M 数组, module 971660):
| 类型 | 显示名 | Adapter 来源 |
|------|--------|-------------|
| tronlink | TronLink | `d.Fq` (内置) |
| binance | Binance Wallet | `r.$` (外部) |
| metamask | MetaMask | `s.x` (外部) |
| okx | OKX Wallet | `l.L` (外部) |
| tokenpocket | TokenPocket | `c.D` (外部) |

**EVM 钱包** (N 数组, module 971660):
| 类型 | 显示名 | Adapter 来源 |
|------|--------|-------------|
| binance | Binance Wallet | `i.u` (外部) |
| metamask | MetaMask | `_` class (内置) |
| trust | Trust Wallet | `I` class (内置) |

**Adapter 映射** (D5 对象, module 971660):
```javascript
D5 = {
  binance: { adapter: r.$, tronWebObj: window?.tronWeb },
  bybit: { adapter: o.p, tronWebObj: window?.bybitWallet?.tronLink?.tronWeb },
  metamask: { adapter: s.x, tronWebObj: window?.otherTronWeb },
  okx: { adapter: l.L },
  tokenpocket: { adapter: c.D },
  tronlink: { adapter: d.Fq },
  trust: { adapter: g.K }
}
```

### 4.4 新用户代币领取流程

```
登录后检测 hasClaimedSignupBonus() === false
  │
  ├─ 弹窗展示: "领取 100,000 credits"
  │
  ├─ OAuth 路径:
  │   encryptedToken = AES.encrypt("${provider}|${Date.now()}", KEY)
  │   claimSignupBonus({ encryptedToken, type: "oauth:google" })
  │
  └─ 钱包路径:
      encryptedToken = AES.encrypt("${chain}|${Date.now()}", KEY)
      claimSignupBonus({
        address, chain, encryptedToken,
        message, signature,
        type: "wallet", version: "3"
      })
  │
  └─ 成功后:
      refreshPoints()
      hasClaimedSignupBonus() 重新查询
      通知 dismissal + toast "claim.success"
      埋点: points_claim (login_channel, login_type, wallet_name)
```

### 4.5 双数据库架构

```
环境变量: NEXT_PUBLIC_CLIENT_DB

├─ "pglite" → 客户端 SQLite (PGLite)
│   ├─ userId = "DEFAULT_LOBE_CHAT_USER"
│   ├─ 用户表: users (id, avatar, settings, preference)
│   ├─ 本地 IndexedDB: LOBE_CHAT_DB (v11)
│   └─ claimSignupBonus/hasClaimedSignupBonus → throw Error("Not implemented")
│
└─ 其他值 → PostgreSQL 后端
    ├─ userId = 动态生成
    ├─ 通过 tRPC 调用后端 API
    └─ claimSignupBonus/hasClaimedSignupBonus → v.du.user.*.query/mutate
```

### 4.6 localStorage 存储的登录态

```javascript
// module 96867, 登录成功后存储的 keys
const loginKeys = [
  "isLogin", "login", "address", "login_chain", "wallet",
  "AINFT_RECHARGE_CHAIN", "LAST_DAPP_PATH"
];

// 不随 signOut 清除的 keys (持久化)
const persistentKeys = [
  "i18nextLng", "promptStr", "last_login_wallet", "LAST_DAPP_PATH"
];
```

---

## 5. 风险与影响

1. **AES 密钥泄露**: 前端硬编码的 AES key `1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=` 可被任何人提取，用于伪造 `encryptedToken` 领取新用户奖励。
2. **TronGrid API Key 泄露**: `00cef2d1-7b90-48f8-9782-e72e3a368bd4` 硬编码在前端（module 539924）。
3. **TronScan API Key 泄露**: `5984598e-3ed9-47c1-8d83-d3efe4064501` 硬编码在前端（module 539924）。
4. **TronWeb PrivateKey 泄露**: `baf5545a222c611acba4a580a0de9584b325e1ba421ec82700841822ec88db0a` 硬编码在前端（module 539924）。
5. **重复领取风险**: 如果后端仅依赖 `encryptedToken` 验证而非链上签名唯一性，攻击者可批量注册新钱包重复领取。
6. **PGLite 模式无认证**: 客户端模式下 `claimSignupBonus` 和 `hasClaimedSignupBonus` 均未实现，可能存在本地数据篡改风险。

---

## 6. FACTS / INFERENCES / UNKNOWNS

### FACTS (已交叉验证)
- 应用基于 LobeChat 开源项目白标改造，品牌名为 AINFT
- 支持 TRON + EVM 双链钱包登录（7 种钱包）
- TRON 签名消息使用完整 SIWE 格式，EVM 使用简化格式
- 签名 timestamp 从服务端 `basicConfig.getBasicConfig` 获取
- 新用户赠送 100,000 credits（creditsPerDollar = 1,000,000）
- AES 加密密钥硬编码在前端 JS 中（module 166472）
- 双数据库模式：PGLite（客户端）和 PostgreSQL（服务端）
- PGLite 模式下 userId 固定为 `DEFAULT_LOBE_CHAT_USER`
- 登录态存储在 localStorage（isLogin, address, login_chain, wallet）
- 通信使用 tRPC 协议
- IndexedDB 数据库 LOBE_CHAT_DB 版本 11

### INFERENCES (合理推断)
- 服务端（PostgreSQL 模式）通过 tRPC 验证钱包签名后创建 session
- 后端可能使用 JWT 或 session cookie 维持登录态
- `encryptedToken` 主要用于防重放攻击（含 timestamp），但密钥泄露后防护失效
- PGLite 模式用于离线/本地开发，PostgreSQL 模式用于生产环境
- 支付地址用于充值功能（recharge），各链有独立的收款地址

### UNKNOWNS (未确认)
- 服务端签名验证的具体实现（需要服务端代码或网络抓包）
- tRPC 服务端的完整路由定义（需要服务端代码）
- 是否有 IP/设备指纹防刷机制
- credits 与法币的实际兑换比例
- 生产环境使用的是 PGLite 还是 PostgreSQL 模式
- 登录请求是否需要额外的 auth header 或 cookie

---

## 7. 下一步行动

1. **网络抓包验证**: 使用 Chrome DevTools 捕获实际登录请求和 claim 请求的 HTTP 流量，确认 tRPC 端点 URL 和请求格式。
2. **重放测试**: 使用 `web_replay.js` 脚本验证 AES 加密 token 生成和 claim 流程。
3. **服务端代码获取**: 如果可能，获取 Next.js 服务端 bundle 以分析签名验证逻辑。
4. **批量领取 PoC**: 验证是否可以通过批量生成新钱包地址重复领取 credits。

---

## 8. 交付物清单

| 文件 | 说明 |
|------|------|
| `Reverse_Report_CN.md` | 本中文逆向分析报告 |
| `web_replay.js` | 可执行的 Node.js 脚本，包含签名算法还原和请求重放 |
| `poc_claim_bonus.js` | 新用户代币领取 PoC 脚本 |
| `poc_batch_claim.js` | 批量领取 PoC 脚本 |

---

## 9. 复现步骤

### 钱包登录复现

```bash
# 1. 安装依赖
npm install ethers tronweb crypto-js

# 2. 运行重放脚本
node web_replay.js
```

### 新用户代币领取复现

```javascript
// 使用 web_replay.js 中的 encrypt 函数
const CryptoJS = require('crypto-js');
const KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const encryptedToken = CryptoJS.AES.encrypt('tron|' + Date.now(), KEY).toString();
// POST 到 tRPC claimSignupBonus 端点
```

### 签名消息构造

```javascript
// TRON 链
const message = `${hostname} wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiryISO}
Nonce: ${nonce}`;

// EVM 链
const message = `Account:
${address}
Chain ID: ${chainIdHex}
Nonce: ${nonce}`;
```
