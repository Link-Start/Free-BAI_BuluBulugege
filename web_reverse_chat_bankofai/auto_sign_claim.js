/**
 * 全自动注册 + 签名 + claim bonus + 创建 API Key
 *
 * 登录流程 (next-auth credentials):
 * 1. GET  /api/auth/csrf              → 获取 csrfToken
 * 2. POST /api/auth/callback/metamask → 提交签名登录 → 返回 session cookie
 * 3. GET  /api/auth/session           → 验证 session
 * 4. POST /trpc/lambda/user.claimSignupBonus → 领取 bonus
 * 5. POST /trpc/lambda/apiKey.createApiKey   → 创建 API Key
 *
 * 用法: node auto_sign_claim.js
 * 依赖: npm install ethers crypto-js
 */

const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;

// ============================================================
// §1 钱包生成 + 本地签名
// ============================================================

function createWallet() {
  const wallet = ethers.Wallet.createRandom();
  console.log(`[Wallet] Address: ${wallet.address}`);
  return wallet;
}

/**
 * 构造签名消息（从实际抓包还原的格式）
 * 格式: "Welcome to BANK OF AI !\n{hostname} wants you to sign in with your account:\n{address}\n\nChain ID: {chainIdHex}\nExpiration Time: {expiry}\nNonce: {nonce}"
 */
function buildSignMessage(address, nonce, chainIdHex = '0x1') {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

async function signMessage(wallet, message) {
  return await wallet.signMessage(message);
}

// ============================================================
// §2 Claim 签名消息构造
// ============================================================

/**
 * claimSignupBonus 专用的签名消息格式（从成功抓包还原）
 * 格式: "BANK OF AI welcome gift-claim\nAccount:\n{address}\nChain ID: {chainIdHex}\nNonce: {nonce}"
 * 注意：这和登录用的签名消息完全不同！
 */
function buildClaimMessage(address, chainIdHex = '0x1') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) randomStr += chars[Math.floor(Math.random() * chars.length)];
  const nonce = `${randomStr}${Date.now()}`;
  return {
    message: `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: ${chainIdHex}
Nonce: ${nonce}`,
    nonce
  };
}

// ============================================================
// §3 AES Token 伪造
// ============================================================

function forgeToken() {
  const payload = `BANK OF AI welcome gift-claim|${Date.now()}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

// ============================================================
// §3 next-auth 登录
// ============================================================

async function getCsrfToken() {
  const res = await fetch(`${AUTH_URL}/csrf`, {
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  const csrfToken = data.csrfToken;
  console.log(`[CSRF] Token: ${csrfToken?.slice(0, 20)}...`);
  return { csrfToken, cookies: res.headers.getSetCookie?.() || [] };
}

async function loginWithCredentials(csrfToken, csrfCookies, address, signature, message, version = '2', chain = 'eth') {
  const provider = chain === 'tron' ? 'tronlink' : 'metamask';
  const callbackUrl = `${BASE_URL}/chat`;

  const formData = new URLSearchParams({
    chain,
    message,
    signature,
    version,
    csrfToken,
    callbackUrl
  });

  const cookieHeader = csrfCookies.map(c => c.split(';')[0]).join('; ');

  const res = await fetch(`${AUTH_URL}/callback/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Return-Redirect': '1',
      'Accept': '*/*',
      'Cookie': cookieHeader,
    },
    body: formData.toString()
  });

  const text = await res.text();
  const setCookies = res.headers.getSetCookie?.() || [];

  console.log(`[Login] HTTP ${res.status}`);
  console.log(`[Login] Set-Cookie: ${setCookies.map(c => c.split(';')[0]).join(', ')}`);
  console.log(`[Login] Response: ${text.slice(0, 300)}`);

  // 检查是否有 session cookie
  const hasSession = setCookies.some(c => c.includes('session-token'));

  return {
    status: res.status,
    cookies: setCookies,
    cookieHeader: setCookies.map(c => c.split(';')[0]).join('; '),
    response: text,
    hasSession
  };
}

async function verifySession(cookieHeader) {
  const res = await fetch(`${AUTH_URL}/session`, {
    headers: {
      'Accept': 'application/json',
      'Cookie': cookieHeader,
    }
  });
  const data = await res.json();
  console.log(`[Session] HTTP ${res.status}`);
  console.log(`[Session] User: ${JSON.stringify(data)?.slice(0, 200)}`);
  return data;
}

// ============================================================
// §4 claimSignupBonus
// ============================================================

async function claimSignupBonus(address, chain, signature, message, cookieHeader) {
  const encryptedToken = forgeToken();

  const body = {
    '0': {
      json: {
        address,
        chain,
        encryptedToken,
        message,
        signature,
        type: 'wallet',
        version: '2'
      }
    }
  };

  const res = await fetch(`${TRPC_URL}/user.claimSignupBonus?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'Referer': `${BASE_URL}/chat`,
      'Origin': BASE_URL,
      'Accept': '*/*',
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log(`[claimSignupBonus] HTTP ${res.status}`);
  console.log(`[claimSignupBonus] Response: ${text.slice(0, 500)}`);

  try {
    const data = JSON.parse(text);
    const result = data[0]?.result?.data?.json;
    return { success: !!result?.success, amount: result?.amount, data };
  } catch {
    return { success: false, error: text.slice(0, 200) };
  }
}

// ============================================================
// §5 createApiKey
// ============================================================

async function createApiKey(name, cookieHeader) {
  const body = {
    '0': {
      json: { name }
    }
  };

  const res = await fetch(`${TRPC_URL}/apiKey.createApiKey?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'Referer': `${BASE_URL}/chat`,
      'Origin': BASE_URL,
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log(`[createApiKey] HTTP ${res.status}`);
  console.log(`[createApiKey] Response: ${text.slice(0, 500)}`);

  try {
    const data = JSON.parse(text);
    const result = data[0]?.result?.data?.json;
    return { success: !!result, key: result?.key, data };
  } catch {
    return { success: false, error: text.slice(0, 200) };
  }
}

// ============================================================
// §6 主流程
// ============================================================

async function runOne(index) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[#${index}] 开始全自动流程`);
  console.log('='.repeat(60));

  // Step 1: 生成钱包
  console.log('\n[Step 1] 生成钱包...');
  const wallet = createWallet();

  // Step 2: 构造签名消息
  console.log('\n[Step 2] 构造签名消息...');
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  const chainIdHex = '0x1'; // ETH mainnet
  const message = buildSignMessage(wallet.address, nonce, chainIdHex);
  console.log(`[Step 2] Nonce: ${nonce}`);
  console.log(`[Step 2] Message preview: ${message.split('\n')[0]}...`);

  // Step 3: 本地签名
  console.log('\n[Step 3] 本地签名...');
  const signature = await signMessage(wallet, message);
  console.log(`[Step 3] Signature: ${signature.slice(0, 40)}...`);

  // Step 4: 获取 CSRF token
  console.log('\n[Step 4] 获取 CSRF token...');
  const csrfResult = await getCsrfToken();

  // Step 5: 登录
  console.log('\n[Step 5] 登录...');
  const loginResult = await loginWithCredentials(
    csrfResult.csrfToken,
    csrfResult.cookies,
    wallet.address,
    signature,
    message,
    '2',
    'eth'
  );

  if (!loginResult.hasSession) {
    console.log(`[#${index}] 登录失败，未获取 session cookie`);
    console.log(`[#${index}] Response: ${loginResult.response.slice(0, 300)}`);
    return { index, success: false, step: 'login', error: 'No session cookie' };
  }

  console.log(`[#${index}] 登录成功!`);

  // Step 6: 验证 session
  console.log('\n[Step 6] 验证 session...');
  const sessionData = await verifySession(loginResult.cookieHeader);

  // Step 7: Claim bonus — 需要单独签名（和登录签名消息格式完全不同）
  console.log('\n[Step 7] Claim signup bonus...');
  const { message: claimMessage } = buildClaimMessage(wallet.address, chainIdHex);
  const claimSignature = await signMessage(wallet, claimMessage);
  console.log(`[Step 7] Claim message: ${claimMessage.split('\n')[0]}...`);
  console.log(`[Step 7] Claim signature: ${claimSignature.slice(0, 40)}...`);
  const claimResult = await claimSignupBonus(
    wallet.address, 'eth', claimSignature, claimMessage, loginResult.cookieHeader
  );

  if (!claimResult.success) {
    console.log(`[#${index}] Claim 失败: ${claimResult.error}`);
    return { index, success: false, step: 'claim', error: claimResult.error };
  }

  console.log(`[#${index}] Claim 成功! 获得 ${claimResult.amount} credits`);

  // Step 8: 创建 API Key
  console.log('\n[Step 8] 创建 API Key...');
  const keyResult = await createApiKey(`bot-key-${index}`, loginResult.cookieHeader);

  if (keyResult.success) {
    console.log(`[#${index}] API Key 创建成功: ${keyResult.key?.slice(0, 20)}...`);
  } else {
    console.log(`[#${index}] API Key 创建失败: ${keyResult.error}`);
  }

  return {
    index,
    success: true,
    address: wallet.address,
    privateKey: wallet.privateKey,
    credits: claimResult.amount,
    apiKey: keyResult.key,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runBatch(total, concurrency, delayMs = 2000) {
  const startTime = Date.now();
  const results = [];
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let queue = Array.from({ length: total }, (_, i) => i + 1);

  async function worker(workerId) {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (!idx) break;
      let retries = 0;
      const maxRetries = 3;
      while (retries <= maxRetries) {
        try {
          const result = await runOne(idx);
          results.push(result);
          if (result.success) {
            succeeded++;
            break;
          }
          // IP limit hit — wait and retry
          if (result.error?.includes?.('IP limit') || result.step === 'claim') {
            retries++;
            if (retries <= maxRetries) {
              const wait = delayMs * retries;
              console.log(`[W${workerId}] #${idx} IP限流，等待 ${wait/1000}s 后重试 (${retries}/${maxRetries})...`);
              await sleep(wait);
              continue;
            }
          }
          failed++;
          break;
        } catch (err) {
          retries++;
          if (retries > maxRetries) {
            results.push({ index: idx, success: false, error: err.message });
            failed++;
            break;
          }
          console.log(`[W${workerId}] #${idx} 异常，等待重试: ${err.message?.slice(0, 80)}`);
          await sleep(delayMs * retries);
        }
      }
      completed++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n>>> [W${workerId}] 进度: ${completed}/${total} (成功:${succeeded} 失败:${failed}) | ${elapsed}s <<<\n`);
      // 每次完成后延迟，避免 IP 限流
      if (queue.length > 0) await sleep(delayMs);
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker(w + 1));
    // 错开每个 worker 的启动时间
    if (w < concurrency - 1) await sleep(500);
  }
  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  return { results, elapsed, succeeded, failed };
}

async function main() {
  const total = parseInt(process.argv[2]) || 1;
  const concurrency = parseInt(process.argv[3]) || 1;
  const delayMs = parseInt(process.argv[4]) || 2000;

  console.log(`=== 批量注册 + Claim + API Key ===`);
  console.log(`目标: ${BASE_URL} | 数量: ${total} | 并发: ${concurrency} | 间隔: ${delayMs}ms`);
  console.log('');

  if (total === 1 && concurrency === 1) {
    const result = await runOne(1);
    console.log('\n' + '='.repeat(60));
    console.log(JSON.stringify(result, (key, value) => {
      if (key === 'privateKey') return value?.slice(0, 20) + '...';
      return value;
    }, 2));
    return;
  }

  const { results, elapsed, succeeded, failed } = await runBatch(total, concurrency, delayMs);

  console.log('\n' + '='.repeat(60));
  console.log(`完成! 耗时: ${elapsed}s | 成功: ${succeeded} | 失败: ${failed}`);
  console.log('='.repeat(60));

  // 输出成功的 API keys
  const fs = require('fs');
  const keys = results.filter(r => r.success).map(r => ({
    address: r.address,
    apiKey: r.apiKey,
    credits: r.credits,
  }));
  const outFile = `keys_${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(keys, null, 2));
  console.log(`\n${keys.length} 个 API Key 已写入 ${outFile}`);
  keys.forEach((k, i) => console.log(`  ${i + 1}. ${k.apiKey}`));
}

main().catch(console.error);

module.exports = { createWallet, buildSignMessage, signMessage, forgeToken, getCsrfToken, loginWithCredentials, verifySession, claimSignupBonus, createApiKey };
