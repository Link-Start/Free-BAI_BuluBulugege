/**
 * web_replay.js - chat.bankofai.io 请求重放脚本
 *
 * 包含:
 * 1. AES 加密 token 生成（用于 claim signup bonus）
 * 2. 钱包签名消息构造
 * 3. tRPC 请求重放（claimSignupBonus, createApiKey）
 *
 * 用法: node web_replay.js
 *
 * 依赖: npm install crypto-js ethers
 */

const CryptoJS = require('crypto-js');

// ============================================================
// §1 硬编码密钥（从前端提取）
// ============================================================
const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0='; // Base64, 256-bit
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/api/trpc`;

// ============================================================
// §2 加密工具（还原前端 encrypt 函数）
// ============================================================

/**
 * 前端原始加密逻辑:
 *   CryptoJS.AES.encrypt(`${provider}|${timestamp}`, AES_KEY).toString()
 */
function encryptToken(provider) {
  const timestamp = Date.now();
  const payload = `${provider}|${timestamp}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

/**
 * 解密（用于验证）
 */
function decryptToken(encrypted) {
  const bytes = CryptoJS.AES.decrypt(encrypted, AES_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ============================================================
// §3 签名消息构造（SIWE-like）
// ============================================================

/**
 * 生成钱包签名消息（与前端一致）
 * @param {string} address - 钱包地址
 * @param {string} chainIdHex - 链ID (hex)
 * @param {string} hostname - 域名 (chat.bankofai.io)
 * @param {string} nonce - 随机 nonce
 * @param {number} expiryMinutes - 过期时间(分钟)
 */
function buildSignMessage(address, chainIdHex, hostname = 'chat.bankofai.io', nonce = crypto.randomUUID(), expiryMinutes = 60) {
  const expiry = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
  return {
    message: `${hostname} wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiry}
Nonce: ${nonce}`,
    nonce,
    expiry
  };
}

// ============================================================
// §4 tRPC 请求封装
// ============================================================

/**
 * 构造 tRPC batch 请求 body
 */
function trpcBatch(procedures) {
  return {
    0: {
      jsonrpc: '2.0',
      id: 0,
      method: 'POST',
      params: procedures
    }
  };
}

/**
 * 构造单个 tRPC mutation 请求
 */
function trpcMutation(procedure, input) {
  return {
    jsonrpc: '2.0',
    id: 0,
    method: 'POST',
    params: {
      procedure,
      input,
      type: 'mutation'
    }
  };
}

/**
 * 构造 tRPC query 请求
 */
function trpcQuery(procedure, input) {
  return {
    jsonrpc: '2.0',
    id: 0,
    method: 'GET',
    params: {
      procedure,
      input,
      type: 'query'
    }
  };
}

// ============================================================
// §5 核心业务函数
// ============================================================

/**
 * 新用户代币领取
 *
 * @param {Object} params
 * @param {string} params.type - "wallet" | "oauth:google"
 * @param {string} [params.address] - 钱包地址 (wallet 类型必填)
 * @param {string} [params.chain] - 链名 (wallet 类型必填)
 * @param {string} [params.signature] - 钱包签名 (wallet 类型必填)
 * @param {string} [params.message] - 签名原文 (wallet 类型必填)
 */
async function claimSignupBonus(params) {
  const encryptedToken = encryptToken(params.type === 'wallet' ? params.chain : params.type);

  const body = {
    json: {
      encryptedToken,
      type: params.type,
      version: '3'
    }
  };

  if (params.type === 'wallet') {
    body.json.address = params.address;
    body.json.chain = params.chain;
    body.json.signature = params.signature;
    body.json.message = params.message;
  }

  console.log('[claimSignupBonus] Request body:', JSON.stringify(body, null, 2));
  console.log('[claimSignupBonus] Encrypted token:', encryptedToken);
  console.log('[claimSignupBonus] Decrypted token:', decryptToken(encryptedToken));

  // 实际请求（需要有效 session）:
  // const res = await fetch(`${TRPC_URL}/user.claimSignupBonus`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(body)
  // });
  // return res.json();

  return { status: 'dry-run', body };
}

/**
 * 查询是否已领取新用户奖励
 */
async function hasClaimedSignupBonus() {
  console.log('[hasClaimedSignupBonus] Querying...');

  // 实际请求:
  // const res = await fetch(`${TRPC_URL}/user.hasClaimedSignupBonus`, {
  //   method: 'GET',
  //   headers: { 'Content-Type': 'application/json' }
  // });
  // return res.json();

  return { status: 'dry-run' };
}

/**
 * 创建 API Key
 *
 * @param {string} name - Key 名称 (max 63 chars)
 */
async function createApiKey(name) {
  const body = {
    json: { name: name.slice(0, 63) }
  };

  console.log('[createApiKey] Request body:', JSON.stringify(body, null, 2));

  // 实际请求（需要有效 session）:
  // const res = await fetch(`${TRPC_URL}/apiKey.createApiKey`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(body)
  // });
  // return res.json();

  return { status: 'dry-run', body };
}

/**
 * 查询所有 API Keys
 */
async function getApiKeys() {
  console.log('[getApiKeys] Querying...');

  // 实际请求:
  // const res = await fetch(`${TRPC_URL}/apiKey.getApiKeys`, {
  //   method: 'GET',
  //   headers: { 'Content-Type': 'application/json' }
  // });
  // return res.json();

  return { status: 'dry-run' };
}

/**
 * 删除 API Key
 *
 * @param {string} id - Key ID
 */
async function deleteApiKey(id) {
  const body = { json: { id } };
  console.log('[deleteApiKey] Request body:', JSON.stringify(body, null, 2));

  // 实际请求:
  // const res = await fetch(`${TRPC_URL}/apiKey.deleteApiKey`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(body)
  // });
  // return res.json();

  return { status: 'dry-run', body };
}

// ============================================================
// §6 curl 示例（API Key 使用方式）
// ============================================================

function generateCurlExamples(apiKey, apiUrl = 'https://chat.bankofai.io/api/openai') {
  return {
    curl: `curl -X POST "${apiUrl}" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.2",
    "messages": [
      {"role": "user", "content": "Hello World"}
    ],
    "stream": true,
    "temperature": 0.7,
    "max_tokens": 1000
  }'`,

    python: `import requests

response = requests.post(
    "${apiUrl}",
    headers={
        "Authorization": "Bearer ${apiKey}",
        "Content-Type": "application/json",
    },
    json={
        "model": "gpt-5.2",
        "messages": [
            {"role": "user", "content": "Hello World"}
        ],
        "stream": True,
        "temperature": 0.7,
        "max_tokens": 1000,
    },
)

for line in response.iter_lines():
    if line:
        print(line.decode())`,

    node: `const response = await fetch('${apiUrl}', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${apiKey}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'Hello World' }],
    stream: true,
    temperature: 0.7,
    max_tokens: 1000,
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}`
  };
}

// ============================================================
// §7 演示入口
// ============================================================

async function main() {
  console.log('=== chat.bankofai.io Replay Script ===\n');

  // 1. 测试加密/解密
  console.log('--- §1: Token Encryption Test ---');
  const encrypted = encryptToken('tron');
  const decrypted = decryptToken(encrypted);
  console.log('Encrypted:', encrypted);
  console.log('Decrypted:', decrypted);
  console.log('Format matches frontend:', /^tron\|\d+$/.test(decrypted) ? 'YES' : 'NO');
  console.log('');

  // 2. 测试签名消息生成
  console.log('--- §2: Sign Message Generation ---');
  const { message, nonce, expiry } = buildSignMessage(
    'TXkDh8p3qJ7vN2mR5wL9cF6bA4eG1sY0uZ',
    '0x2b6653dc' // TRON mainnet
  );
  console.log('Sign message:\n', message);
  console.log('Nonce:', nonce);
  console.log('Expiry:', expiry);
  console.log('');

  // 3. Claim signup bonus (dry-run)
  console.log('--- §3: Claim Signup Bonus (dry-run) ---');
  const claimResult = await claimSignupBonus({
    type: 'wallet',
    address: 'TXkDh8p3qJ7vN2mR5wL9cF6bA4eG1sY0uZ',
    chain: 'tron',
    signature: '<wallet_signature_here>',
    message: message
  });
  console.log('Result:', claimResult);
  console.log('');

  // 4. Create API Key (dry-run)
  console.log('--- §4: Create API Key (dry-run) ---');
  const keyResult = await createApiKey('my-test-key');
  console.log('Result:', keyResult);
  console.log('');

  // 5. Generate curl examples
  console.log('--- §5: API Usage Examples ---');
  const examples = generateCurlExamples('sk-your-api-key-here');
  console.log('cURL example:\n', examples.curl);
  console.log('');

  console.log('=== Done ===');
  console.log('Note: All API calls are dry-run. To make actual requests,');
  console.log('uncomment the fetch calls and provide a valid session cookie.');
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  encryptToken,
  decryptToken,
  buildSignMessage,
  claimSignupBonus,
  createApiKey,
  getApiKeys,
  deleteApiKey,
  generateCurlExamples,
  AES_KEY,
  TRPC_URL
};
