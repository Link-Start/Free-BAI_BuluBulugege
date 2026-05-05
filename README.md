# BankOfAI Reverse Engineering & API Key Pool

Reverse engineering of [chat.bankofai.io](https://chat.bankofai.io) (a LobeChat-based AI platform branded as AINFT) + automated API key pool management system.

## Architecture

```
grok_heavy/
├── web_reverse_chat_bankofai/   # Reverse engineering scripts
│   ├── Reverse_Report_CN.md     # Full reverse analysis report
│   ├── Premium_Bypass_Report_CN.md  # Premium model bypass analysis
│   ├── auto_sign_claim.js       # Full auto: register → sign → claim → API key
│   ├── batch_base.js            # Batch registration with Base chain dust funding
│   ├── premium_bypass.js        # Premium model access bypass methods
│   ├── check_balance.js         # Check account credit balances
│   ├── web_replay.js            # Request replay toolkit
│   └── ...                      # Various test/debug scripts
│
└── web_dashboard/               # Next.js management dashboard
    ├── app/                     # Dashboard UI (pool status, accounts, relay, API docs)
    ├── lib/services/            # Core services (BankOfAI registration, proxy pool, funder)
    ├── scripts/                 # Batch relay & autofill scripts
    ├── prisma/                  # SQLite schema (Account, UsageLog, Setting)
    └── litellm/                 # LiteLLM proxy config for model routing
```

## What It Does

### Reverse Engineering (web_reverse_chat_bankofai)

1. **Analyzed** chat.bankofai.io frontend (Next.js bundles, 138 JS chunks)
2. **Discovered** wallet login flow (TRON + EVM dual-chain, 7 wallets supported)
3. **Extracted** hardcoded AES key used for claim token encryption
4. **Built** automated scripts to:
   - Generate new EVM wallets
   - Sign login messages (SIWE-like format)
   - Register via next-auth credentials flow
   - Claim 100,000 signup credits per account
   - Create API keys

### Dashboard (web_dashboard)

- **Account Pool**: Manages hundreds of registered API keys with credit tracking
- **Relay Registrar**: Automated batch registration pipeline (wallet → fund → register → claim → key)
- **LiteLLM Integration**: Routes requests through pooled keys to various models (GPT-5.4, Gemini 3.1 Pro, GLM-5)
- **Auto-Fill**: Continuously registers new accounts to maintain pool size
- **Monitoring**: Real-time status, usage logs, balance checks

## Key Findings

| Finding | Impact |
|---------|--------|
| AES key hardcoded in frontend | Can forge claim tokens |
| Premium model check is client-side only | Free access to premium models (Opus 4.6, GPT-5.4 Pro) |
| No IP/device fingerprint on registration | Batch registration possible |
| 100,000 credits per new account | ~$0.10 value per registration |
| XOR auth header with static key "LobeHub · LobeHub" | Trivial to construct |

## Setup

### Prerequisites

- Node.js 18+
- A funded EVM wallet (for Base chain dust transfers)
- Rotating proxy service (Kookeey/CloudBypass or similar)

### Installation

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/grok_heavy.git
cd grok_heavy

# Configure
cp .env.example .env
# Edit .env with your credentials

# Reverse scripts
cd web_reverse_chat_bankofai
npm install

# Dashboard
cd ../web_dashboard
npm install
npx prisma generate
npx prisma db push
npm run dev
```

### Quick Start — Register One Account

```bash
cd web_reverse_chat_bankofai
node auto_sign_claim.js
```

### Batch Registration

```bash
# Register 10 accounts, 3 concurrent, 2s delay
node auto_sign_claim.js 10 3 2000

# With Base chain dust (required for newer anti-bot checks)
node batch_base.js 10 3
```

### Dashboard

```bash
cd web_dashboard
npm run dev
# Open http://localhost:3000
```

## Environment Variables

See [`.env.example`](./.env.example) for all required variables.

| Variable | Description |
|----------|-------------|
| `FUNDER_PRIVATE_KEY` | EVM wallet private key for sending dust ETH |
| `BASE_RPC` | Base chain RPC endpoint |
| `KOOKEEY_EXTRACT_URL` | Rotating proxy API endpoint |
| `LITELLM_MASTER_KEY` | Master key for LiteLLM proxy |

## Reports

- [`Reverse_Report_CN.md`](./web_reverse_chat_bankofai/Reverse_Report_CN.md) — Full reverse engineering report (Chinese)
- [`Premium_Bypass_Report_CN.md`](./web_reverse_chat_bankofai/Premium_Bypass_Report_CN.md) — Premium model bypass analysis (Chinese)

## Disclaimer

This project is for **security research and educational purposes only**. The reverse engineering was conducted to analyze authentication mechanisms and identify vulnerabilities. Use responsibly and in compliance with applicable laws.

## License

MIT
