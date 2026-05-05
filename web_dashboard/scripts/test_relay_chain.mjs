/**
 * 链式接力测试：
 *   seedWallet → claim → 转余额 - gas 给 next → next claim → ... → 共 N 跳
 *
 * 用法（服务器上跑）:
 *   node scripts/test_relay_chain.mjs <SEED_PK> <HOPS>
 *
 * 前置：你已经从外部给 SEED_PK 对应地址打了 0.00005 ETH 左右（够 5-10 跳）
 *   推荐金额：HOPS × 0.0000003 ETH ≈ HOPS × $0.001
 */

import { ethers } from 'ethers';
import CryptoJS from 'crypto-js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'https';

const SEED_PK = process.argv[2];
const HOPS = parseInt(process.argv[3] || '5');

if (!SEED_PK || !SEED_PK.startsWith('0x')) {
  console.error('usage: node test_relay_chain.mjs <SEED_PK_0x...> [hops=5]');
  process.exit(1);
}

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;
const BASE_RPC = 'https://mainnet.base.org';
const KOOKEEY = process.env.KOOKEEY_EXTRACT_URL || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchProxy() {
  const r = await fetch(KOOKEEY);
  const text = await r.text();
  const line = text.split(/\r?\n/)[0].trim();
  if (!line) throw new Error('no kookeey proxy');
  const [host, port, user, pass] = line.split(':');
  return { url: `socks5://${user}:${pass}@${host}:${port}`, line };
}

function req(url, agent, opts) {
  return new Promise((res, rej) => {
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
      resp.on('end', () => res({
        status: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', rej);
    r.on('timeout', () => { r.destroy(new Error('req timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

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

async function fullClaim(signer, agent) {
  const address = signer.address;
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
    return { success: false, step: 'login', error: 'no session cookie' };
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
    return { success: false, step: 'claim', error: claimRes.body.slice(0, 250) };
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
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  let current = new ethers.Wallet(SEED_PK, provider);
  const results = [];

  console.log(`\nstart wallet: ${current.address}`);
  const initBal = await provider.getBalance(current.address);
  console.log(`initial balance: ${ethers.formatEther(initBal)} ETH (${initBal} wei)`);
  if (initBal === 0n) {
    console.error('!! seed wallet has zero balance, please fund it first');
    process.exit(1);
  }
  console.log(`hops: ${HOPS}\n`);

  for (let i = 0; i < HOPS; i++) {
    const tag = `[hop ${i + 1}/${HOPS}]`;
    const bal = await provider.getBalance(current.address);
    console.log(`\n${tag} addr=${current.address}  bal=${ethers.formatEther(bal)} ETH`);

    if (bal === 0n) {
      console.log(`${tag} zero balance, stop`);
      break;
    }

    // Fresh kookeey proxy each hop
    let agent;
    try {
      const p = await fetchProxy();
      agent = new SocksProxyAgent(p.url, { timeout: 15000 });
      const sessionTag = p.line.match(/global-(\d+)/)?.[1];
      console.log(`${tag} kookeey session=${sessionTag}`);
    } catch (e) {
      console.log(`${tag} kookeey err: ${e.message}`);
      break;
    }

    const t0 = Date.now();
    let r;
    try {
      r = await fullClaim(current, agent);
    } catch (e) {
      r = { success: false, step: 'exception', error: e.message };
    }
    const dur = Date.now() - t0;
    if (r.success) {
      console.log(`${tag} ✅ ${r.apiKey} (${dur}ms)`);
      results.push({ hop: i + 1, address: current.address, privateKey: current.privateKey, apiKey: r.apiKey });
    } else {
      console.log(`${tag} ❌ step=${r.step} err=${r.error?.slice(0, 200)} (${dur}ms)`);
      results.push({ hop: i + 1, address: current.address, privateKey: current.privateKey, error: r.error });
    }
    agent.destroy();

    // last hop: don't need to relay
    if (i === HOPS - 1) break;

    // Relay all balance minus gas to next wallet
    const next = ethers.Wallet.createRandom();
    // Base baseFee floor = 5 Mwei (sampled). maxFeePerGas = 7.5 Mwei provides 50% buffer.
    const FIXED_MAXFEE = 7_500_000n;  // 7.5 Mwei
    const FIXED_PRIO = 1_000_000n;    // 1 Mwei priority fee
    // ethers preflight: balance >= value + gasLimit*maxFeePerGas, reserve 2x gas
    const gasReserve = 21000n * FIXED_MAXFEE * 2n; // 3.15e11 wei = ~$0.00095
    let attempt = 0;
    while (attempt < 3) {
      const remain = await provider.getBalance(current.address);
      if (remain <= gasReserve) {
        console.log(`${tag} exhausted: balance=${remain} < gasReserve=${gasReserve}`);
        break;
      }
      const sendValue = remain - gasReserve;
      try {
        const tx = await current.sendTransaction({
          to: next.address,
          value: sendValue,
          gasLimit: 21000n,
          maxFeePerGas: FIXED_MAXFEE,
          maxPriorityFeePerGas: FIXED_PRIO,
        });
        console.log(`${tag} relay tx=${tx.hash} value=${ethers.formatEther(sendValue)} ETH -> ${next.address}`);
        await tx.wait(1);
        break;
      } catch (e) {
        attempt++;
        console.log(`${tag} relay attempt ${attempt} failed: ${e.shortMessage || e.message}`);
        if (attempt >= 3) {
          console.log(`${tag} giving up relay`);
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    current = new ethers.Wallet(next.privateKey, provider);
  }

  // Summary
  const ok = results.filter(r => r.apiKey).length;
  console.log(`\n=== Summary: ${ok}/${results.length} claimed ===`);
  for (const r of results) {
    console.log(`  hop ${r.hop} ${r.address.slice(0, 10)}... ${r.apiKey ? '✅ ' + r.apiKey : '❌ ' + (r.error?.slice(0, 80) || 'failed')}`);
  }
  if (ok > 0) {
    console.log('\n--- Successful keys (json) ---');
    console.log(JSON.stringify(results.filter(r => r.apiKey).map(r => ({
      address: r.address, privateKey: r.privateKey, apiKey: r.apiKey,
    })), null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
