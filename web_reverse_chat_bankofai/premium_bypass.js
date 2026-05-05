/**
 * premium_bypass.js - chat.bankofai.io 高级模型访问绕过
 *
 * 逆向发现：
 *   - Premium 模型限制主要在客户端执行（isRecharged 布尔值门控）
 *   - 服务端仅校验：1) 用户认证 2) 积分余额
 *   - 新用户注册送 100,000 积分，足以使用 premium 模型
 *   - 服务端不会二次验证 isRecharged 标志
 *
 * 三种绕过方法：
 *   Method 1: 浏览器控制台注入（修改 Zustand store）
 *   Method 2: Node.js 直接构造请求（XOR 编码认证头）
 *   Method 3: 通过 API Key 直接调用
 *
 * 依赖: npm install crypto-js
 * 用法: node premium_bypass.js
 */

// ============================================================
// §1 常量（从前端提取）
// ============================================================

const XOR_KEY = 'LobeHub \xb7 LobeHub';  // module 731299, export RX
const AUTH_HEADER_NAME = 'X-ainft-chat-auth';  // module 731299, export Zk
const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';

// Premium 模型列表（abilities.premium = true）
const PREMIUM_MODELS = [
  { id: 'gpt-5.4-pro',                provider: 'openai',    sdkType: 'openai',     inputCost: 30,  outputCost: 180 },
  { id: 'claude-opus-4-6',            provider: 'anthropic', sdkType: 'anthropic',  inputCost: 5,   outputCost: 25  },
  { id: 'claude-opus-4-5-20251101',   provider: 'anthropic', sdkType: 'anthropic',  inputCost: 5,   outputCost: 25  },
  { id: 'claude-sonnet-4-6',          provider: 'anthropic', sdkType: 'anthropic',  inputCost: 3,   outputCost: 15  },
  { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic', sdkType: 'anthropic',  inputCost: 3,   outputCost: 15  },
];

// 免费模型列表（无 premium 标志）
const FREE_MODELS = [
  { id: 'gpt-5.4',        provider: 'openai',       sdkType: 'openai',  inputCost: 2.5,  outputCost: 15   },
  { id: 'gpt-5.2',        provider: 'openai',       sdkType: 'openai',  inputCost: 1.75, outputCost: 14   },
  { id: 'gpt-5.4-mini',   provider: 'openai',       sdkType: 'openai',  inputCost: 0.75, outputCost: 4.5  },
  { id: 'gpt-5-mini',     provider: 'openai',       sdkType: 'openai',  inputCost: 0.25, outputCost: 2    },
  { id: 'gpt-5.4-nano',   provider: 'openai',       sdkType: 'openai',  inputCost: 0.2,  outputCost: 1.25 },
  { id: 'gpt-5-nano',     provider: 'openai',       sdkType: 'openai',  inputCost: 0.05, outputCost: 0.4  },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', sdkType: 'anthropic', inputCost: 1, outputCost: 5 },
  { id: 'gemini-3.1-pro-preview',    provider: 'google',    sdkType: 'google',  inputCost: 2,   outputCost: 12 },
  { id: 'gemini-3-flash-preview',    provider: 'google',    sdkType: 'google',  inputCost: 0.5, outputCost: 3  },
  { id: 'MiniMaxAI/MiniMax-M2.5',    provider: 'siliconcloud', sdkType: 'openai', inputCost: 0.3, outputCost: 1.2 },
  { id: 'moonshotai/Kimi-K2.5',      provider: 'siliconcloud', sdkType: 'openai', inputCost: 0.23, outputCost: 3  },
  { id: 'zai-org/GLM-5',             provider: 'siliconcloud', sdkType: 'openai', inputCost: 0.3,  outputCost: 2.55 },
];

// ============================================================
// §2 XOR 编码（还原 module 783918 的 p 函数）
// ============================================================

/**
 * 还原前端 XOR 编码逻辑：
 *   let g = e => new TextEncoder().encode(e);
 *   let p = e => btoa(String.fromCharCode(
 *     ...((e, t) => {
 *       let r = new Uint8Array(e.length);
 *       for (let [a, i] of e.entries()) r[a] = i ^ t[a % t.length];
 *       return r;
 *     })(g(JSON.stringify(e)), g(u.RX))
 *   ));
 *
 * u.RX = "LobeHub · LobeHub"（\xb7 是中点符号）
 */
function xorEncode(payload) {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, 'utf-8');
  const key = Buffer.from(XOR_KEY, 'utf-8');
  const result = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ key[i % key.length];
  }
  return result.toString('base64');
}

function xorDecode(encoded) {
  const data = Buffer.from(encoded, 'base64');
  const key = Buffer.from(XOR_KEY, 'utf-8');
  const result = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ key[i % key.length];
  }
  return JSON.parse(result.toString('utf-8'));
}

// ============================================================
// §3 认证头构造（还原 createHeaderWithAuth / h 函数）
// ============================================================

/**
 * 构造 X-ainft-chat-auth 请求头
 *
 * 原始逻辑 (module 783918):
 *   h = async (e) => {
 *     let t = e?.payload || {};
 *     if (e?.provider) t = { ...t, ...f(e?.provider) };
 *     let r = ((e = {}) => p({
 *       accessCode: password,
 *       userId: userId,
 *       ...e
 *     }))(t);
 *     return { [AUTH_HEADER_NAME]: r };
 *   };
 *
 * 对于服务端管理的 provider（无用户 API key），payload 仅包含:
 *   { accessCode: "", userId: "user_xxx" }
 */
function buildAuthHeader(userId, accessCode = '') {
  const payload = { accessCode, userId };
  return { [AUTH_HEADER_NAME]: xorEncode(payload) };
}

// ============================================================
// §4 聊天请求构造
// ============================================================

/**
 * 向 /webapi/chat/{sdkType} 发送聊天请求
 *
 * 还原自 29664-55e665d619115dba.js 的 getChatCompletion
 *
 * @param {Object} opts
 * @param {string} opts.sessionCookie - next-auth.session-token cookie
 * @param {string} opts.userId - 用户 ID (例: user_lMdMODARMKBd)
 * @param {string} opts.model - 模型 ID (例: claude-opus-4-6)
 * @param {string} opts.sdkType - SDK 类型 (openai/anthropic/google)
 * @param {Array} opts.messages - 消息数组 [{ role, content }]
 * @param {Object} [opts.params] - 模型参数
 */
async function chatCompletion(opts) {
  const {
    sessionCookie,
    userId,
    model,
    sdkType = 'openai',
    messages = [{ role: 'user', content: 'Hello' }],
    params = {},
  } = opts;

  const authHeader = buildAuthHeader(userId);
  const url = `${BASE_URL}/webapi/chat/${sdkType}`;

  const body = {
    model,
    stream: true,
    messages,
    temperature: params.temperature ?? 1,
    top_p: params.top_p ?? 1,
    presence_penalty: params.presence_penalty ?? 0,
    frequency_penalty: params.frequency_penalty ?? 0,
  };

  console.log(`[chatCompletion] POST ${url}`);
  console.log(`[chatCompletion] Model: ${model} (${sdkType})`);
  console.log(`[chatCompletion] Auth header: ${AUTH_HEADER_NAME}: ${authHeader[AUTH_HEADER_NAME].substring(0, 40)}...`);
  console.log(`[chatCompletion] Body:`, JSON.stringify(body, null, 2));

  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `next-auth.session-token=${sessionCookie}`,
    ...authHeader,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  console.log(`[chatCompletion] Response status: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[chatCompletion] Error: ${text}`);
    return { error: true, status: res.status, body: text };
  }

  // 读取 SSE 流
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    process.stdout.write(chunk);
    fullResponse += chunk;
  }

  console.log('\n[chatCompletion] Stream complete');
  return { error: false, response: fullResponse };
}

// ============================================================
// §5 Method 1: 浏览器控制台注入脚本
// ============================================================

const BROWSER_BYPASS_SCRIPT = `
// =====================================================
// chat.bankofai.io Premium Model Bypass
// 在浏览器控制台 (F12) 中粘贴执行
// =====================================================

// 方法 A: 拦截 trpc.user.isRecharged 响应
// 原始代码在 ModelSwitchPanel 组件中:
//   trpc.user.isRecharged.query().then(r => setIsRecharged(r.isRecharged))
// 我们拦截 fetch 让它总是返回 true

const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await originalFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

  // 拦截 isRecharged 查询
  if (url?.includes('user.isRecharged')) {
    const clone = res.clone();
    return new Response(JSON.stringify([{
      result: { data: { json: { isRecharged: true } } }
    }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return res;
};

console.log('[Bypass] fetch interceptor installed - isRecharged will always return true');
console.log('[Bypass] Now open the model selector dropdown to load premium models');

// 方法 B: 直接修改 agent config 中的 model（跳过 UI 选择器）
// 通过 tRPC mutation 直接设置 premium model
async function setPremiumModel(agentId, modelId, providerId) {
  const res = await originalFetch('/trpc/lambda/agent.updateAgentConfig?batch=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      "0": {
        "json": {
          "id": agentId,
          "config": { "model": modelId, "provider": providerId }
        }
      }
    })
  });
  const data = await res.json();
  console.log('[Bypass] Model updated:', data);
  return data;
}

// 用法示例:
// setPremiumModel('agt_xxxxx', 'claude-opus-4-6', 'anthropic');
// setPremiumModel('agt_xxxxx', 'claude-sonnet-4-6', 'anthropic');
// setPremiumModel('agt_xxxxx', 'gpt-5.4-pro', 'openai');

console.log('[Bypass] Use setPremiumModel(agentId, modelId, providerId) to set a premium model directly');
console.log('[Bypass] Premium models: claude-opus-4-6, claude-sonnet-4-6, gpt-5.4-pro');
`;

// ============================================================
// §6 Method 3: API Key 直接调用
// ============================================================

/**
 * 通过 API Key 直接调用 (不经过 Web UI)
 * 外部 API 端点: https://api.bankofai.io/v1/chat/completions
 *
 * API Key 通过 tRPC apiKey.createApiKey 创建
 * API Key 走独立的 points 计费路径，不受 isRecharged 门控
 */
async function apiKeyChat(apiKey, model, messages, baseUrl = 'https://api.bankofai.io/v1') {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    temperature: 1,
  };

  console.log(`[apiKeyChat] POST ${url}`);
  console.log(`[apiKeyChat] Model: ${model}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  console.log(`[apiKeyChat] Response status: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[apiKeyChat] Error: ${text}`);
    return { error: true, status: res.status, body: text };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    process.stdout.write(chunk);
    fullResponse += chunk;
  }

  console.log('\n[apiKeyChat] Stream complete');
  return { error: false, response: fullResponse };
}

// ============================================================
// §7 演示 & 测试入口
// ============================================================

async function main() {
  console.log('=== chat.bankofai.io Premium Model Bypass ===\n');

  // 测试 XOR 编码/解码
  console.log('--- §1: XOR Auth Header Test ---');
  const testPayload = { accessCode: '', userId: 'user_lMdMODARMKBd' };
  const encoded = xorEncode(testPayload);
  const decoded = xorDecode(encoded);
  console.log('Payload:', JSON.stringify(testPayload));
  console.log('Encoded:', encoded);
  console.log('Decoded:', JSON.stringify(decoded));
  console.log('Round-trip OK:', JSON.stringify(testPayload) === JSON.stringify(decoded));
  console.log('');

  // 展示 auth header
  console.log('--- §2: Auth Header Construction ---');
  const authHeader = buildAuthHeader('user_lMdMODARMKBd');
  console.log(`${AUTH_HEADER_NAME}: ${authHeader[AUTH_HEADER_NAME]}`);
  console.log('');

  // 展示 premium 模型列表
  console.log('--- §3: Premium Models (require bypass) ---');
  for (const m of PREMIUM_MODELS) {
    console.log(`  ${m.id.padEnd(32)} ${m.provider.padEnd(12)} $${m.inputCost}/$${m.outputCost} per M tokens`);
  }
  console.log('');

  // 展示免费模型
  console.log('--- §4: Free Models (no bypass needed) ---');
  for (const m of FREE_MODELS) {
    console.log(`  ${m.id.padEnd(32)} ${m.provider.padEnd(14)} $${m.inputCost}/$${m.outputCost} per M tokens`);
  }
  console.log('');

  // 浏览器注入脚本
  console.log('--- §5: Browser Console Bypass Script ---');
  console.log('Copy and paste the following into browser DevTools console:');
  console.log('');
  console.log(BROWSER_BYPASS_SCRIPT);
  console.log('');

  // 实际调用示例
  console.log('--- §6: Usage Examples ---');
  console.log('');

  console.log('// Method 2: Node.js direct API call (requires session cookie)');
  console.log(`await chatCompletion({`);
  console.log(`  sessionCookie: 'YOUR_SESSION_TOKEN',`);
  console.log(`  userId: 'user_lMdMODARMKBd',`);
  console.log(`  model: 'claude-opus-4-6',`);
  console.log(`  sdkType: 'anthropic',`);
  console.log(`  messages: [{ role: 'user', content: 'Hello Claude Opus!' }]`);
  console.log(`});`);
  console.log('');

  console.log('// Method 3: API Key direct call (requires API key)');
  console.log(`await apiKeyChat(`);
  console.log(`  'sk-your-api-key',`);
  console.log(`  'claude-opus-4-6',`);
  console.log(`  [{ role: 'user', content: 'Hello Claude Opus!' }]`);
  console.log(`);`);
  console.log('');

  // 如果提供了参数则执行实际调用
  const args = process.argv.slice(2);
  if (args[0] === '--run' && args[1] && args[2]) {
    console.log('--- §7: Live Test ---');
    const sessionCookie = args[1];
    const model = args[2] || 'claude-opus-4-6';
    const modelInfo = [...PREMIUM_MODELS, ...FREE_MODELS].find(m => m.id === model);

    if (!modelInfo) {
      console.error(`Unknown model: ${model}`);
      process.exit(1);
    }

    console.log(`Testing ${model} via /webapi/chat/${modelInfo.sdkType}...`);
    await chatCompletion({
      sessionCookie,
      userId: args[3] || 'user_lMdMODARMKBd',
      model: modelInfo.id,
      sdkType: modelInfo.sdkType,
      messages: [{ role: 'user', content: 'Say "Premium bypass works!" in one short sentence.' }],
    });
  } else if (args[0] === '--apikey' && args[1] && args[2]) {
    console.log('--- §7: API Key Live Test ---');
    await apiKeyChat(
      args[1],
      args[2] || 'claude-opus-4-6',
      [{ role: 'user', content: 'Say "API key bypass works!" in one short sentence.' }],
    );
  } else {
    console.log('--- §7: Live Test ---');
    console.log('To run a live test:');
    console.log('  node premium_bypass.js --run <session_cookie> <model_id> [user_id]');
    console.log('  node premium_bypass.js --apikey <api_key> <model_id>');
    console.log('');
    console.log('Examples:');
    console.log('  node premium_bypass.js --run eyJhbGciOi... claude-opus-4-6');
    console.log('  node premium_bypass.js --apikey sk-xxx claude-sonnet-4-6');
  }

  console.log('\n=== Done ===');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  xorEncode,
  xorDecode,
  buildAuthHeader,
  chatCompletion,
  apiKeyChat,
  PREMIUM_MODELS,
  FREE_MODELS,
  BROWSER_BYPASS_SCRIPT,
  AUTH_HEADER_NAME,
  XOR_KEY,
};
