/**
 * 批量注册 + Claim + API Key（带代理 IP 轮换）
 *
 * 用法: node batch_proxy.js
 * 依赖: npm install ethers crypto-js undici
 */
const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');
const undici = require('undici');
const fs = require('fs');

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const PROXY_API = process.env.PROXY_API_URL || '';
const MAX_ROUNDS = 200;
const CONCURRENCY = 5;
const OUTPUT_FILE = 'all_keys.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const allKeys = [];
let totalSucceeded = 0;
let totalFailed = 0;
let totalCompleted = 0;
const usedProxies = new Set();

// ============================================================
// Proxy-aware fetch
// ============================================================

function proxyFetch(url, opts, proxyUrl) {
  const dispatcher = new undici.ProxyAgent(proxyUrl);
  return undici.fetch(url, { ...opts, dispatcher });
}

// ============================================================
// Core flow (single wallet, single proxy)
// ============================================================

async function runOne(index, proxyUrl) {
  const tag = `[#${index}][${proxyUrl.split('//')[1]}]`;

  // 1. Wallet
  const wallet = ethers.Wallet.createRandom();

  // 2. Login message + sign
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const loginMsg = `Welcome to BANK OF AI !\nchat.bankofai.io wants you to sign in with your account:\n${wallet.address}\n\nChain ID: 0x1\nExpiration Time: ${expiry}\nNonce: ${nonce}`;
  const loginSig = await wallet.signMessage(loginMsg);

  // 3. CSRF
  const csrfRes = await proxyFetch(`${BASE_URL}/api/auth/csrf`, { headers: { Accept: 'application/json' } }, proxyUrl);
  const csrfData = await csrfRes.json();
  const csrfCookies = csrfRes.headers.getSetCookie?.() || [];
  const csrfCookieHeader = csrfCookies.map(c => c.split(';')[0]).join('; ');

  // 4. Login
  const loginBody = new URLSearchParams({
    chain: 'eth', message: loginMsg, signature: loginSig, version: '2',
    csrfToken: csrfData.csrfToken, callbackUrl: `${BASE_URL}/chat`
  });
  const loginRes = await proxyFetch(`${BASE_URL}/api/auth/callback/metamask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1', Accept: '*/*', Cookie: csrfCookieHeader },
    body: loginBody.toString()
  }, proxyUrl);
  await loginRes.text();
  const setCookies = loginRes.headers.getSetCookie?.() || [];
  const sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!setCookies.some(c => c.includes('session-token'))) {
    return { index, success: false, step: 'login', error: 'No session' };
  }

  // 5. Verify session
  const sessRes = await proxyFetch(`${BASE_URL}/api/auth/session`, { headers: { Accept: 'application/json', Cookie: sessionCookie } }, proxyUrl);
  const sessData = await sessRes.json();
  if (!sessData?.user?.id) {
    return { index, success: false, step: 'session', error: 'No user' };
  }

  // 6. Claim
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rnd = '';
  for (let i = 0; i < 6; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  const claimMsg = `BANK OF AI welcome gift-claim\nAccount:\n${wallet.address}\nChain ID: 0x1\nNonce: ${rnd}${Date.now()}`;
  const claimSig = await wallet.signMessage(claimMsg);
  const encToken = CryptoJS.AES.encrypt(`BANK OF AI welcome gift-claim|${Date.now()}`, AES_KEY).toString();

  const claimBody = { '0': { json: { address: wallet.address, chain: 'eth', encryptedToken: encToken, message: claimMsg, signature: claimSig, type: 'wallet', version: '2' } } };
  const claimRes = await proxyFetch(`${BASE_URL}/trpc/lambda/user.claimSignupBonus?batch=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, Referer: `${BASE_URL}/chat`, Origin: BASE_URL, Accept: '*/*' },
    body: JSON.stringify(claimBody)
  }, proxyUrl);
  const claimText = await claimRes.text();

  if (claimRes.status !== 200) {
    const isIpLimit = claimText.includes('IP limit');
    return { index, success: false, step: 'claim', error: claimText.slice(0, 120), isIpLimit };
  }
  const claimData = JSON.parse(claimText);
  if (!claimData[0]?.result?.data?.json?.success) {
    return { index, success: false, step: 'claim', error: 'claim not success' };
  }

  // 7. Create API Key
  const keyRes = await proxyFetch(`${BASE_URL}/trpc/lambda/apiKey.createApiKey?batch=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, Referer: `${BASE_URL}/chat`, Origin: BASE_URL },
    body: JSON.stringify({ '0': { json: { name: `key-${index}` } } })
  }, proxyUrl);
  const keyText = await keyRes.text();
  const keyData = JSON.parse(keyText);
  const apiKey = keyData[0]?.result?.data?.json?.key;

  return { index, success: true, address: wallet.address, privateKey: wallet.privateKey, sessionCookie: sessionCookie, apiKey, credits: 100000 };
}

// ============================================================
// Fetch proxies
// ============================================================

async function fetchProxies() {
  const res = await fetch(PROXY_API);
  const text = await res.text();
  const proxies = text.split('<br />').map(s => s.trim()).filter(Boolean).map(p => `http://${p}`);
  return proxies;
}

// ============================================================
// Run one round with 5 proxies (5 concurrent workers)
// ============================================================

async function runRound(roundNum, proxies) {
  const startTime = Date.now();
  const ipFailed = new Set();
  const roundResults = [];
  let roundSuccess = 0;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[轮次 ${roundNum}] 代理: ${proxies.map(p => p.split('//')[1]).join(' | ')}`);
  console.log('='.repeat(70));

  // Each proxy runs sequentially until it hits IP limit
  async function proxyWorker(proxyUrl, workerId) {
    let consecutiveFails = 0;
    while (consecutiveFails < 2) {
      totalCompleted++;
      const idx = totalCompleted;
      try {
        const result = await runOne(idx, proxyUrl);
        if (result.success) {
          roundSuccess++;
          totalSucceeded++;
          consecutiveFails = 0;
          allKeys.push({ address: result.address, privateKey: result.privateKey, sessionCookie: result.sessionCookie, apiKey: result.apiKey, credits: result.credits, proxy: proxyUrl.split('//')[1] });
          console.log(`  [W${workerId}] #${idx} ✓ ${result.apiKey} (总计:${totalSucceeded})`);
          // Save incrementally
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allKeys, null, 2));
        } else if (result.isIpLimit || result.error?.includes?.('IP limit')) {
          console.log(`  [W${workerId}] #${idx} IP限流，此代理用尽`);
          ipFailed.add(proxyUrl);
          totalCompleted--; // Don't count this one
          break;
        } else {
          consecutiveFails++;
          totalFailed++;
          console.log(`  [W${workerId}] #${idx} ✗ ${result.step}: ${result.error?.slice(0, 60)}`);
        }
      } catch (err) {
        consecutiveFails++;
        totalFailed++;
        console.log(`  [W${workerId}] #${idx} ✗ 异常: ${err.message?.slice(0, 60)}`);
      }
    }
  }

  await Promise.all(proxies.map((p, i) => proxyWorker(p, i + 1)));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[轮次 ${roundNum}] 完成: ${roundSuccess} 成功 | ${elapsed}s | 总成功: ${totalSucceeded}`);
  proxies.forEach(p => usedProxies.add(p));
}

// ============================================================
// Main
// ============================================================

async function main() {
  const targetKeys = parseInt(process.argv[2]) || 1000;
  const startTime = Date.now();

  console.log(`=== 批量注册 (代理轮换) ===`);
  console.log(`目标: ${targetKeys} 个 API Key | 并发: ${CONCURRENCY} | 最大轮次: ${MAX_ROUNDS}`);
  console.log(`输出: ${OUTPUT_FILE}\n`);

  // Load existing keys if any
  if (fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    allKeys.push(...existing);
    totalSucceeded = existing.length;
    console.log(`已加载 ${existing.length} 个已有 key\n`);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (totalSucceeded >= targetKeys) break;

    // Fetch fresh proxies
    let proxies;
    try {
      proxies = await fetchProxies();
    } catch (err) {
      console.log(`[轮次 ${round}] 获取代理失败: ${err.message}，等待 5s...`);
      await sleep(5000);
      continue;
    }

    if (!proxies.length) {
      console.log(`[轮次 ${round}] 无可用代理，等待 5s...`);
      await sleep(5000);
      continue;
    }

    await runRound(round, proxies);

    if (totalSucceeded >= targetKeys) break;

    // Brief pause between rounds for proxy rotation
    console.log(`\n等待 2s 换下一批代理...\n`);
    await sleep(2000);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log(`全部完成! 耗时: ${elapsed}s | 成功: ${totalSucceeded} | 失败: ${totalFailed}`);
  console.log(`使用代理: ${usedProxies.size} 个`);
  console.log(`API Keys 已写入: ${OUTPUT_FILE}`);
  console.log('='.repeat(70));
}

main().catch(console.error);
