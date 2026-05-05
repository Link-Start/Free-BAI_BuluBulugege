/**
 * 用一个 kookeey socks5 代理 IP 验证完整 fund + claim + key 流程
 * 使用 node:https + socks-proxy-agent（直接做 http Agent）
 * 用法: node test_proxy_one.js
 */
const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const { URL } = require('url');

const FUNDER_PK = process.env.FUNDER_PRIVATE_KEY || '';
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const DUST_ETH = process.env.DUST_ETH || '0.00000000001';
const AES_KEY = '1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=';
const BASE_URL = process.env.BANKOFAI_URL || 'https://chat.bankofai.io';
const TRPC_URL = `${BASE_URL}/trpc/lambda`;
const AUTH_URL = `${BASE_URL}/api/auth`;
const KOOKEEY_API = process.env.KOOKEEY_EXTRACT_URL || '';

async function fetchProxies() {
  const r = await fetch(KOOKEEY_API);
  const text = await r.text();
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
    const [host, port, user, pass] = line.split(':');
    return `socks5://${user}:${pass}@${host}:${port}`;
  });
}

// HTTPS request through socks agent → returns { status, headers, setCookies, body }
function httpsRequest(urlStr, { method = 'GET', headers = {}, body, agent }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
      agent,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookies: res.headers['set-cookie'] || [],
          body: buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildLoginMsg(addr) {
  const expiry = new Date(Date.now() + 24*3600*1000).toISOString();
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace('0x','').toUpperCase();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${addr}

Chain ID: 0x1
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}
function buildClaimMsg(addr) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let r=''; for(let i=0;i<6;i++) r+=chars[Math.floor(Math.random()*chars.length)];
  return `BANK OF AI welcome gift-claim
Account:
${addr}
Chain ID: 0x1
Nonce: ${r}${Date.now()}`;
}
function forgeToken(){
  return CryptoJS.AES.encrypt(`BANK OF AI welcome gift-claim|${Date.now()}`, AES_KEY).toString();
}

async function main() {
  console.log('1. fetching proxies...');
  const proxies = await fetchProxies();
  console.log(`   got ${proxies.length} proxies`);
  const proxy = proxies[0];
  console.log(`   proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);
  const agent = new SocksProxyAgent(proxy);

  console.log('\n2. checking outbound IP via proxy...');
  try {
    const r = await httpsRequest('https://api.ipify.org/?format=json', { agent });
    console.log('   outbound IP:', r.body);
  } catch (e) { console.log('   ip check failed:', e.message); return; }

  console.log('\n3. fund new wallet on Base (via local network)...');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const funder = new ethers.Wallet(FUNDER_PK, provider);
  const newWallet = ethers.Wallet.createRandom();
  console.log('   new addr:', newWallet.address);
  const tx = await funder.sendTransaction({ to: newWallet.address, value: ethers.parseEther(DUST_ETH) });
  console.log('   tx:', tx.hash);
  await tx.wait(1);
  console.log('   confirmed');

  console.log('\n4. login via proxy...');
  const loginMsg = buildLoginMsg(newWallet.address);
  const loginSig = await newWallet.signMessage(loginMsg);
  const csrfRes = await httpsRequest(`${AUTH_URL}/csrf`, { agent, headers:{Accept:'application/json'} });
  const csrfData = JSON.parse(csrfRes.body);
  const csrfCookieHeader = csrfRes.setCookies.map(c=>c.split(';')[0]).join('; ');
  console.log('   csrfToken:', csrfData.csrfToken?.slice(0,20)+'...');

  const loginBody = new URLSearchParams({chain:'eth', message:loginMsg, signature:loginSig, version:'2', csrfToken:csrfData.csrfToken, callbackUrl:`${BASE_URL}/chat`}).toString();
  const loginRes = await httpsRequest(`${AUTH_URL}/callback/metamask`, {
    agent, method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Auth-Return-Redirect':'1',Accept:'*/*',Cookie:csrfCookieHeader,'Content-Length':Buffer.byteLength(loginBody)},
    body: loginBody,
  });
  const sessionCookie = loginRes.setCookies.map(c=>c.split(';')[0]).join('; ');
  if (!loginRes.setCookies.some(c=>c.includes('session-token'))) {
    console.log('   ❌ no session cookie. body:', loginRes.body.slice(0,300));
    return;
  }
  console.log('   ✅ session cookie obtained');

  console.log('\n5. claim signup bonus via proxy...');
  const claimMsg = buildClaimMsg(newWallet.address);
  const claimSig = await newWallet.signMessage(claimMsg);
  const claimBody = JSON.stringify({'0':{json:{address:newWallet.address, chain:'eth', encryptedToken:forgeToken(), message:claimMsg, signature:claimSig, type:'wallet', version:'2'}}});
  const claimRes = await httpsRequest(`${TRPC_URL}/user.claimSignupBonus?batch=1`, {
    agent, method:'POST',
    headers:{'Content-Type':'application/json',Cookie:sessionCookie,Referer:`${BASE_URL}/chat`,Origin:BASE_URL,Accept:'*/*','Content-Length':Buffer.byteLength(claimBody)},
    body: claimBody,
  });
  console.log('   HTTP', claimRes.status, claimRes.body.slice(0,300));
  if (claimRes.status !== 200) return;

  console.log('\n6. create api key via proxy...');
  const keyBody = JSON.stringify({'0':{json:{name:'proxy-test'}}});
  const keyRes = await httpsRequest(`${TRPC_URL}/apiKey.createApiKey?batch=1`, {
    agent, method:'POST',
    headers:{'Content-Type':'application/json',Cookie:sessionCookie,Referer:`${BASE_URL}/chat`,Origin:BASE_URL,'Content-Length':Buffer.byteLength(keyBody)},
    body: keyBody,
  });
  const apiKey = JSON.parse(keyRes.body)[0]?.result?.data?.json?.key;
  console.log('   ✅ apiKey:', apiKey);

  console.log('\n' + '='.repeat(60));
  console.log('RESULT:');
  console.log(JSON.stringify({address:newWallet.address, privateKey:newWallet.privateKey, apiKey, fundTx:tx.hash}, null, 2));
}
main().catch(e=>{console.error(e); process.exit(1);});
