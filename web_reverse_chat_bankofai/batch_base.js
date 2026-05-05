/**
 * 批量注册 BankOfAI（Base 链 dust 资助版）
 *
 * 流程：
 *   for each account:
 *     1. 生成新 EVM 钱包
 *     2. funder → 新钱包 转 DUST_ETH（确认 1 个 block）
 *     3. 跑完整 claim + create API key 流程
 *     4. 增量写入 all_keys.json
 *
 * 用法: node batch_base.js [count] [concurrency]
 *   count       要生成的 API key 数量（默认 5）
 *   concurrency 并发账号数（默认 3）— 注意 funder 发交易需序列化 nonce
 */

const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');
const fs = require('fs');

// ============================================================
// 配置
// ============================================================

const FUNDER_PK = process.env.FUNDER_PRIVATE_KEY || '';
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const DUST_ETH = process.env.DUST_ETH || '0.00000000001'; // = 10^7 wei = 10,000,000 wei

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;
const OUTPUT_FILE = 'all_keys.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// 签名消息
// ============================================================

function buildLoginMessage(address) {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: 0x1
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

function buildClaimMessage(address) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rnd = '';
  for (let i = 0; i < 6; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  return `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: 0x1
Nonce: ${rnd}${Date.now()}`;
}

function forgeToken() {
  const payload = `BANK OF AI welcome gift-claim|${Date.now()}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

// ============================================================
// On-chain dust transfer (序列化 nonce)
// ============================================================

class FunderQueue {
  constructor(funder, provider) {
    this.funder = funder;
    this.provider = provider;
    this.lock = Promise.resolve();
    this.nonce = null;
  }

  async init() {
    this.nonce = await this.provider.getTransactionCount(this.funder.address, 'pending');
    console.log(`[Funder] ${this.funder.address} | 起始 nonce: ${this.nonce}`);
    const bal = await this.provider.getBalance(this.funder.address);
    console.log(`[Funder] Base 余额: ${ethers.formatEther(bal)} ETH`);
  }

  // 串行发送：保证 nonce 单调
  async sendDust(target, valueWei) {
    const release = (async () => {
      const nonce = this.nonce++;
      const tx = await this.funder.sendTransaction({
        to: target,
        value: valueWei,
        nonce,
      });
      return tx;
    })();
    // 链式锁：下一次调用必须等本次 sendTransaction 返回 hash 后才能拿 nonce
    const prev = this.lock;
    this.lock = release.then(() => undefined, () => undefined);
    await prev;
    return release;
  }
}

// ============================================================
// Claim 流程
// ============================================================

async function runClaim(wallet, idx) {
  const tag = `[#${idx}]`;
  const loginMsg = buildLoginMessage(wallet.address);
  const loginSig = await wallet.signMessage(loginMsg);

  // CSRF
  const csrfRes = await fetch(`${AUTH_URL}/csrf`, { headers: { Accept: 'application/json' } });
  const csrfData = await csrfRes.json();
  const csrfCookies = csrfRes.headers.getSetCookie?.() || [];
  const csrfCookieHeader = csrfCookies.map(c => c.split(';')[0]).join('; ');

  // Login
  const loginBody = new URLSearchParams({
    chain: 'eth',
    message: loginMsg,
    signature: loginSig,
    version: '2',
    csrfToken: csrfData.csrfToken,
    callbackUrl: `${BASE_URL}/chat`,
  });
  const loginRes = await fetch(`${AUTH_URL}/callback/metamask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Return-Redirect': '1',
      Accept: '*/*',
      Cookie: csrfCookieHeader,
    },
    body: loginBody.toString(),
  });
  await loginRes.text();
  const setCookies = loginRes.headers.getSetCookie?.() || [];
  const sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!setCookies.some(c => c.includes('session-token'))) {
    return { success: false, step: 'login', error: 'no session cookie' };
  }

  // Session
  const sessRes = await fetch(`${AUTH_URL}/session`, {
    headers: { Accept: 'application/json', Cookie: sessionCookie },
  });
  const sessData = await sessRes.json();
  if (!sessData?.user?.id) {
    return { success: false, step: 'session', error: 'no user' };
  }

  // Claim
  const claimMsg = buildClaimMessage(wallet.address);
  const claimSig = await wallet.signMessage(claimMsg);
  const body = {
    '0': {
      json: {
        address: wallet.address,
        chain: 'eth',
        encryptedToken: forgeToken(),
        message: claimMsg,
        signature: claimSig,
        type: 'wallet',
        version: '2',
      },
    },
  };
  const claimRes = await fetch(`${TRPC_URL}/user.claimSignupBonus?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
      Referer: `${BASE_URL}/chat`,
      Origin: BASE_URL,
      Accept: '*/*',
    },
    body: JSON.stringify(body),
  });
  const claimText = await claimRes.text();
  if (claimRes.status !== 200) {
    return { success: false, step: 'claim', error: claimText.slice(0, 200), sessionCookie };
  }
  const claimJson = JSON.parse(claimText);
  if (!claimJson[0]?.result?.data?.json?.success) {
    return { success: false, step: 'claim', error: claimText.slice(0, 200), sessionCookie };
  }

  // API Key
  const keyRes = await fetch(`${TRPC_URL}/apiKey.createApiKey?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
      Referer: `${BASE_URL}/chat`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({ '0': { json: { name: `key-${idx}` } } }),
  });
  const keyText = await keyRes.text();
  const keyData = JSON.parse(keyText);
  const apiKey = keyData[0]?.result?.data?.json?.key;
  if (!apiKey) {
    return { success: false, step: 'apikey', error: keyText.slice(0, 200), sessionCookie };
  }

  return { success: true, apiKey, sessionCookie };
}

// ============================================================
// 单账号完整流程
// ============================================================

async function runOne(idx, funderQueue) {
  const wallet = ethers.Wallet.createRandom();
  console.log(`\n[#${idx}] address=${wallet.address}`);

  // 1. fund
  const valueWei = ethers.parseEther(DUST_ETH);
  let tx;
  try {
    tx = await funderQueue.sendDust(wallet.address, valueWei);
  } catch (e) {
    console.log(`[#${idx}] ❌ fund send 失败: ${e.message?.slice(0, 120)}`);
    return { idx, success: false, step: 'fund_send', error: e.message };
  }
  console.log(`[#${idx}] fund tx=${tx.hash} (waiting 1 conf...)`);
  try {
    await tx.wait(1);
  } catch (e) {
    console.log(`[#${idx}] ❌ fund wait 失败: ${e.message?.slice(0, 120)}`);
    return { idx, success: false, step: 'fund_wait', error: e.message };
  }

  // 2. claim flow
  const plain = new ethers.Wallet(wallet.privateKey);
  const r = await runClaim(plain, idx);
  if (!r.success) {
    console.log(`[#${idx}] ❌ ${r.step}: ${r.error?.slice(0, 120)}`);
    return { idx, success: false, ...r, address: wallet.address, privateKey: wallet.privateKey };
  }

  console.log(`[#${idx}] ✅ ${r.apiKey}`);
  return {
    idx,
    success: true,
    address: wallet.address,
    privateKey: wallet.privateKey,
    apiKey: r.apiKey,
    sessionCookie: r.sessionCookie,
    fundTx: tx.hash,
  };
}

// ============================================================
// 主循环
// ============================================================

async function main() {
  const target = parseInt(process.argv[2]) || 5;
  const concurrency = parseInt(process.argv[3]) || 3;

  console.log('='.repeat(70));
  console.log(`Batch BankOfAI 注册 (Base dust)`);
  console.log(`目标=${target} 并发=${concurrency} dust=${DUST_ETH} ETH`);
  console.log('='.repeat(70));

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const funder = new ethers.Wallet(FUNDER_PK, provider);
  const queue = new FunderQueue(funder, provider);
  await queue.init();

  // 加载已有 keys
  const allKeys = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (Array.isArray(existing)) allKeys.push(...existing);
    } catch {}
  }
  console.log(`已有 keys: ${allKeys.length}`);

  let succeeded = 0;
  let failed = 0;
  let inFlight = 0;
  let nextIdx = 1;

  async function worker(wid) {
    while (succeeded + inFlight < target) {
      const idx = nextIdx++;
      inFlight++;
      try {
        const r = await runOne(idx, queue);
        inFlight--;
        if (r.success) {
          succeeded++;
          allKeys.push({
            address: r.address,
            privateKey: r.privateKey,
            apiKey: r.apiKey,
            sessionCookie: r.sessionCookie,
            fundTx: r.fundTx,
            ts: Date.now(),
          });
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allKeys, null, 2));
          console.log(`>>> 进度 ${succeeded}/${target} (失败 ${failed})`);
        } else {
          failed++;
          if (failed > target * 3) {
            console.log(`失败次数过多 (${failed})，退出`);
            return;
          }
        }
      } catch (e) {
        inFlight--;
        failed++;
        console.log(`[W${wid}] 未捕获异常: ${e.message?.slice(0, 120)}`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i + 1));
    await sleep(300); // 错开起步，避免同时抢 nonce
  }
  await Promise.all(workers);

  console.log('\n' + '='.repeat(70));
  console.log(`完成: 成功 ${succeeded} | 失败 ${failed}`);
  console.log(`输出: ${OUTPUT_FILE} (共 ${allKeys.length} 条)`);
  console.log('='.repeat(70));

  const remaining = await provider.getBalance(funder.address);
  console.log(`Funder 剩余: ${ethers.formatEther(remaining)} ETH`);
}

main().catch(e => { console.error(e); process.exit(1); });
