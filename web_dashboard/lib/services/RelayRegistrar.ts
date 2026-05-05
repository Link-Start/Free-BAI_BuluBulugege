/**
 * Relay chain registrar — 链式接力注册机
 *
 * 严格复刻 scripts/batch_relay.mjs 的行为：
 * - 每批 fresh provider + fresh nonce (从 getTransactionCount pending 拿)
 * - Funder 串行 fund N seed
 * - 100 条链 Promise.all 并发跑 H 跳
 * - claim fail 不退避（只在"Too many/IP limit/already claimed"时立刻 return）
 * - relay 失败时等 3s 再重试
 * - 外层 daemon 循环：跑完一批看是否达标，不达标立刻开下一批
 */

import { ethers } from "ethers";
import CryptoJS from "crypto-js";
import { SocksProxyAgent } from "socks-proxy-agent";
import https from "https";
import { prisma } from "@/lib/prisma";
import { AES_KEY, BASE_URL, AUTH_URL, TRPC_URL, BASE_CHAIN, KOOKEEY } from "@/lib/constants";

// ============== Config ==============

const RPC_URL = process.env.RELAY_RPC ?? "https://base-mainnet.public.blastapi.io";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_FEE = 7_500_000n;
const PRIO_FEE = 1_000_000n;
// Use 50% extra buffer so ethers preflight always passes; actual onchain cost still only baseFee+prio
const GAS_RESERVE = 21000n * MAX_FEE * 3n / 2n; // = 2.36e11 wei

const CHAINS_PER_BATCH = parseInt(process.env.RELAY_CONCURRENCY ?? "100");
const HOPS_PER_CHAIN = parseInt(process.env.RELAY_HOPS ?? "3");
// seed needs to survive H-1 relays with reserve each, plus a tiny buffer
const SEED_WEI = GAS_RESERVE * BigInt(HOPS_PER_CHAIN) + BigInt(HOPS_PER_CHAIN);

// ============== Proxy ==============

interface ProxyCreds { host: string; port: string; user: string; pass: string }
// Pool of creds: kookeey returns 100 lines — use them round-robin so each chain
// gets a different session (batch_relay.mjs achieved variety because it only
// asked for n=1 per batch and re-fetched each time; here we fetch 100 once per batch)
let proxyPool: ProxyCreds[] = [];
let proxyIdx = 0;

async function loadProxyPool() {
  if (!KOOKEEY.enabled) throw new Error("KOOKEEY_EXTRACT_URL not set");
  // Avoid Next.js' Data Cache: append a cachebuster + use no-store
  const url = KOOKEEY.extractUrl + (KOOKEEY.extractUrl.includes("?") ? "&" : "?") + "_t=" + Date.now();
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("kookeey returned empty");
  proxyPool = lines.map((line) => {
    const parts = line.split(":");
    return { host: parts[0], port: parts[1], user: parts[2], pass: parts[3] };
  });
  proxyIdx = 0;
}

// Backward-compat: single-creds pointer for logging / last-used
let proxyCreds: ProxyCreds | null = null;

function nextCreds(): ProxyCreds {
  if (proxyPool.length === 0) throw new Error("proxy pool empty");
  const c = proxyPool[proxyIdx % proxyPool.length];
  proxyIdx++;
  proxyCreds = c;
  return c;
}

function newProxyAgent(): SocksProxyAgent {
  const { host, port, user, pass } = nextCreds();
  const url = `socks5://${user}:${pass}@${host}:${port}`;
  return new SocksProxyAgent(url, { timeout: 20000 });
}

// ============== HTTPS req ==============

interface RespLike {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function req(url: string, agent: SocksProxyAgent, opts: { method?: string; headers?: Record<string, string | number>; body?: string }): Promise<RespLike> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      {
        method: opts.method ?? "GET",
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers: { "User-Agent": UA, ...(opts.headers ?? {}) },
        agent,
        timeout: 30000,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () =>
          resolve({
            status: resp.statusCode ?? 0,
            headers: resp.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("req timeout")); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ============== Sign + Claim ==============

function buildLoginMsg(addr: string): string {
  const expiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace("0x", "").toUpperCase();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${addr}

Chain ID: 0x1
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

function buildClaimMsg(addr: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let r = "";
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return `BANK OF AI welcome gift-claim
Account:
${addr}
Chain ID: 0x1
Nonce: ${r}${Date.now()}`;
}

function forgeToken(): string {
  return CryptoJS.AES.encrypt(`BANK OF AI welcome gift-claim|${Date.now()}`, AES_KEY).toString();
}

type ClaimResult = { success: true; apiKey: string } | { success: false; step: string; error: string };

async function fullClaim(signer: ethers.HDNodeWallet | ethers.Wallet): Promise<ClaimResult> {
  const address = signer.address;
  const agent = newProxyAgent();
  try {
    const loginMsg = buildLoginMsg(address);
    const loginSig = await signer.signMessage(loginMsg);

    const csrfRes = await req(`${AUTH_URL}/csrf`, agent, { headers: { Accept: "application/json" } });
    const csrfData = JSON.parse(csrfRes.body) as { csrfToken?: string };
    const sc = csrfRes.headers["set-cookie"] ?? [];
    const csrfCookies = Array.isArray(sc) ? sc : [sc as string];
    const csrfCookieHeader = csrfCookies.map((c) => (c as string).split(";")[0]).join("; ");

    const loginBody = new URLSearchParams({
      chain: "eth",
      message: loginMsg,
      signature: loginSig,
      version: "2",
      csrfToken: csrfData.csrfToken ?? "",
      callbackUrl: `${BASE_URL}/chat`,
    }).toString();
    const loginRes = await req(`${AUTH_URL}/callback/metamask`, agent, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Auth-Return-Redirect": "1",
        Accept: "*/*",
        Cookie: csrfCookieHeader,
        "Content-Length": Buffer.byteLength(loginBody),
      },
      body: loginBody,
    });
    const sSc = loginRes.headers["set-cookie"] ?? [];
    const sessionCookies = Array.isArray(sSc) ? sSc : [sSc as string];
    const sessionCookie = sessionCookies.map((c) => (c as string).split(";")[0]).join("; ");
    if (!sessionCookie.includes("session-token")) {
      return { success: false, step: "login", error: `no session (status=${loginRes.status})` };
    }

    const claimMsg = buildClaimMsg(address);
    const claimSig = await signer.signMessage(claimMsg);
    const claimBody = JSON.stringify({
      "0": {
        json: {
          address,
          chain: "eth",
          encryptedToken: forgeToken(),
          message: claimMsg,
          signature: claimSig,
          type: "wallet",
          version: "2",
        },
      },
    });
    const claimRes = await req(`${TRPC_URL}/user.claimSignupBonus?batch=1`, agent, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
        Referer: `${BASE_URL}/chat`,
        Origin: BASE_URL,
        Accept: "*/*",
        "Content-Length": Buffer.byteLength(claimBody),
      },
      body: claimBody,
    });
    if (claimRes.status !== 200) {
      return { success: false, step: "claim", error: claimRes.body.slice(0, 200) };
    }
    const cd = JSON.parse(claimRes.body) as Array<{
      result?: { data?: { json?: { success?: boolean; amount?: number } } };
      error?: { json?: { message?: string }; message?: string };
    }>;
    if (cd[0]?.error) {
      return { success: false, step: "claim", error: cd[0].error.json?.message ?? cd[0].error.message ?? "claim error" };
    }
    if (!cd[0]?.result?.data?.json?.success) {
      return { success: false, step: "claim", error: "claim non-success" };
    }

    // create API key
    const keyBody = JSON.stringify({ "0": { json: { name: `relay-${Date.now()}` } } });
    const keyRes = await req(`${TRPC_URL}/apiKey.createApiKey?batch=1`, agent, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
        Referer: `${BASE_URL}/chat`,
        Origin: BASE_URL,
        "Content-Length": Buffer.byteLength(keyBody),
      },
      body: keyBody,
    });
    const kd = JSON.parse(keyRes.body) as Array<{ result?: { data?: { json?: { key?: string } } } }>;
    const apiKey = kd[0]?.result?.data?.json?.key;
    if (!apiKey) return { success: false, step: "createApiKey", error: keyRes.body.slice(0, 200) };

    return { success: true, apiKey };
  } finally {
    try { agent.destroy(); } catch {}
  }
}

async function claimWithRetry(signer: ethers.HDNodeWallet | ethers.Wallet, maxRetries = 3): Promise<ClaimResult> {
  let lastErr: string | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fullClaim(signer);
      if (r.success) return r;
      // Rejected (not network) — don't retry
      if (r.step === "claim" && (/Too many|IP limit|already claimed/.test(r.error))) {
        return r;
      }
      lastErr = r.error;
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : "unknown";
    }
  }
  return { success: false, step: "network", error: lastErr ?? "unknown" };
}

// ============== Relay ==============

async function relay(provider: ethers.JsonRpcProvider, from: ethers.HDNodeWallet | ethers.Wallet, toAddress: string): Promise<{ success: true; hash: string } | { success: false; error: string }> {
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bal = await provider.getBalance(from.address);
    if (bal <= GAS_RESERVE + 1n) {
      return { success: false, error: `balance ${bal} <= reserve ${GAS_RESERVE}` };
    }
    try {
      const tx = await from.sendTransaction({
        to: toAddress,
        value: bal - GAS_RESERVE - 1n,
        gasLimit: 21000n,
        maxFeePerGas: MAX_FEE,
        maxPriorityFeePerGas: PRIO_FEE,
      });
      await tx.wait(1);
      return { success: true, hash: tx.hash };
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string };
      lastErr = err.shortMessage ?? err.message ?? "unknown";
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { success: false, error: lastErr ?? "exhausted" };
}

// ============== Runner ==============

interface RelayStats {
  running: boolean;
  target: number;
  produced: number;
  failed: number;
  hopsCompleted: number;
  batches: number;
  funderSpent: string;
  startedAt: Date | null;
  lastKeyAt: Date | null;
}

class RelayRegistrar {
  private running = false;
  private stop = false;
  private stats: RelayStats = this.emptyStats();
  private funderStartBal = 0n;

  private emptyStats(): RelayStats {
    return {
      running: false,
      target: 0,
      produced: 0,
      failed: 0,
      hopsCompleted: 0,
      batches: 0,
      funderSpent: "0",
      startedAt: null,
      lastKeyAt: null,
    };
  }

  getStats(): RelayStats {
    return { ...this.stats };
  }

  async start(target: number): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: false, message: "already running" };
    if (!BASE_CHAIN.enabled) return { ok: false, message: "FUNDER_PRIVATE_KEY not configured" };
    if (!KOOKEEY.enabled) return { ok: false, message: "KOOKEEY_EXTRACT_URL not configured" };

    this.running = true;
    this.stop = false;
    this.stats = { ...this.emptyStats(), running: true, target, startedAt: new Date() };

    // Snapshot funder balance at start using a fresh provider
    const tmpProvider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 50, batchStallTime: 50 });
    const tmpFunder = new ethers.Wallet(BASE_CHAIN.funderPrivateKey, tmpProvider);
    this.funderStartBal = await tmpProvider.getBalance(tmpFunder.address);

    void this.loop();
    return { ok: true, message: `started, target=${target}` };
  }

  async stopNow(): Promise<void> {
    this.stop = true;
    this.running = false;
    this.stats.running = false;
  }

  private async loop() {
    try {
      while (!this.stop && this.stats.produced < this.stats.target) {
        this.stats.batches++;
        try {
          await this.runOneBatch();
        } catch (e) {
          console.error("[relay] batch error:", e instanceof Error ? e.message : e);
          // Continue next batch
          await new Promise((r) => setTimeout(r, 3000));
        }

        // Update funder spent after each batch (fresh provider)
        try {
          const p = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 50, batchStallTime: 50 });
          const cur = await p.getBalance(new ethers.Wallet(BASE_CHAIN.funderPrivateKey).address);
          this.stats.funderSpent = (this.funderStartBal - cur).toString();
        } catch { /* ignore */ }
      }
    } finally {
      this.running = false;
      this.stats.running = false;
    }
  }

  private async runOneBatch() {
    // FRESH everything per batch — exact copy of batch_relay.mjs main()
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 50, batchStallTime: 50 });
    const funder = new ethers.Wallet(BASE_CHAIN.funderPrivateKey, provider);
    const balBefore = await provider.getBalance(funder.address);

    const totalNeed = SEED_WEI * BigInt(CHAINS_PER_BATCH) + 21000n * MAX_FEE * BigInt(CHAINS_PER_BATCH);
    if (balBefore < totalNeed) {
      throw new Error(`insufficient funder balance: need ${totalNeed} have ${balBefore}`);
    }

    await loadProxyPool();

    // 1. Fund N seeds serially (nonce order) with rate-limit aware retry
    const seeds: ethers.HDNodeWallet[] = [];
    const startNonce = await provider.getTransactionCount(funder.address, "pending");
    const fundTxs: ethers.TransactionResponse[] = [];
    for (let i = 0; i < CHAINS_PER_BATCH; i++) {
      if (this.stop || this.stats.produced >= this.stats.target) return;
      const w = ethers.Wallet.createRandom().connect(provider);
      seeds.push(w);

      let tx: ethers.TransactionResponse | null = null;
      let attempt = 0;
      while (!tx && attempt < 5) {
        try {
          tx = await funder.sendTransaction({
            to: w.address,
            value: SEED_WEI,
            gasLimit: 21000n,
            maxFeePerGas: MAX_FEE,
            maxPriorityFeePerGas: PRIO_FEE,
            nonce: startNonce + i,
          });
        } catch (e: unknown) {
          attempt++;
          const err = e as { error?: { message?: string }; shortMessage?: string; message?: string };
          const msg = err.error?.message ?? err.shortMessage ?? err.message ?? "";
          if (msg.includes("rate limit") || msg.includes("-32016")) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          } else {
            throw e;
          }
        }
      }
      if (!tx) throw new Error(`fund tx ${i+1} failed after retries`);
      fundTxs.push(tx);
    }

    // Wait last fund tx confirm
    await fundTxs[fundTxs.length - 1].wait(1);

    // 2. Run all chains in parallel
    await Promise.all(seeds.map((seed) => this.runChain(seed, provider)));
  }

  private async runChain(seed: ethers.HDNodeWallet, provider: ethers.JsonRpcProvider) {
    let current: ethers.HDNodeWallet | ethers.Wallet = seed;
    for (let hop = 0; hop < HOPS_PER_CHAIN; hop++) {
      if (this.stop || this.stats.produced >= this.stats.target) return;

      const r = await claimWithRetry(current, 3);
      if (r.success) {
        this.stats.produced++;
        this.stats.hopsCompleted++;
        this.stats.lastKeyAt = new Date();
        try {
          await prisma.account.create({
            data: {
              address: current.address,
              privateKey: current.privateKey,
              sessionCookie: "",
              apiKey: r.apiKey,
              credits: 500000,
              proxy: proxyCreds ? `${proxyCreds.host}:${proxyCreds.port}` : null,
              status: "ACTIVE",
            },
          });
        } catch (e) {
          console.error("[relay] save failed:", e instanceof Error ? e.message : e);
        }
      } else {
        this.stats.failed++;
      }

      // last hop — stop
      if (hop === HOPS_PER_CHAIN - 1) break;

      // Relay to next (always, even if claim failed)
      const next = ethers.Wallet.createRandom().connect(provider);
      const rel = await relay(provider, current, next.address);
      if (!rel.success) break;
      current = next;
    }
  }
}

export const relayRegistrar = new RelayRegistrar();
