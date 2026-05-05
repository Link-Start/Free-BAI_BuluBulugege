/**
 * Test: replicate the exact successful curl as closely as possible
 * but with a fresh wallet and login
 */
const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const XOR_KEY = 'LobeHub \u00b7 LobeHub';

function buildAuthHeader(userId) {
  const payload = JSON.stringify({ accessCode: '', userId, runtimeProvider: 'openai' });
  const payloadBytes = Buffer.from(payload, 'utf8');
  const keyBytes = Buffer.from(XOR_KEY, 'utf8');
  const xored = Buffer.alloc(payloadBytes.length);
  for (let i = 0; i < payloadBytes.length; i++) {
    xored[i] = payloadBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return xored.toString('base64');
}

function buildSignMessage(address, nonce, chainIdHex = '0x1') {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

async function getCsrfToken() {
  const res = await fetch(`${BASE_URL}/api/auth/csrf`, {
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  return { csrfToken: data.csrfToken, cookies: res.headers.getSetCookie?.() || [] };
}

async function login(csrfToken, csrfCookies, address, signature, message) {
  const formData = new URLSearchParams({
    chain: 'eth', message, signature, version: '2',
    csrfToken, callbackUrl: `${BASE_URL}/chat`
  });
  const cookieHeader = csrfCookies.map(c => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE_URL}/api/auth/callback/metamask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Return-Redirect': '1',
      'Accept': '*/*',
      'Cookie': cookieHeader,
    },
    body: formData.toString()
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  return {
    cookieHeader: setCookies.map(c => c.split(';')[0]).join('; '),
    allCookies: setCookies,
    hasSession: setCookies.some(c => c.includes('session-token')),
    response: await res.text()
  };
}

(async () => {
  const wallet = ethers.Wallet.createRandom();
  console.log('Address:', wallet.address);

  // Login
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x', '').toUpperCase();
  const loginMsg = buildSignMessage(wallet.address, nonce, '0x1');
  const sig = await wallet.signMessage(loginMsg);
  const csrf = await getCsrfToken();
  const loginResult = await login(csrf.csrfToken, csrf.cookies, wallet.address, sig, loginMsg);

  if (!loginResult.hasSession) {
    console.log('Login failed:', loginResult.response);
    return;
  }
  console.log('Login OK');

  // Check session
  const sessRes = await fetch(`${BASE_URL}/api/auth/session`, {
    headers: { 'Accept': 'application/json', 'Cookie': loginResult.cookieHeader }
  });
  const sessionData = await sessRes.json();
  const userId = sessionData.user?.id;
  console.log('Session user:', userId);
  const authHeader = buildAuthHeader(userId);
  console.log('Auth header:', authHeader);

  // Build claim message - EXACT format from successful curl
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) randomStr += chars[Math.floor(Math.random() * chars.length)];
  const claimNonce = randomStr + Date.now();
  const claimMessage = `BANK OF AI welcome gift-claim
Account:
${wallet.address}
Chain ID: 0x1
Nonce: ${claimNonce}`;

  const claimSig = await wallet.signMessage(claimMessage);
  const encToken = CryptoJS.AES.encrypt(`BANK OF AI welcome gift-claim|${Date.now()}`, AES_KEY).toString();

  const body = {
    '0': { json: {
      address: wallet.address,
      chain: 'eth',
      encryptedToken: encToken,
      message: claimMessage,
      signature: claimSig,
      type: 'wallet',
      version: '2'
    }}
  };

  console.log('\nClaim request body (truncated):');
  console.log(JSON.stringify({
    '0': { json: {
      address: wallet.address,
      chain: 'eth',
      encryptedToken: encToken.slice(0, 30) + '...',
      message: claimMessage.split('\n')[0] + '...',
      signature: claimSig.slice(0, 20) + '...',
      type: 'wallet',
      version: '2'
    }}
  }, null, 2));

  // Try claim with x-ainft-chat-auth header
  const res = await fetch(`${BASE_URL}/trpc/lambda/user.claimSignupBonus?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/chat`,
      'Cookie': loginResult.cookieHeader,
      'X-ainft-chat-auth': authHeader,
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log(`\nHTTP ${res.status}: ${text}`);

})();
