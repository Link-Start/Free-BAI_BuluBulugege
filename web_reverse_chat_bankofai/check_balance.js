/**
 * 批量检测 API Key 余额
 * 用法: node check_balance.js [keys_file.json]
 *
 * 方式1: 有 privateKey → 登录查 tRPC points
 * 方式2: 无 privateKey → 发一个最小请求，看是否 402/余额不足
 */
const { ethers } = require('ethers');
const fs = require('fs');

const BASE_URL = 'https://chat.bankofai.io';
const API_URL = 'https://api.bankofai.io';

async function loginAndCheckPoints(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  const expiry = new Date(Date.now() + 86400000).toISOString();
  const msg = `Welcome to BANK OF AI !\nchat.bankofai.io wants you to sign in with your account:\n${wallet.address}\n\nChain ID: 0x1\nExpiration Time: ${expiry}\nNonce: ${nonce}`;
  const sig = await wallet.signMessage(msg);

  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: { Accept: 'application/json' } });
  const csrfData = await csrfRes.json();
  const csrfCookies = csrfRes.headers.getSetCookie?.() || [];

  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/metamask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Return-Redirect': '1',
      Cookie: csrfCookies.map(c => c.split(';')[0]).join('; ')
    },
    body: new URLSearchParams({
      chain: 'eth', message: msg, signature: sig, version: '2',
      csrfToken: csrfData.csrfToken, callbackUrl: `${BASE_URL}/chat`
    }).toString()
  });
  await loginRes.text();
  const session = loginRes.headers.getSetCookie?.().map(c => c.split(';')[0]).join('; ');

  const input = encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'], v: 1 } } }));
  const pointsRes = await fetch(`${BASE_URL}/trpc/lambda/usage.points?batch=1&input=${input}`, {
    headers: { Accept: 'application/json', Cookie: session }
  });
  const pointsData = await pointsRes.json();
  return pointsData[0]?.result?.data?.json?.points_balance ?? null;
}

async function checkViaApi(apiKey) {
  try {
    const res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'say ok' }],
        max_tokens: 10
      })
    });
    const data = await res.json();
    if (res.status === 200) return { alive: true, tokens: data.usage?.total_tokens };
    if (res.status === 402 || data.error?.message?.includes?.('insufficient') || data.error?.message?.includes?.('quota')) return { alive: false, reason: 'no_credits' };
    if (res.status === 401) return { alive: false, reason: 'invalid_key' };
    // max_tokens error still means the key works
    if (res.status === 400 && data.error?.message?.includes?.('max_tokens')) return { alive: true, tokens: 0 };
    return { alive: false, reason: `${res.status}: ${data.error?.message?.slice(0, 80)}` };
  } catch (e) {
    return { alive: false, reason: e.message?.slice(0, 60) };
  }
}

async function main() {
  const file = process.argv[2] || 'all_keys.json';
  if (!fs.existsSync(file)) { console.log(`文件不存在: ${file}`); return; }

  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`检测 ${keys.length} 个 API Key\n`);

  const concurrency = parseInt(process.argv[3]) || 5;
  let alive = 0, dead = 0, checked = 0;
  const results = [];

  async function check(entry) {
    let balance = null;
    // Method 1a: use saved sessionCookie directly
    if (entry.sessionCookie) {
      try {
        const input = encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'], v: 1 } } }));
        const r = await fetch(`${BASE_URL}/trpc/lambda/usage.points?batch=1&input=${input}`, {
          headers: { Accept: 'application/json', Cookie: entry.sessionCookie }
        });
        const d = await r.json();
        balance = d[0]?.result?.data?.json?.points_balance ?? null;
      } catch {}
    }
    // Method 1b: login + tRPC (if privateKey available and sessionCookie failed)
    if (balance === null && entry.privateKey) {
      try {
        balance = await loginAndCheckPoints(entry.privateKey);
      } catch {}
    }

    // Method 2: API call test
    const apiResult = await checkViaApi(entry.apiKey);

    checked++;
    const status = apiResult.alive ? '✓' : '✗';
    const balStr = balance !== null ? `${balance} pts` : '?';
    if (apiResult.alive) alive++; else dead++;

    console.log(`  ${status} ${entry.apiKey.slice(0, 20)}... | 余额: ${balStr} | ${apiResult.alive ? 'OK' : apiResult.reason} (${checked}/${keys.length})`);
    results.push({ ...entry, balance, alive: apiResult.alive });
  }

  // Run with concurrency
  const queue = [...keys];
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry) await check(entry);
    }
  });
  await Promise.all(workers);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`总计: ${keys.length} | 存活: ${alive} | 失效: ${dead}`);
  console.log('='.repeat(50));

  // Save results
  const outFile = file.replace('.json', '_checked.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`结果写入: ${outFile}`);
}

main().catch(console.error);
