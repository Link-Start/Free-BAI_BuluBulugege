import { ethers } from "ethers";
import CryptoJS from "crypto-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import { prisma } from "@/lib/prisma";
import {
  AES_KEY,
  BASE_URL,
  AUTH_URL,
  TRPC_URL,
  BASE_CHAIN,
} from "@/lib/constants";
import type { RegisterResult } from "@/lib/types";
import { StickyProxyPool, type StickyProxy } from "@/lib/services/StickyProxyPool";
import { baseFunder } from "@/lib/services/BaseFunder";

// ========== 代理请求封装 ==========

// BankOfAI 后端强制要求 User-Agent 请求头（缺失会返回 "Missing User-Agent header"）
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function mergeHeadersWithUA(init?: RequestInit): RequestInit {
  const base: Record<string, string> = { "User-Agent": DEFAULT_UA };
  const h = (init?.headers ?? {}) as Record<string, string>;
  // Preserve explicit caller overrides; only add UA if missing
  const merged: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(h)) {
    merged[k] = v as string;
    if (k.toLowerCase() === "user-agent") merged["User-Agent"] = v as string;
  }
  return { ...init, headers: merged };
}

// SOCKS5 代理使用 Node 原生 fetch（支持 http.Agent），HTTP 代理使用 undici
async function fetchWithProxy(url: string, proxyUrl: string, init?: RequestInit) {
  const withUa = mergeHeadersWithUA(init);
  const isSocks = proxyUrl.startsWith("socks5://") || proxyUrl.startsWith("socks://");

  if (isSocks) {
    const agent = new SocksProxyAgent(proxyUrl, { timeout: 15000 });
    try {
      // Node 原生 fetch 支持 agent 选项
      return await globalThis.fetch(url, { ...withUa, agent } as RequestInit & { agent: SocksProxyAgent });
    } finally {
      agent.destroy();
    }
  } else {
    const agent = new ProxyAgent({
      uri: proxyUrl,
      requestTls: { timeout: 15000 },
    });
    try {
      return await undiciFetch(url, { ...withUa, dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1]);
    } finally {
      agent.close().catch(() => {});
    }
  }
}

// ========== 核心复用函数 ==========

export function createWallet() {
  return ethers.Wallet.createRandom();
}

export function buildSignMessage(address: string, nonce: string, chainIdHex = "0x1") {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return `Welcome to BANK OF AI !
chat.bankofai.io wants you to sign in with your account:
${address}

Chain ID: ${chainIdHex}
Expiration Time: ${expiry}
Nonce: ${nonce}`;
}

export function buildClaimMessage(address: string, chainIdHex = "0x1") {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randomStr = "";
  for (let i = 0; i < 6; i++) {
    randomStr += chars[Math.floor(Math.random() * chars.length)];
  }
  const nonce = `${randomStr}${Date.now()}`;
  return {
    message: `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: ${chainIdHex}
Nonce: ${nonce}`,
    nonce,
  };
}

export function forgeToken() {
  const payload = `BANK OF AI welcome gift-claim|${Date.now()}`;
  return CryptoJS.AES.encrypt(payload, AES_KEY).toString();
}

async function getCsrfToken(proxyUrl: string) {
  const res = await fetchWithProxy(`${AUTH_URL}/csrf`, proxyUrl, {
    headers: { Accept: "application/json" },
  });
  const data = (await res.json()) as { csrfToken?: string };
  return {
    csrfToken: data.csrfToken as string,
    cookies: (res.headers.getSetCookie?.() ?? []) as string[],
  };
}

async function loginWithCredentials(
  csrfToken: string,
  csrfCookies: string[],
  address: string,
  signature: string,
  message: string,
  proxyUrl: string
) {
  const formData = new URLSearchParams({
    chain: "eth",
    message,
    signature,
    version: "2",
    csrfToken,
    callbackUrl: `${BASE_URL}/chat`,
  });

  const cookieHeader = csrfCookies.map((c) => c.split(";")[0]).join("; ");

  const res = await fetchWithProxy(`${AUTH_URL}/callback/metamask`, proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Auth-Return-Redirect": "1",
      Accept: "*/*",
      Cookie: cookieHeader,
    },
    body: formData.toString(),
  });

  const setCookies = (res.headers.getSetCookie?.() ?? []) as string[];
  const hasSession = setCookies.some((c) => c.includes("session-token"));

  return {
    status: res.status,
    cookies: setCookies,
    cookieHeader: setCookies.map((c) => c.split(";")[0]).join("; "),
    hasSession,
  };
}

async function claimSignupBonus(
  address: string,
  signature: string,
  message: string,
  cookieHeader: string,
  proxyUrl: string
) {
  const encryptedToken = forgeToken();
  const body = {
    "0": {
      json: {
        address,
        chain: "eth",
        encryptedToken,
        message,
        signature,
        type: "wallet",
        version: "2",
      },
    },
  };

  const res = await fetchWithProxy(`${TRPC_URL}/user.claimSignupBonus?batch=1`, proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Referer: `${BASE_URL}/chat`,
      Origin: BASE_URL,
      Accept: "*/*",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    const result = data[0]?.result?.data?.json;
    const errorMsg = data[0]?.error?.message ?? data[0]?.error?.json?.message;
    if (errorMsg) {
      return { success: false, error: `Claim rejected: ${errorMsg}`, amount: 0, data };
    }
    return {
      success: !!result?.success,
      amount: result?.amount ?? 500000,
      data,
    };
  } catch {
    return { success: false, error: `Claim parse error: ${text.slice(0, 300)}`, amount: 0, data: null };
  }
}

async function createApiKey(name: string, cookieHeader: string, proxyUrl: string) {
  const body = { "0": { json: { name } } };
  const res = await fetchWithProxy(`${TRPC_URL}/apiKey.createApiKey?batch=1`, proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Referer: `${BASE_URL}/chat`,
      Origin: BASE_URL,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    const result = data[0]?.result?.data?.json;
    return { success: !!result, key: result?.key ?? null };
  } catch {
    return { success: false, key: null, error: text.slice(0, 200) };
  }
}

// ========== 两阶段注册 ==========

/**
 * Phase 1: 并行注册（CSRF + Login）
 * 返回登录成功的 wallet + session 信息，不做 claim
 */
export interface Phase1Result {
  success: boolean;
  wallet?: ethers.HDNodeWallet;
  cookieHeader?: string;
  proxySession?: string;
  error?: string;
  step?: string;
}

export async function registerPhase1(proxy: StickyProxy): Promise<Phase1Result> {
  const t0 = Date.now();
  const wallet = createWallet();

  // Fund new wallet on Base so BankOfAI's claimSignupBonus balance-check passes
  if (BASE_CHAIN.enabled) {
    try {
      await baseFunder.fund(wallet.address);
    } catch (e) {
      return {
        success: false,
        step: "fund",
        error: `fund failed: ${e instanceof Error ? e.message : "unknown"} (${Date.now()-t0}ms)`,
      };
    }
  }

  const nonce = ethers.hexlify(ethers.randomBytes(8)).replace("0x", "").toUpperCase();
  const loginMsg = buildSignMessage(wallet.address, nonce, "0x1");
  const loginSig = await wallet.signMessage(loginMsg);

  const csrfResult = await getCsrfToken(proxy.url);
  if (!csrfResult.csrfToken) {
    return { success: false, step: "csrf", error: `Failed to get CSRF token (${Date.now()-t0}ms)` };
  }

  const loginResult = await loginWithCredentials(
    csrfResult.csrfToken,
    csrfResult.cookies,
    wallet.address,
    loginSig,
    loginMsg,
    proxy.url
  );

  if (!loginResult.hasSession) {
    return { success: false, step: "login", error: `No session cookie status=${loginResult.status} (${Date.now()-t0}ms)` };
  }

  return {
    success: true,
    wallet,
    cookieHeader: loginResult.cookieHeader,
    proxySession: proxy.session,
  };
}

/**
 * Phase 2: 串行 Claim + CreateApiKey（用独立 IP，队列排队）
 * 每次调用使用一个新的 claim IP，间隔由调用方控制
 */
export async function registerPhase2(
  wallet: ethers.HDNodeWallet,
  cookieHeader: string,
  claimProxy: StickyProxy
): Promise<RegisterResult> {
  const { message: claimMsg } = buildClaimMessage(wallet.address, "0x1");
  const claimSig = await wallet.signMessage(claimMsg);
  const claimResult = await claimSignupBonus(
    wallet.address,
    claimSig,
    claimMsg,
    cookieHeader,
    claimProxy.url
  );

  if (!claimResult.success) {
    return { success: false, step: "claim", error: claimResult.error ?? "Claim failed" };
  }

  // CreateApiKey 也用同一个 claim IP
  const keyResult = await createApiKey(
    `pool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    cookieHeader,
    claimProxy.url
  );
  if (!keyResult.success || !keyResult.key) {
    return { success: false, step: "createApiKey", error: keyResult.error };
  }

  return {
    success: true,
    address: wallet.address,
    privateKey: wallet.privateKey,
    sessionCookie: cookieHeader,
    apiKey: keyResult.key,
    credits: claimResult.amount || 500000,
    proxy: claimProxy.session,
  };
}

// ========== 完整注册流程（单个，保留兼容）==========

export interface RegisterTiming {
  phase1Ms: number;
  phase2Ms: number;
  totalMs: number;
}

export async function registerOne(proxy: StickyProxy): Promise<RegisterResult> {
  const t0 = Date.now();
  const phase1 = await registerPhase1(proxy);
  const phase1Ms = Date.now() - t0;
  if (!phase1.success || !phase1.wallet || !phase1.cookieHeader) {
    return { success: false, step: phase1.step, error: phase1.error };
  }
  const phase2 = await registerPhase2(phase1.wallet, phase1.cookieHeader, proxy);
  const totalMs = Date.now() - t0;
  // 附加 timing 信息到 proxy 上供调用方记录
  (phase2 as any)._timing = { phase1Ms, phase2Ms: totalMs - phase1Ms, totalMs } satisfies RegisterTiming;
  return phase2;
}

// ========== 持久化到数据库 ==========

export async function saveAccount(result: RegisterResult) {
  return prisma.account.create({
    data: {
      address: result.address!,
      privateKey: result.privateKey!,
      sessionCookie: result.sessionCookie!,
      apiKey: result.apiKey!,
      credits: result.credits ?? 500000,
      proxy: result.proxy,
      status: "ACTIVE",
    },
  });
}

// ========== 两阶段批量注册 ==========

export interface BatchResult {
  success: number;
  failed: number;
  total: number;
  errors: string[];
  timeline?: string[];
}

/**
 * 流水线注册模式
 *
 * Phase 1: 全部并发发出登录，10 秒后不管完没完成直接收割结果
 * Phase 2: 登录成功的全部一次性并发 claim，每个独立 IP
 *
 * 目标：最大化吞吐量，不等慢请求
 */
export async function registerBatchTwoPhase(
  count: number,
  concurrency: number,
  registerPool: StickyProxyPool,
  claimPool: StickyProxyPool,
  _claimDelay: number = 0,
  _claimBatch: number = 70,
  onProgress?: (completed: number, success: number, failed: number, phase: string) => void
): Promise<BatchResult> {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  const t0 = Date.now();
  const timeline: string[] = [];
  const log = (msg: string) => { timeline.push(`${Date.now() - t0}ms ${msg}`); };

  // ===== Phase 1: 全并发登录，10 秒超时 =====
  log(`[register] Phase 1: fire ${count} logins, 10s deadline`);

  const loginPromises: Promise<Phase1Result>[] = [];

  for (let i = 0; i < count; i++) {
    const idx = i;
    const proxy = registerPool.getNext();
    if (!proxy) {
      registerPool.refresh();
      const retry = registerPool.getNext();
      if (!retry) {
        loginPromises.push(Promise.resolve({ success: false, step: "proxy", error: "No proxy" }));
        continue;
      }
      loginPromises.push(registerPhase1(retry).then((r) => {
        log(`[login] #${idx} ${r.success ? "OK" : "FAIL:" + r.error}`);
        return r;
      }).catch((e) => {
        log(`[login] #${idx} ERROR: ${e instanceof Error ? e.message : "unknown"}`);
        return { success: false as const, step: "error", error: e instanceof Error ? e.message : "unknown" };
      }));
    } else {
      loginPromises.push(registerPhase1(proxy).then((r) => {
        log(`[login] #${idx} ${r.success ? "OK" : "FAIL:" + r.error}`);
        return r;
      }).catch((e) => {
        log(`[login] #${idx} ERROR: ${e instanceof Error ? e.message : "unknown"}`);
        return { success: false as const, step: "error", error: e instanceof Error ? e.message : "unknown" };
      }));
    }
  }

  // 10 秒超时：拿到多少算多少
  const PHASE1_TIMEOUT = 10000;
  const settled = await Promise.race([
    Promise.allSettled(loginPromises),
    new Promise<PromiseSettledResult<Phase1Result>[]>((resolve) =>
      setTimeout(async () => {
        // 超时后收割当前已完成的
        const results = await Promise.allSettled(
          loginPromises.map((p) =>
            Promise.race([p, new Promise<Phase1Result>((_, rej) => setTimeout(() => rej(new Error("timeout")), 100))])
          )
        );
        resolve(results);
      }, PHASE1_TIMEOUT)
    ),
  ]);

  const phase1Results: Phase1Result[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      phase1Results.push(r.value);
    } else {
      phase1Results.push({ success: false, step: "timeout", error: "Login timed out" });
    }
  }

  const loginSuccess = phase1Results.filter((r) => r.success && r.wallet && r.cookieHeader);
  const loginFailed = phase1Results.filter((r) => !r.success);

  const t1 = Date.now();
  log(`[register] Phase 1 done in ${((t1 - t0) / 1000).toFixed(1)}s: ${loginSuccess.length} OK, ${loginFailed.length} failed`);

  for (const f of loginFailed) {
    failed++;
    errors.push(`[${f.step}] ${f.error ?? "unknown"}`);
  }
  onProgress?.(failed, success, failed, "login");

  if (loginSuccess.length === 0) {
    log(`[register] No logins succeeded, skipping Phase 2`);
    return { success, failed, total: count, errors };
  }

  // ===== Phase 2: 全并发 Claim =====
  // 所有登录成功的一次性全部并发 claim，每个独立 IP
  log(`[register] Phase 2: fire ${loginSuccess.length} claims (full parallel, each unique IP)`);

  const claimPromises = loginSuccess.map(async (item, idx) => {
    let claimProxy = claimPool.getNext();
    if (!claimProxy) {
      claimPool.refresh();
      claimProxy = claimPool.getNext();
    }
    if (!claimProxy) {
      failed++;
      errors.push("[claim] No claim proxy");
      log(`[claim] #${idx} NO_PROXY`);
      return;
    }

    try {
      const result = await registerPhase2(item.wallet!, item.cookieHeader!, claimProxy);
      if (result.success) {
        await saveAccount(result);
        log(`[claim] #${idx} OK`);
        success++;
      } else {
        // 不重试 already claimed
        if (!result.error?.includes("already claimed")) {
          // 换 IP 重试一次
          const retryProxy = claimPool.getNext();
          if (retryProxy) {
            try {
              const retry = await registerPhase2(item.wallet!, item.cookieHeader!, retryProxy);
              if (retry.success) {
                await saveAccount(retry);
                log(`[claim] #${idx} OK(retry)`);
                success++;
                return;
              }
            } catch { /* fall through */ }
          }
        }
        failed++;
        log(`[claim] #${idx} FAIL: ${result.error?.slice(0, 60)}`);
        errors.push(`[${result.step}] ${result.error ?? "unknown"}`);
      }
    } catch (e) {
      // fetch failed，换 IP 重试
      const retryProxy = claimPool.getNext();
      if (retryProxy) {
        try {
          const retry = await registerPhase2(item.wallet!, item.cookieHeader!, retryProxy);
          if (retry.success) {
            await saveAccount(retry);
            log(`[claim] #${idx} OK(retry)`);
            success++;
            return;
          }
        } catch { /* fall through */ }
      }
      failed++;
      log(`[claim] #${idx} ERROR: ${e instanceof Error ? e.message : "unknown"}`);
      errors.push(`[error] ${e instanceof Error ? e.message : "unknown"}`);
    }
  });

  await Promise.allSettled(claimPromises);

  const t2 = Date.now();
  log(`[register] Done in ${((t2 - t0) / 1000).toFixed(1)}s: ${success}/${count} OK (P1=${((t1 - t0) / 1000).toFixed(1)}s P2=${((t2 - t1) / 1000).toFixed(1)}s)`);

  return { success, failed, total: count, errors, timeline };
}

// ========== 旧接口兼容 ==========
export async function registerBatchWithSticky(
  count: number,
  concurrency: number,
  pool: StickyProxyPool,
  onProgress?: (completed: number, success: number, failed: number) => void
) {
  // 创建第二个 IP 池专门用于 claim，每个 IP 只用一次
  const claimPool = new StickyProxyPool();
  claimPool.setBatchSize(count * 2);
  claimPool.setMaxUsesPerIp(1);

  return registerBatchTwoPhase(
    count,
    concurrency,
    pool,
    claimPool,
    0,     // 无间隔
    70,    // 全并发 claim
    onProgress ? (c, s, f) => onProgress(c, s, f) : undefined
  );
}
