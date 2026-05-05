/**
 * Test TRON chain claim flow — replicate the exact successful curl
 *
 * TRON differences from ETH:
 * - Address starts with T (base58check encoded)
 * - Chain ID: 0x2b6653dc (TRON mainnet)
 * - Login provider: tronlink (not metamask)
 * - Signing: TronWeb (not ethers.js personal_sign)
 * - Login message: SIWE format with hostname
 * - Claim message: "BANK OF AI welcome gift-claim\nAccount:\n{address}\nChain ID: 0x2b6653dc\nNonce: {nonce}"
 */

const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');
const CryptoJS = require('crypto-js');

const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = 'https://chat.bankofai.io';
const AUTH_URL = 'https://chat.ainft.com'; // TRON auth redirects here
const CHAIN_ID = '0x2b6653dc'; // TRON mainnet
const CHAIN = 'tron';

// ============================================================
// §1 TRON wallet generation
// ============================================================

function createTronWallet() {
  // Generate random private key with ethers, convert to TRON address
  const wallet = ethers.Wallet.createRandom();
  const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: wallet.privateKey.slice(2), // Remove 0x prefix for TronWeb
  });
  const address = tronWeb.address.fromPrivateKey(wallet.privateKey.slice(2));
  console.log(`[Wallet] ETH Address: ${wallet.address}`);
  console.log(`[Wallet] TRON Address: ${address}`);
  console.log(`[Wallet] PrivateKey: ${wallet.privateKey.slice(0, 20)}...`);
  return { privateKey: wallet.privateKey, address, tronWeb };
}

// ============================================================
// §2 TRON signing
// ============================================================

async function signTronMessage(tronWeb, privateKey, message) {
  // TRON signing: convert message to hex, hash with SHA3 (keccak256), then sign
  const hexMessage = '0x' + Buffer.from(message, 'utf8').toString('hex');
  const hash = ethers.keccak256(hexMessage);
  const signature = await tronWeb.trx.sign(hash.slice(2));
  return signature;
}

// ============================================================
// §3 Message builders
// ============================================================

function buildLoginMessage(address, nonce) {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  // Exact TRON login message format from captured curl
  return `Welcome to BANK OF AI !
https://chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: ${CHAIN_ID}
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

function buildClaimMessage(address) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) randomStr += chars[Math.floor(Math.random() * chars.length)];
  const nonce = `${randomStr}${Date.now()}`;
  return `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: ${CHAIN_ID}
Nonce: ${nonce}`;
}

// ============================================================
// §4 AES token
// ============================================================

function forgeToken() {
  return CryptoJS.AES.encrypt(`${CHAIN}|${Date.now()}`, AES_KEY).toString();
}

// ============================================================
// §5 Auth flow (same as ETH but tronlink provider)
// ============================================================

async function getCsrfToken() {
  const res = await fetch(`${BASE_URL}/api/auth/csrf`, {
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  return { csrfToken: data.csrfToken, cookies: res.headers.getSetCookie?.() || [] };
}

async function login(csrfToken, csrfCookies, address, signature, message) {
  const formData = new URLSearchParams({
    chain: CHAIN, message, signature, version: '2',
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

async function verifySession(cookieHeader) {
  const res = await fetch(`${BASE_URL}/api/auth/session`, {
    headers: { 'Accept': 'application/json', 'Cookie': cookieHeader }
  });
  const data = await res.json();
  console.log(`[Session] User: ${JSON.stringify(data)?.slice(0, 200)}`);
  return data;
}

// ============================================================
// §6 Claim
// ============================================================

async function claimSignupBonus(address, signature, message, cookieHeader) {
  const encryptedToken = forgeToken();

  const body = {
    '0': { json: {
      address,
      chain: CHAIN,
      encryptedToken,
      message,
      signature,
      type: 'wallet',
      version: '2'
    }}
  };

  console.log(`[Claim] Address: ${address}`);
  console.log(`[Claim] Chain: ${CHAIN}`);
  console.log(`[Claim] Message: ${message.split('\n')[0]}...`);
  console.log(`[Claim] EncryptedToken: ${encryptedToken.slice(0, 30)}...`);

  const res = await fetch(`${BASE_URL}/trpc/lambda/user.claimSignupBonus?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/chat`,
      'Cookie': cookieHeader,
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log(`[Claim] HTTP ${res.status}: ${text.slice(0, 500)}`);

  try {
    const data = JSON.parse(text);
    const result = data[0]?.result?.data?.json;
    return { success: !!result?.success, amount: result?.amount, data };
  } catch {
    return { success: false, error: text.slice(0, 300) };
  }
}

// ============================================================
// §7 Main
// ============================================================

(async () => {
  console.log('=== TRON Chain Claim Test ===\n');

  // Step 1: Generate TRON wallet
  console.log('[1] Generating TRON wallet...');
  const wallet = createTronWallet();

  // Step 2: Sign login message
  console.log('\n[2] Signing login message...');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) randomStr += chars[Math.floor(Math.random() * chars.length)];
  const nonce = `${randomStr}${Date.now()}`;
  const loginMsg = buildLoginMessage(wallet.address, nonce);
  const loginSig = await signTronMessage(wallet.tronWeb, wallet.privateKey, loginMsg);
  console.log(`[2] Login signature: ${loginSig.slice(0, 40)}...`);

  // Step 3: Get CSRF
  console.log('\n[3] Getting CSRF token...');
  const csrf = await getCsrfToken();
  console.log(`[3] CSRF: ${csrf.csrfToken?.slice(0, 20)}...`);

  // Step 4: Login
  console.log('\n[4] Logging in...');
  const loginResult = await login(csrf.csrfToken, csrf.cookies, wallet.address, loginSig, loginMsg);
  console.log(`[4] Login response: ${loginResult.response.slice(0, 200)}`);

  if (!loginResult.hasSession) {
    console.log('\n[FAIL] Login failed — no session cookie');
    return;
  }
  console.log('[4] Login OK — session cookie received');

  // Step 5: Verify session
  console.log('\n[5] Verifying session...');
  await verifySession(loginResult.cookieHeader);

  // Step 6: Sign claim message
  console.log('\n[6] Signing claim message...');
  const claimMsg = buildClaimMessage(wallet.address);
  const claimSig = await signTronMessage(wallet.tronWeb, wallet.privateKey, claimMsg);
  console.log(`[6] Claim signature: ${claimSig.slice(0, 40)}...`);

  // Step 7: Claim bonus
  console.log('\n[7] Claiming signup bonus...');
  const claimResult = await claimSignupBonus(
    wallet.address, claimSig, claimMsg, loginResult.cookieHeader
  );

  if (claimResult.success) {
    console.log(`\n[SUCCESS] Claimed ${claimResult.amount} credits!`);
  } else {
    console.log(`\n[FAIL] Claim failed: ${claimResult.error}`);
  }
})();
