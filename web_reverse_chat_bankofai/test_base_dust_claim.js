/**
 * 测试: 从资助钱包给新钱包转 dust，然后用新钱包 claim
 *
 * 用法: node test_base_dust_claim.js
 * 依赖: ethers, crypto-js
 */

const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');

const FUNDER_PK = process.env.FUNDER_PRIVATE_KEY || '';
const DUST_ETH = process.env.DUST_ETH || '0.00000000001'; // 10,000,000 wei
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;

function buildLoginMessage(address) {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  return {
    message: `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: 0x1
Expiration Time: ${expiry}
Nonce: ${nonce}`,
    nonce,
  };
}

function buildClaimMessage(address) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rnd = '';
  for (let i = 0; i < 6; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  const nonce = `${rnd}${Date.now()}`;
  return {
    message: `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: 0x1
Nonce: ${nonce}`,
    nonce,
  };
}

function forgeToken() {
  const payload = `BANK OF AI welcome gift-claim|${Date.now()}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

async function fundWallet(funderWallet, target, amountWei) {
  console.log(`\n[Fund] ${funderWallet.address} → ${target}`);
  console.log(`[Fund] 金额: ${amountWei} wei (${ethers.formatEther(amountWei)} ETH)`);
  const tx = await funderWallet.sendTransaction({ to: target, value: amountWei });
  console.log(`[Fund] tx hash: ${tx.hash}`);
  console.log(`[Fund] 等待 1 个确认...`);
  const receipt = await tx.wait(1);
  console.log(`[Fund] ✅ confirmed at block ${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`);
  return receipt;
}

async function runClaimFlow(wallet) {
  console.log(`\n[Claim] 使用钱包: ${wallet.address}`);

  // 1. 登录消息 + 签名
  const { message: loginMsg } = buildLoginMessage(wallet.address);
  const loginSig = await wallet.signMessage(loginMsg);

  // 2. CSRF
  const csrfRes = await fetch(`${AUTH_URL}/csrf`, { headers: { Accept: 'application/json' } });
  const csrfData = await csrfRes.json();
  const csrfCookies = csrfRes.headers.getSetCookie?.() || [];
  const csrfCookieHeader = csrfCookies.map(c => c.split(';')[0]).join('; ');
  console.log(`[Login] CSRF ok`);

  // 3. 登录
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
    console.log(`[Login] ❌ 无 session cookie`);
    return { success: false, step: 'login' };
  }
  console.log(`[Login] ✅ session cookie ok`);

  // 4. Session 验证
  const sessRes = await fetch(`${AUTH_URL}/session`, {
    headers: { Accept: 'application/json', Cookie: sessionCookie },
  });
  const sessData = await sessRes.json();
  console.log(`[Session] user: ${sessData?.user?.id} / name: ${sessData?.user?.name}`);

  // 5. Claim
  const { message: claimMsg } = buildClaimMessage(wallet.address);
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
  console.log(`[Claim] HTTP ${claimRes.status}`);
  console.log(`[Claim] Response: ${claimText}`);

  if (claimRes.status !== 200) return { success: false, step: 'claim', body: claimText, sessionCookie };

  const claimJson = JSON.parse(claimText);
  const result = claimJson[0]?.result?.data?.json;
  if (!result?.success) return { success: false, step: 'claim', body: claimText, sessionCookie };

  console.log(`[Claim] ✅ 获得 ${result.amount} credits`);

  // 6. Create API Key
  const keyRes = await fetch(`${TRPC_URL}/apiKey.createApiKey?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
      Referer: `${BASE_URL}/chat`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({ '0': { json: { name: 'dust-test' } } }),
  });
  const keyText = await keyRes.text();
  const keyData = JSON.parse(keyText);
  const apiKey = keyData[0]?.result?.data?.json?.key;
  console.log(`[APIKey] ${apiKey || keyText.slice(0, 300)}`);

  return { success: true, credits: result.amount, apiKey, sessionCookie };
}

async function main() {
  console.log('='.repeat(70));
  console.log('Base Dust Claim 测试');
  console.log('='.repeat(70));

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const funder = new ethers.Wallet(FUNDER_PK, provider);
  const funderBal = await provider.getBalance(funder.address);
  console.log(`\n[Funder] ${funder.address}`);
  console.log(`[Funder] Base 余额: ${ethers.formatEther(funderBal)} ETH`);

  // 1. 生成新钱包
  const newWallet = ethers.Wallet.createRandom();
  console.log(`\n[New] address: ${newWallet.address}`);
  console.log(`[New] privateKey: ${newWallet.privateKey}`);

  // 2. 从 funder 转 dust 到 new
  const amountWei = ethers.parseEther(DUST_ETH);
  await fundWallet(funder, newWallet.address, amountWei);

  // 3. 确认新钱包余额
  const newBal = await provider.getBalance(newWallet.address);
  console.log(`[New] Base 余额确认: ${newBal.toString()} wei (${ethers.formatEther(newBal)} ETH)`);

  // 4. 跑 claim 流程（用新钱包签名，没有 provider 参与）
  const plainWallet = new ethers.Wallet(newWallet.privateKey);
  const result = await runClaimFlow(plainWallet);

  console.log('\n' + '='.repeat(70));
  console.log('结果:');
  console.log(JSON.stringify({
    success: result.success,
    address: newWallet.address,
    privateKey: newWallet.privateKey,
    credits: result.credits,
    apiKey: result.apiKey,
    failStep: result.success ? undefined : result.step,
    failBody: result.success ? undefined : result.body,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
