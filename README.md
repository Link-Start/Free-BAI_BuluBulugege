# BankOfAI Pool — Reverse Engineering & Automated API Key Farm

Reverse engineering of [chat.bankofai.io](https://chat.bankofai.io) (a LobeChat white-label AI platform branded as "AINFT") with automated registration pipeline and API key pool management.

---

## Table of Contents

- [Project Overview](#project-overview)
- [How It Works — Registration Principle](#how-it-works--registration-principle)
- [Architecture](#architecture)
- [Base Chain Economics](#base-chain-economics)
- [Configuration Guide](#configuration-guide)
- [Quick Start](#quick-start)
- [Dashboard Features](#dashboard-features)
- [API Proxy Usage](#api-proxy-usage)
- [Reports](#reports)
- [Disclaimer](#disclaimer)

---

## Project Overview

BankOfAI is a LobeChat-based AI platform that gives new users **500,000 credits** (≈ $0.50) upon wallet registration. This project:

1. **Reverses** their frontend authentication flow (SIWE-like wallet signatures, AES token encryption, tRPC calls)
2. **Automates** mass wallet registration → claim → API key generation
3. **Pools** hundreds of API keys behind a unified OpenAI-compatible proxy endpoint
4. **Routes** requests through LiteLLM to various models (GPT-5.4, Gemini 3.1 Pro, GLM-5, etc.)

---

## How It Works — Registration Principle

Each account is created through a 6-step automated flow:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Registration Pipeline                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Generate Wallet     ethers.Wallet.createRandom()                │
│         │               → new EVM address + private key              │
│         ▼                                                            │
│  2. Fund on Base L2     Funder wallet sends 0.00000000001 ETH       │
│         │               (10M wei dust) to pass their balance check   │
│         ▼                                                            │
│  3. Sign Login Msg      Construct SIWE-like message:                │
│         │               "Welcome to BANK OF AI !                     │
│         │                chat.bankofai.io wants to sign in with...   │
│         │                Chain ID: 0x1 / Expiration / Nonce"         │
│         │               → wallet.signMessage(msg)                    │
│         ▼                                                            │
│  4. next-auth Login     GET /api/auth/csrf → csrfToken              │
│         │               POST /api/auth/callback/metamask             │
│         │               → session-token cookie returned              │
│         ▼                                                            │
│  5. Claim Credits       Sign a DIFFERENT claim message:             │
│         │               "BANK OF AI welcome gift-claim               │
│         │                Account: 0x... / Chain ID: 0x1 / Nonce"     │
│         │               Forge AES token with hardcoded key           │
│         │               POST /trpc/lambda/user.claimSignupBonus      │
│         │               → 500,000 credits granted                    │
│         ▼                                                            │
│  6. Create API Key      POST /trpc/lambda/apiKey.createApiKey       │
│                         → sk-xxxxx returned, ready to use            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Technical Details

| Component | Detail |
|-----------|--------|
| **AES Key** | `1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=` (hardcoded in their frontend JS) |
| **Token Payload** | `AES.encrypt("BANK OF AI welcome gift-claim\|{timestamp}", KEY)` |
| **Login Signature Format** | SIWE-style with hostname, address, chainId, expiration, nonce |
| **Claim Signature Format** | Different message: "BANK OF AI welcome gift-claim\nAccount:\n..." |
| **Auth Header (for chat)** | XOR encode `{accessCode, userId}` with key `"LobeHub · LobeHub"` → base64 |
| **Anti-Bot** | IP-based rate limiting on `/user.claimSignupBonus` (1 claim per IP) |
| **Balance Check** | Server verifies wallet has on-chain activity before allowing claim |

### Why Base Chain Dust?

BankOfAI added an anti-sybil check: the wallet must have at least one on-chain transaction on **Base L2** before `claimSignupBonus` succeeds. Sending a trivial amount (10M wei ≈ $0.0000000001) from a funded wallet satisfies this check.

---

## Architecture

```
bankofai-pool_new/
│
├── web_reverse_chat_bankofai/       # Reverse engineering & standalone scripts
│   ├── Reverse_Report_CN.md         # Full RE report (wallet login, dual-chain, DBs)
│   ├── Premium_Bypass_Report_CN.md  # Premium model bypass analysis
│   ├── auto_sign_claim.js           # Single/batch auto registration
│   ├── batch_base.js                # Batch with Base L2 dust funding
│   ├── batch_proxy.js               # Batch with rotating proxy
│   ├── premium_bypass.js            # 3 methods to access premium models
│   ├── check_balance.js             # Check credit balances of existing keys
│   ├── web_replay.js                # Request replay toolkit
│   └── test_*.js                    # Various test/debug scripts
│
└── web_dashboard/                   # Next.js management dashboard
    ├── app/                         # UI: pool status, accounts, relay control, playground
    │   └── api/                     # API routes: register, alloc, proxy, relay, autofill
    ├── lib/
    │   ├── constants.ts             # All config (reads from env vars)
    │   └── services/
    │       ├── BankOfAIService.ts   # Core: 2-phase registration (login → claim)
    │       ├── BaseFunder.ts        # Base L2 dust sender (nonce-serialized)
    │       ├── RelayRegistrar.ts    # Chain relay: fund N seeds → each does H hops
    │       ├── AutoFillWorker.ts    # Daemon: keeps pool at target size
    │       ├── StickyProxyPool.ts   # IP pool manager (1 claim per IP)
    │       ├── ProxyPoolService.ts  # Proxy extraction from Kookeey/CloudBypass
    │       └── QuotaService.ts      # Balance checker
    ├── prisma/schema.prisma         # SQLite: accounts, usage_logs, settings
    ├── scripts/
    │   ├── batch_relay.mjs          # CLI chain-relay script
    │   ├── test_relay_chain.mjs     # Single-chain relay test
    │   └── run-autofill.mjs         # Standalone autofill runner
    └── litellm/config.yaml          # LiteLLM proxy config for multi-model routing
```

---

## Base Chain Economics

### Cost Per Account

| Item | Cost | Notes |
|------|------|-------|
| Dust transfer (funder → new wallet) | ~0.000000157 ETH gas | 21000 gas × ~7.5 gwei Base L2 |
| Dust amount sent | 0.00000000001 ETH | 10M wei (trivial) |
| **Total per account** | **~$0.0000004** | At ETH=$2500 |

### Relay Mode (Chain Hops)

The relay mode reuses ETH across accounts:

```
Funder → Seed wallet (0.00002 ETH)
           ├── Hop 1: claim + create key → relay remaining balance to →
           ├── Hop 2: claim + create key → relay remaining balance to →
           └── Hop 3: claim + create key (balance exhausted)
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| Seed amount | 0.00002 ETH ($0.05) | Enough for 3 hops with gas buffer |
| Hops per chain | 3 | Keys produced per seed |
| Chains per batch | 100 | Parallel chains |
| **Effective cost/key** | **~$0.017** | Seed ÷ hops + funder gas |

### Production Rate

| Mode | Throughput | Notes |
|------|-----------|-------|
| Direct (auto_sign_claim.js) | ~3-5 keys/min | Single thread, no proxy rotation |
| Batch (batch_base.js) | ~30-50 keys/min | 3 concurrent, rotating proxy |
| Relay (RelayRegistrar) | ~100-300 keys/batch | 100 chains × 3 hops, 1 batch ≈ 60s |
| AutoFill daemon | Continuous | Maintains target pool size |

### Yield Per Account

| Metric | Value |
|--------|-------|
| Credits per registration | 500,000 |
| Credits per dollar | 1,000,000 |
| Dollar value per account | $0.50 |
| Claude Sonnet 4.6 tokens ($15/M output) | ~33,333 tokens |
| GPT-5.4 tokens ($60/M output) | ~8,333 tokens |
| Gemini 3.1 Pro tokens ($10/M output) | ~50,000 tokens |

---

## Configuration Guide

### 1. Environment File (`.env`)

Copy from template:

```bash
cp .env.example .env
```

### 2. Required Variables

```bash
# ─── Base Chain Funder ───
# Private key of a wallet with ETH on Base L2
# This wallet sends tiny dust to each new registration wallet
# Fund it with ~0.01 ETH for ~500 accounts
FUNDER_PRIVATE_KEY="0xYOUR_64_HEX_CHARS_PRIVATE_KEY"
BASE_RPC="https://mainnet.base.org"
DUST_ETH="0.00000000001"

# ─── Proxy Provider (pick one or both) ───

# Option A: Kookeey (recommended for batch)
# Rotating SOCKS5 proxies, account/password mode
# Sign up at kookeey.com, get your extract URL
KOOKEEY_EXTRACT_URL="https://www.kookeey.com/pickdynamicips?t=2&auth=pwd&format=4&n=100&p=socks5&gate=global&g=global&r=10&type=txt&sign=YOUR_SIGN&accessid=YOUR_ID&upf=1,5&dl="
KOOKEEY_PROTOCOL="socks5"

# Option B: CloudBypass (sticky sessions)
CLOUDBYPASS_HOST="gw.cloudbypass.com"
CLOUDBYPASS_PORT="1288"
CLOUDBYPASS_USER="your_user_id"
CLOUDBYPASS_PASS="your_password"
```

### 3. Optional Variables

```bash
# Dashboard database (SQLite by default)
DATABASE_URL="file:./dev.db"

# LiteLLM master key (for the /api/proxy endpoint)
LITELLM_MASTER_KEY="sk-any-string-you-choose"

# Relay mode tuning
RELAY_RPC="https://base-mainnet.public.blastapi.io"  # Public RPCs work
RELAY_CONCURRENCY="100"    # Chains per batch
RELAY_HOPS="3"             # Hops per chain

# Alternative proxy (siyetian)
PROXY_API_URL="http://proxy.siyetian.com/apis_get.html?token=YOUR_TOKEN&limit=10&..."
```

### 4. Proxy Provider Setup

**Why proxies?** BankOfAI rate-limits `claimSignupBonus` to **1 claim per IP**. Each new account needs a unique IP for the claim step.

| Provider | Type | Use Case | Config |
|----------|------|----------|--------|
| **Kookeey** | Rotating SOCKS5 (dynamic residential) | Batch claim (1 IP per claim) | `KOOKEEY_EXTRACT_URL` |
| **CloudBypass** | Sticky session HTTP | Login phase (can reuse) | `CLOUDBYPASS_*` |
| **Siyetian** | Rotating HTTP | Legacy fallback | `PROXY_API_URL` |

The dashboard uses a **2-pool strategy**:
- **Login pool** (CloudBypass sticky): Same IP can register multiple wallets
- **Claim pool** (Kookeey rotating): Fresh IP per claim, `maxUsesPerIp=1`

### 5. Funder Wallet Setup

```bash
# 1. Generate or use an existing EVM wallet
# 2. Bridge ETH to Base L2 (use bridge.base.org or any L2 bridge)
# 3. Send 0.01-0.05 ETH to the wallet on Base
# 4. Put the private key in FUNDER_PRIVATE_KEY

# Check funder balance:
cast balance YOUR_ADDRESS --rpc-url https://mainnet.base.org
```

Budget planning:
- 0.01 ETH on Base ≈ 500-1000 accounts (direct mode)
- 0.05 ETH on Base ≈ 2500-5000 accounts (relay mode, 3 hops)

### 6. LiteLLM Config (`web_dashboard/litellm/config.yaml`)

Defines which models the proxy can route to:

```yaml
model_list:
  - model_name: glm-5
    litellm_params:
      model: zhipuai/glm-5
      api_key: os.environ/ZHIPUAI_API_KEY

  - model_name: gpt-5.4
    litellm_params:
      model: openai/gpt-5.4
      api_key: os.environ/OPENAI_API_KEY

  - model_name: gemini-3.1-pro
    litellm_params:
      model: gemini/gemini-3.1-pro
      api_key: os.environ/GEMINI_API_KEY
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- An EVM wallet funded with ETH on Base L2
- A rotating proxy service (Kookeey recommended)

### Installation

```bash
git clone https://github.com/BuluBulugege/bankofai-pool_new.git
cd bankofai-pool_new

# Configure environment
cp .env.example .env
# Edit .env with your credentials
```

### Mode 1: Quick Test (Single Account)

```bash
cd web_reverse_chat_bankofai
npm install
node auto_sign_claim.js
# Output: address, apiKey, credits
```

### Mode 2: Batch Registration (Standalone)

```bash
cd web_reverse_chat_bankofai
# Register 10 accounts, 3 concurrent, 2s delay between
node auto_sign_claim.js 10 3 2000

# With Base chain dust (for newer anti-bot):
node batch_base.js 10 3
```

### Mode 3: Dashboard + Relay (Production)

```bash
cd web_dashboard
npm install
npx prisma generate
npx prisma db push
npm run dev
# Open http://localhost:3000
```

From the dashboard:
1. Configure proxy settings in "Settings" tab
2. Click "Start Relay" to begin chain-relay registration
3. Monitor in real-time: keys produced, funder spent, success rate
4. Use the pooled keys via `/api/v1/chat/completions`

---

## Dashboard Features

| Tab | Function |
|-----|----------|
| **Pool Status** | Active/depleted/dead accounts, total credits |
| **Account Table** | All registered keys with status and last usage |
| **Relay Control** | Start/stop relay registrar, live stats |
| **AutoFill** | Daemon to maintain minimum pool size |
| **Settings** | Proxy config, concurrency, thresholds |
| **API Docs** | Usage examples for the proxy endpoint |
| **Playground** | Test chat completions directly |

---

## API Proxy Usage

The dashboard exposes an OpenAI-compatible endpoint that load-balances across pooled keys:

```bash
curl http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer sk-bankofai-pool-master" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Supported models (routed through BankOfAI pool):
- `gpt-5.4` / `gpt-5.4-pro` (premium)
- `claude-sonnet-4-6` / `claude-opus-4-6` (premium)
- `gemini-3.1-pro` / `gemini-3-flash`
- `glm-5`

The proxy automatically:
- Picks the freshest key with highest remaining credits
- Rotates to next key on 403/depleted
- Marks keys as DEPLETED when credits run out

---

## Reports

Detailed analysis documents (in Chinese):

- [`Reverse_Report_CN.md`](./web_reverse_chat_bankofai/Reverse_Report_CN.md) — Full reverse engineering: wallet login flow, dual-chain architecture, AES key extraction, signature formats, database modes
- [`Premium_Bypass_Report_CN.md`](./web_reverse_chat_bankofai/Premium_Bypass_Report_CN.md) — Premium model access bypass: client-side gate analysis, 3 bypass methods, XOR auth header

---

## Disclaimer

This project is for **security research and educational purposes only**. It demonstrates vulnerabilities in client-side authentication patterns and insufficient anti-sybil mechanisms. The reverse engineering was performed on publicly accessible frontend JavaScript. Use responsibly and in compliance with applicable laws and platform terms.

---

## License

MIT
