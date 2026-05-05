/**
 * 批量链式接力：
 *   - Funder 一次性 fund N 个 seed（串行 nonce）
 *   - 每条 seed 独立异步跑 H 跳（claim + 转余额给下一跳）
 *   - 100 条并发 × 3 跳 = 300 个潜在 key
 *
 * 用法:
 *   node scripts/batch_relay.mjs <FUNDER_PK> <CHAINS> <HOPS_PER_CHAIN> [SEED_WEI]
 * 例:
 *   node scripts/batch_relay.mjs 0x8d03... 100 3 20000000000000
 *
 * 默认 seedWei = 20000000000000 (0.00002 ETH = 3+ hops with buffer)
 */

import { ethers } from 'ethers';
import CryptoJS from 'crypto-js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'https';
import fs from 'fs';

const FUNDER_PK = process.argv[2];
const CHAINS = parseInt(process.argv[3] || '10');
const HOPS = parseInt(process.argv[4] || '3');
const SEED_WEI = BigInt(process.argv[5] || '20000000000000');

if (!FUNDER_PK?.startsWith('0x')) {
  console.error('usage: node batch_relay.mjs <FUNDER_PK> <CHAINS> <HOPS> [SEED_WEI]');
  process.exit(1);
}

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;
const BASE_RPC = 'https://base-mainnet.public.blastapi.io';
const KOOKEEY_URL = process.env.KOOKEEY_EXTRACT_URL || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_FEE = 7_500_000n;  // Base minimum gas ceiling
const PRIO_FEE = 1_000_000n;
// ethers preflight requires: balance >= value + gasLimit * maxFeePerGas (loosely; RPC node also checks)
// Use 50% extra buffer so preflight always passes; actual onchain cost still only baseFee+prio.
const GAS_RESERVE = 21000n * MAX_FEE * 3n / 2n;  // = 2.36e11 wei (1.5x)

const OUT_FILE = `keys_batch_${Date.now()}.json`;

// ============ Proxy ============

let proxyCreds = null; // { user, pass, host, port }
async function loadProxyCreds() {
  const r = await fetch(KOOKEEY_URL);
  const text = await r.text();
  const line = text.split(/\r?\n/)[0].trim();
  const [host, port, user, pass] = line.split(':');
  proxyCreds = { host, port, user, pass };
  console.log(`[proxy] loaded creds for ${host}:${port}`);
}

function newProxyAgent() {
  const { host, port, user, pass } = proxyCreds;
  const url = `socks5://${user}:${pass}@${host}:${port}`;
  return new SocksProxyAgent(url, { timeout: 20000 });
}

function req(url, agent, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      agent,
      timeout: 30000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('req timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ============ Sign + Claim ============

function buildLoginMsg(addr) {
  const expiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${addr}

Chain ID: 0x1
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

function buildClaimMsg(addr) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let r = ''; for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return `BANK OF AI welcome gift-claim
Account:
${addr}
Chain ID: 0x1
Nonce: ${r}${Date.now()}`;
}

function forgeToken() {
  return CryptoJS.AES.encrypt(`BANK OF AI welcome gift-claim|${Date.now()}`, AES_KEY).toString();
}

async function fullClaim(signer) {
  const address = signer.address;
  const agent = newProxyAgent();
  try {
    const loginMsg = buildLoginMsg(address);
    const loginSig = await signer.signMessage(loginMsg);

    const csrfRes = await req(`${AUTH_URL}/csrf`, agent, { headers: { Accept: 'application/json' } });
    const csrfData = JSON.parse(csrfRes.body);
    const csrfCookieHeader = (csrfRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const loginBody = new URLSearchParams({
      chain: 'eth', message: loginMsg, signature: loginSig, version: '2',
      csrfToken: csrfData.csrfToken, callbackUrl: `${BASE_URL}/chat`,
    }).toString();
    const loginRes = await req(`${AUTH_URL}/callback/metamask`, agent, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1', Accept: '*/*',
        Cookie: csrfCookieHeader,
        'Content-Length': Buffer.byteLength(loginBody),
      },
      body: loginBody,
    });
    const sessionCookie = (loginRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    if (!sessionCookie.includes('session-token')) {
      return { success: false, step: 'login', error: `no session (status=${loginRes.status})` };
    }

    const claimMsg = buildClaimMsg(address);
    const claimSig = await signer.signMessage(claimMsg);
    const claimBody = JSON.stringify({
      '0': { json: {
        address, chain: 'eth', encryptedToken: forgeToken(),
        message: claimMsg, signature: claimSig, type: 'wallet', version: '2',
      } },
    });
    const claimRes = await req(`${TRPC_URL}/user.claimSignupBonus?batch=1`, agent, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: sessionCookie,
        Referer: `${BASE_URL}/chat`, Origin: BASE_URL, Accept: '*/*',
        'Content-Length': Buffer.byteLength(claimBody),
      },
      body: claimBody,
    });
    if (claimRes.status !== 200) {
      return { success: false, step: 'claim', error: claimRes.body.slice(0, 200) };
    }
    const cd = JSON.parse(claimRes.body);
    if (cd[0]?.error) {
      return { success: false, step: 'claim', error: cd[0].error.json?.message || cd[0].error.message };
    }
    if (!cd[0]?.result?.data?.json?.success) {
      return { success: false, step: 'claim', error: 'claim returned non-success' };
    }

    // create API key
    const keyBody = JSON.stringify({ '0': { json: { name: `relay-${Date.now()}` } } });
    const keyRes = await req(`${TRPC_URL}/apiKey.createApiKey?batch=1`, agent, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: sessionCookie,
        Referer: `${BASE_URL}/chat`, Origin: BASE_URL,
        'Content-Length': Buffer.byteLength(keyBody),
      },
      body: keyBody,
    });
    const kd = JSON.parse(keyRes.body);
    const apiKey = kd[0]?.result?.data?.json?.key;
    if (!apiKey) return { success: false, step: 'createApiKey', error: keyRes.body.slice(0, 200) };

    return { success: true, apiKey };
  } finally {
    try { agent.destroy(); } catch {}
  }
}

// ============ Relay logic ============

/**
 * Retry claim up to 3 times on network error (NOT on BankOfAI 4xx rejection).
 * Returns { success, apiKey, error }.
 */
async function claimWithRetry(signer, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fullClaim(signer);
      if (r.success) return r;
      // Rejected (not network) — don't retry
      if (r.step === 'claim' && (r.error?.includes('Too many') || r.error?.includes('IP limit') || r.error?.includes('already claimed'))) {
        return r;
      }
      lastErr = r.error;
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { success: false, step: 'network', error: lastErr };
}

async function relay(provider, from, toAddress) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bal = await provider.getBalance(from.address);
    if (bal <= GAS_RESERVE + 1n) {
      return { success: false, error: `balance ${bal} <= reserve ${GAS_RESERVE}` };
    }
    try {
      // Leave 1 wei extra buffer — ethers preflight 要求严格 balance > value+gas, 不能相等
      const tx = await from.sendTransaction({
        to: toAddress,
        value: bal - GAS_RESERVE - 1n,
        gasLimit: 21000n,
        maxFeePerGas: MAX_FEE,
        maxPriorityFeePerGas: PRIO_FEE,
      });
      await tx.wait(1);
      return { success: true, hash: tx.hash };
    } catch (e) {
      lastErr = e.shortMessage || e.message;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return { success: false, error: lastErr };
}

async function runChain(chainId, seed, provider, keysBucket) {
  const prefix = `[chain ${chainId}]`;
  let current = seed;

  for (let hop = 0; hop < HOPS; hop++) {
    const tag = `${prefix}[hop ${hop + 1}]`;

    // Claim with retry (network errors only)
    const r = await claimWithRetry(current, 3);
    if (r.success) {
      keysBucket.push({
        chain: chainId,
        hop: hop + 1,
        address: current.address,
        privateKey: current.privateKey,
        apiKey: r.apiKey,
      });
      // Incremental save
      fs.writeFileSync(OUT_FILE, JSON.stringify(keysBucket, null, 2));
      console.log(`${tag} ✅ ${r.apiKey}`);
    } else {
      console.log(`${tag} ❌ ${r.step}: ${r.error?.slice(0, 80)}`);
    }

    // last hop — stop
    if (hop === HOPS - 1) break;

    // Relay to next (always, even if claim failed — don't waste remaining balance)
    const next = ethers.Wallet.createRandom().connect(provider);
    const rel = await relay(provider, current, next.address);
    if (!rel.success) {
      console.log(`${tag} relay stopped: ${rel.error?.slice(0, 80)}`);
      break;
    }
    current = next;
  }
}

// ============ Main ============

async function main() {
  // BlastAPI handles batches up to 200+. Cap at 50 to be safe and to keep latency low.
  const provider = new ethers.JsonRpcProvider(BASE_RPC, undefined, { batchMaxCount: 50, batchStallTime: 50 });
  const funder = new ethers.Wallet(FUNDER_PK, provider);
  const balBefore = await provider.getBalance(funder.address);
  console.log(`[funder] ${funder.address}`);
  console.log(`[funder] balance: ${ethers.formatEther(balBefore)} ETH`);

  const totalNeed = SEED_WEI * BigInt(CHAINS) + 21000n * MAX_FEE * BigInt(CHAINS);
  console.log(`[plan] chains=${CHAINS}, hops=${HOPS}, seedWei=${SEED_WEI}`);
  console.log(`[plan] total funder spend ≈ ${ethers.formatEther(totalNeed)} ETH`);
  if (balBefore < totalNeed) {
    console.error(`[plan] INSUFFICIENT FUNDS: need ${totalNeed}, have ${balBefore}`);
    process.exit(1);
  }

  await loadProxyCreds();

  // 1. Fund N seeds serially (nonce order) with rate-limit aware retry
  console.log(`\n[fund] creating ${CHAINS} seeds + funding...`);
  const seeds = [];
  let startNonce = await provider.getTransactionCount(funder.address, 'pending');
  const fundTxs = [];
  for (let i = 0; i < CHAINS; i++) {
    const w = ethers.Wallet.createRandom().connect(provider);
    seeds.push(w);

    let tx = null;
    let attempt = 0;
    while (!tx && attempt < 5) {
      try {
        tx = await funder.sendTransaction({
          to: w.address,
          value: SEED_WEI,
          gasLimit: 21000n,
          maxFeePerGas: MAX_FEE,
          maxPriorityFeePerGas: PRIO_FEE,
          nonce: startNonce + i,
        });
      } catch (e) {
        attempt++;
        const msg = e.error?.message || e.shortMessage || e.message || '';
        if (msg.includes('rate limit') || msg.includes('-32016')) {
          const waitMs = 1000 * attempt;
          console.log(`[fund] tx ${i+1} rate-limited, retry in ${waitMs}ms (attempt ${attempt})`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          throw e;
        }
      }
    }
    if (!tx) throw new Error(`fund tx ${i+1} failed after retries`);

    fundTxs.push(tx);
    if ((i + 1) % 10 === 0) console.log(`[fund] sent ${i + 1}/${CHAINS}`);
  }

  // Wait only for the LAST tx to confirm (earlier ones will be included in same or earlier blocks)
  console.log(`[fund] waiting last fund tx ${fundTxs[fundTxs.length - 1].hash} to confirm...`);
  await fundTxs[fundTxs.length - 1].wait(1);
  console.log(`[fund] all confirmed`);

  // Quick sanity: check a few seeds have balance
  for (let i = 0; i < Math.min(3, CHAINS); i++) {
    const b = await provider.getBalance(seeds[i].address);
    console.log(`[fund] seed[${i}] ${seeds[i].address} bal=${b}`);
  }

  // 2. Run N chains in parallel
  console.log(`\n[run] starting ${CHAINS} parallel chains...`);
  const keys = [];
  const t0 = Date.now();
  await Promise.all(seeds.map((seed, i) => runChain(i, seed, provider, keys)));

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const balAfter = await provider.getBalance(funder.address);
  const spent = balBefore - balAfter;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Summary: ${keys.length}/${CHAINS * HOPS} keys in ${dur}s`);
  console.log(`Funder spent: ${ethers.formatEther(spent)} ETH = $${(Number(spent)/1e18 * 3000).toFixed(3)}`);
  console.log(`Per-key cost: $${(Number(spent)/1e18 * 3000 / Math.max(keys.length, 1)).toFixed(5)}`);
  console.log(`Output file: ${OUT_FILE}`);
  console.log(`${'='.repeat(70)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
