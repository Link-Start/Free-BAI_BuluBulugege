/**
 * 自动补号 —— 双模式流水线
 *
 * CloudBypass 模式：
 * - 每 10 秒发一批 login（session IP），不等完成
 * - login 成功的进 claim 队列，每秒消费
 *
 * Siyetian 模式：
 * - 每 10 秒从 siyetian API 提取一批 IP
 * - 每个 IP 做完整注册（CSRF→Login→Claim→CreateApiKey）
 * - 不等上一批完成，10 秒后直接提取下一批
 */

import { registerPhase1, registerPhase2, registerOne, saveAccount, type Phase1Result } from "./BankOfAIService";
import { StickyProxyPool, stickyProxyPool } from "./StickyProxyPool";
import { proxyPoolService } from "./ProxyPoolService";
import { CLOUDBYPASS, KOOKEEY } from "@/lib/constants";

export interface AutoFillStats {
  running: boolean;
  stats: {
    success: number;
    failed: number;
    ipRetired: number;
    batches: number;
  };
  mode?: string;
}

// 详细错误分类统计
interface ErrorBreakdown {
  csrf_timeout: number;
  csrf_fail: number;
  login_fail: number;
  login_timeout: number;
  claim_fail: number;
  claim_already: number;
  createApiKey_fail: number;
  proxy_error: number;
  unknown: number;
}

interface Timings {
  totalRegistrations: number;
  avgPhase1Ms: number;
  avgPhase2Ms: number;
  avgFetchProxiesMs: number;
  lastBatchDurationMs: number;
  pendingRegistrations: number;
}

interface AutoFillConfig {
  concurrency: number;
  maxRetriesPerIp: number;
  maxIpsPerBatch: number;
  remoteUrl?: string;
  forceMode?: "cloudbypass" | "siyetian" | "kookeey";
}

class AutoFillWorker {
  private running = false;
  private stats = { success: 0, failed: 0, ipRetired: 0, batches: 0, fired: 0, fetched: 0 };
  private config: AutoFillConfig = { concurrency: 50, maxRetriesPerIp: 2, maxIpsPerBatch: 50 };
  private abortController: AbortController | null = null;
  private mode: "cloudbypass" | "siyetian" | "kookeey" = "cloudbypass";

  // 详细错误统计
  private errorBreakdown: ErrorBreakdown = {
    csrf_timeout: 0, csrf_fail: 0, login_fail: 0, login_timeout: 0,
    claim_fail: 0, claim_already: 0, createApiKey_fail: 0, proxy_error: 0, unknown: 0,
  };

  // 性能计时
  private timings: Timings = {
    totalRegistrations: 0, avgPhase1Ms: 0, avgPhase2Ms: 0,
    avgFetchProxiesMs: 0, lastBatchDurationMs: 0, pendingRegistrations: 0,
  };
  private phase1Times: number[] = [];
  private phase2Times: number[] = [];
  private fetchTimes: number[] = [];

  // CloudBypass claim 队列
  private claimQueue: Phase1Result[] = [];
  private claimPool: StickyProxyPool | null = null;

  getStats(): AutoFillStats & { debug?: string; errors?: ErrorBreakdown; timings?: Timings } {
    return {
      running: this.running,
      stats: { ...this.stats },
      mode: this.mode,
      debug: proxyPoolService.lastFetchDebug,
      errors: { ...this.errorBreakdown },
      timings: { ...this.timings },
    };
  }

  async start(config: AutoFillConfig): Promise<void> {
    if (this.running) return;
    this.config = config;
    this.running = true;
    this.stats = { success: 0, failed: 0, ipRetired: 0, batches: 0, fired: 0, fetched: 0 };
    this.errorBreakdown = {
      csrf_timeout: 0, csrf_fail: 0, login_fail: 0, login_timeout: 0,
      claim_fail: 0, claim_already: 0, createApiKey_fail: 0, proxy_error: 0, unknown: 0,
    };
    this.timings = {
      totalRegistrations: 0, avgPhase1Ms: 0, avgPhase2Ms: 0,
      avgFetchProxiesMs: 0, lastBatchDurationMs: 0, pendingRegistrations: 0,
    };
    this.phase1Times = [];
    this.phase2Times = [];
    this.fetchTimes = [];
    this.abortController = new AbortController();
    this.claimQueue = [];

    // 根据 forceMode 或代理配置选择模式
    if (config.forceMode === "kookeey" || (!config.forceMode && KOOKEEY.enabled)) {
      this.mode = "kookeey";
      this.runKookeeyPipeline();
    } else if (config.forceMode === "siyetian") {
      this.mode = "siyetian";
      this.runSiyetianPipeline();
    } else if (config.forceMode === "cloudbypass" || CLOUDBYPASS.enabled) {
      this.mode = "cloudbypass";
      this.claimPool = new StickyProxyPool();
      this.claimPool.setBatchSize(200);
      this.claimPool.setMaxUsesPerIp(1);
      stickyProxyPool.setMaxUsesPerIp(config.maxRetriesPerIp);
      stickyProxyPool.setBatchSize(config.concurrency);
      this.runCloudBypassLoginPipeline();
      this.runCloudBypassClaimPipeline();
    } else {
      this.mode = "siyetian";
      this.runSiyetianPipeline();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
  }

  // ========== CloudBypass 模式（同之前）==========

  private async runCloudBypassLoginPipeline() {
    while (this.running && !this.abortController?.signal.aborted) {
      this.stats.batches++;
      const count = this.config.concurrency;
      for (let i = 0; i < count; i++) {
        if (!this.running) break;
        const proxy = stickyProxyPool.getNext();
        if (!proxy) {
          stickyProxyPool.refresh();
          const retry = stickyProxyPool.getNext();
          if (!retry) continue;
          this.fireCloudBypassLogin(retry);
        } else {
          this.fireCloudBypassLogin(proxy);
        }
      }
      if (this.running) await new Promise((r) => setTimeout(r, 10000));
    }
  }

  private fireCloudBypassLogin(proxy: { url: string; session: string; usedCount: number; isActive: boolean; failCount: number; createdAt: Date }) {
    registerPhase1(proxy)
      .then((result) => {
        if (result.success && result.wallet && result.cookieHeader) {
          this.claimQueue.push(result);
        } else {
          this.stats.failed++;
          this.stats.ipRetired++;
        }
      })
      .catch(() => {
        this.stats.failed++;
        this.stats.ipRetired++;
      });
  }

  private async runCloudBypassClaimPipeline() {
    while (this.running && !this.abortController?.signal.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      const batch = this.claimQueue.splice(0);
      if (batch.length === 0) continue;
      for (const item of batch) {
        if (!this.running) break;
        this.fireCloudBypassClaim(item);
      }
    }
  }

  private fireCloudBypassClaim(item: Phase1Result) {
    if (!this.claimPool) return;
    let proxy = this.claimPool.getNext();
    if (!proxy) { this.claimPool.refresh(); proxy = this.claimPool.getNext(); }
    if (!proxy) { this.stats.failed++; return; }

    registerPhase2(item.wallet!, item.cookieHeader!, proxy)
      .then(async (result) => {
        if (result.success) {
          await saveAccount(result);
          this.stats.success++;
          if (this.config.remoteUrl) this.pushOneToRemote(result).catch(() => {});
        } else {
          if (!result.error?.includes("already claimed") && this.claimPool) {
            const retryProxy = this.claimPool.getNext();
            if (retryProxy) {
              registerPhase2(item.wallet!, item.cookieHeader!, retryProxy)
                .then(async (retry) => {
                  if (retry.success) {
                    await saveAccount(retry);
                    this.stats.success++;
                    if (this.config.remoteUrl) this.pushOneToRemote(retry).catch(() => {});
                  } else { this.stats.failed++; }
                })
                .catch(() => { this.stats.failed++; });
              return;
            }
          }
          this.stats.failed++;
        }
      })
      .catch(() => {
        if (!this.claimPool) { this.stats.failed++; return; }
        const retryProxy = this.claimPool.getNext();
        if (retryProxy) {
          registerPhase2(item.wallet!, item.cookieHeader!, retryProxy)
            .then(async (retry) => {
              if (retry.success) {
                await saveAccount(retry);
                this.stats.success++;
                if (this.config.remoteUrl) this.pushOneToRemote(retry).catch(() => {});
              } else { this.stats.failed++; }
            })
            .catch(() => { this.stats.failed++; });
        } else { this.stats.failed++; }
      });
  }

  // ========== Kookeey 模式 ==========

  /**
   * Kookeey 动态 IP 池模式
   * - 每 10 秒从 kookeey 提取一批 IP（数量 = concurrency）
   * - 每个 IP fire-and-forget 做完整注册（fund → CSRF → login → claim → createApiKey）
   * - 不等上一批完成，10 秒后直接提取下一批；每个线程注册完自动结束
   */
  private async runKookeeyPipeline() {
    while (this.running && !this.abortController?.signal.aborted) {
      this.stats.batches++;
      const batchStart = Date.now();

      const fetchStart = Date.now();
      const ips = await proxyPoolService.fetchKookeey();
      const fetchDuration = Date.now() - fetchStart;
      this.fetchTimes.push(fetchDuration);
      if (this.fetchTimes.length > 20) this.fetchTimes.shift();
      this.timings.avgFetchProxiesMs = Math.round(this.fetchTimes.reduce((a, b) => a + b, 0) / this.fetchTimes.length);

      if (ips.length === 0) {
        if (this.running) await new Promise((r) => setTimeout(r, 10000));
        continue;
      }

      // 熔断：pending 太多时跳过本批，等消化
      const maxPending = Math.min(this.config.concurrency * 3, 700);
      if (this.timings.pendingRegistrations >= maxPending) {
        this.timings.lastBatchDurationMs = Date.now() - batchStart;
        if (this.running) await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const useIps = ips.slice(0, this.config.concurrency);
      this.stats.fetched += useIps.length;
      for (const proxyUrl of useIps) {
        if (!this.running) break;
        if (this.timings.pendingRegistrations >= maxPending) break;
        this.stats.fired++;
        this.timings.pendingRegistrations++;
        // 复用 siyetian 的 fire-and-forget 逻辑（它不关心 IP 来源，只要是 proxyUrl 就行）
        this.fireSiyetianRegister(proxyUrl);
      }

      this.timings.lastBatchDurationMs = Date.now() - batchStart;

      // 不等完成，10 秒后立即下一批
      if (this.running) await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // ========== Siyetian 模式 ==========

  /**
   * 每 10 秒从 siyetian 提取一批 IP
   * 每个 IP fire-and-forget 做完整注册（CSRF→Login→Claim→CreateApiKey）
   * 不等上一批完成
   */
  private async runSiyetianPipeline() {
    while (this.running && !this.abortController?.signal.aborted) {
      this.stats.batches++;
      const batchStart = Date.now();

      // 从 siyetian 提取 IP
      const count = this.config.concurrency;
      proxyPoolService.reset();
      const fetchStart = Date.now();
      const ips = await proxyPoolService.fetchProxies();
      const fetchDuration = Date.now() - fetchStart;
      this.fetchTimes.push(fetchDuration);
      if (this.fetchTimes.length > 20) this.fetchTimes.shift();

      if (ips.length === 0) {
        // 没拿到 IP，等 10 秒重试
        if (this.running) await new Promise((r) => setTimeout(r, 10000));
        continue;
      }

      // 每个 IP fire-and-forget 做完整注册
      // 熔断：pending 超过并发数 * 1.5 倍时跳过本批，等待消化
      const maxPending = Math.min(count * 1.5, 700);
      if (this.timings.pendingRegistrations >= maxPending) {
        this.timings.lastBatchDurationMs = Date.now() - batchStart;
        if (this.running) await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const useIps = ips.slice(0, count);
      this.stats.fetched += useIps.length;
      for (const proxyUrl of useIps) {
        if (!this.running) break;
        // 逐个检查 pending，超限提前退出本批
        if (this.timings.pendingRegistrations >= maxPending) break;
        this.stats.fired++;
        this.timings.pendingRegistrations++;
        this.fireSiyetianRegister(proxyUrl);
      }

      this.timings.lastBatchDurationMs = Date.now() - batchStart;

      // 不等完成，10 秒后下一批
      if (this.running) await new Promise((r) => setTimeout(r, 10000));
    }
  }

  /**
   * 用 siyetian IP 做完整注册（单个 IP 全流程）
   * fire-and-forget，完成后更新统计
   */
  private fireSiyetianRegister(proxyUrl: string) {
    // 构造一个兼容 StickyProxy 接口的对象
    const proxy = {
      url: proxyUrl,
      session: proxyUrl,
      usedCount: 0,
      isActive: true,
      failCount: 0,
      createdAt: new Date(),
    };

    const regStart = Date.now();
    registerOne(proxy)
      .then(async (result) => {
        const regDuration = Date.now() - regStart;
        this.timings.pendingRegistrations--;

        if (result.success) {
          await saveAccount(result);
          this.stats.success++;
          if (this.config.remoteUrl) {
            this.pushOneToRemote(result).catch(() => {});
          }
        } else {
          this.stats.failed++;
          this.stats.ipRetired++;
          // 分类错误
          const step = result.step || "unknown";
          const err = result.error || "";
          console.log(`[register FAIL] step=${step} err=${err.slice(0, 200)}`);
          if (step === "fund") {
            this.errorBreakdown.unknown++;
          } else if (step === "csrf") {
            if (err.includes("timeout") || err.includes("timed out")) this.errorBreakdown.csrf_timeout++;
            else this.errorBreakdown.csrf_fail++;
          } else if (step === "login") {
            if (err.includes("timeout") || err.includes("timed out")) this.errorBreakdown.login_timeout++;
            else this.errorBreakdown.login_fail++;
          } else if (step === "claim") {
            if (err.includes("already claimed")) this.errorBreakdown.claim_already++;
            else this.errorBreakdown.claim_fail++;
          } else if (step === "createApiKey") {
            this.errorBreakdown.createApiKey_fail++;
          } else {
            this.errorBreakdown.unknown++;
          }
        }

        // 记录 Phase1 + Phase2 总耗时
        this.timings.totalRegistrations++;
        this.phase2Times.push(regDuration);
        if (this.phase2Times.length > 100) this.phase2Times.shift();
        this.timings.avgPhase2Ms = Math.round(this.phase2Times.reduce((a, b) => a + b, 0) / this.phase2Times.length);
      })
      .catch((e) => {
        this.timings.pendingRegistrations--;
        this.stats.failed++;
        this.stats.ipRetired++;
        const msg = e instanceof Error ? e.message : "unknown";
        console.log(`[register EXC] ${msg.slice(0, 250)}`);
        if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("fetch failed") || msg.includes("socket")) {
          this.errorBreakdown.proxy_error++;
        } else {
          this.errorBreakdown.unknown++;
        }
      });
  }

  // ========== 远程推送 ==========

  private async pushOneToRemote(result: { address?: string; privateKey?: string; sessionCookie?: string; apiKey?: string; credits?: number; proxy?: string }) {
    if (!this.config.remoteUrl) return;
    try {
      await fetch(`${this.config.remoteUrl}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: [{
            address: result.address,
            privateKey: result.privateKey,
            sessionCookie: result.sessionCookie,
            apiKey: result.apiKey,
            credits: result.credits ?? 500000,
            proxy: result.proxy,
            status: "ACTIVE",
          }],
        }),
      });
    } catch { /* silent */ }
  }
}

export const autoFillWorker = new AutoFillWorker();
