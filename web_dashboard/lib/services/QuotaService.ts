import { prisma } from "@/lib/prisma";
import { API_BASE, BASE_URL } from "@/lib/constants";
import { registerOne, saveAccount } from "./BankOfAIService";
import { stickyProxyPool } from "./StickyProxyPool";
import type { PoolStats } from "@/lib/types";

class QuotaService {
  // ========== 从 check_balance.js 迁移 ==========

  async checkPointsViaSession(
    sessionCookie: string
  ): Promise<number | null> {
    try {
      const input = encodeURIComponent(
        JSON.stringify({
          "0": { json: null, meta: { values: ["undefined"], v: 1 } },
        })
      );
      const res = await fetch(
        `${BASE_URL}/api/trpc/lambda/usage.points?batch=1&input=${input}`,
        {
          headers: {
            Accept: "application/json",
            Cookie: sessionCookie,
          },
        }
      );
      const data = await res.json();
      return (
        data[0]?.result?.data?.json?.points_balance ??
        data[0]?.result?.data?.json?.points_balance ??
        null
      );
    } catch {
      return null;
    }
  }

  async checkViaApi(
    apiKey: string
  ): Promise<{ alive: boolean; tokens?: number; reason?: string }> {
    try {
      const res = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5.4-nano",
          messages: [{ role: "user", content: "say ok" }],
          max_tokens: 10,
        }),
      });
      const data = await res.json();

      if (res.status === 200) {
        return { alive: true, tokens: data.usage?.total_tokens };
      }
      if (
        res.status === 402 ||
        data.error?.message?.includes?.("insufficient") ||
        data.error?.message?.includes?.("quota")
      ) {
        return { alive: false, reason: "no_credits" };
      }
      if (res.status === 401) {
        return { alive: false, reason: "invalid_key" };
      }
      if (
        res.status === 400 &&
        data.error?.message?.includes?.("max_tokens")
      ) {
        return { alive: true, tokens: 0 };
      }
      return {
        alive: false,
        reason: `${res.status}: ${data.error?.message?.slice(0, 80)}`,
      };
    } catch (e: unknown) {
      return {
        alive: false,
        reason: e instanceof Error ? e.message.slice(0, 60) : "unknown",
      };
    }
  }

  // ========== 数据库操作 ==========

  async getPoolStats(): Promise<PoolStats> {
    const [total, active, depleted, dead, registering] = await Promise.all([
      prisma.account.count(),
      prisma.account.count({ where: { status: "ACTIVE" } }),
      prisma.account.count({ where: { status: "DEPLETED" } }),
      prisma.account.count({ where: { status: "DEAD" } }),
      prisma.account.count({ where: { status: "REGISTERING" } }),
    ]);
    return { total, active, depleted, dead, registering };
  }

  async checkAllAccounts(): Promise<{
    total: number;
    alive: number;
    dead: number;
    depleted: number;
  }> {
    const accounts = await prisma.account.findMany({
      where: { status: { not: "DEAD" } },
    });

    let alive = 0,
      dead = 0,
      depleted = 0;

    for (const account of accounts) {
      let balance: number | null = null;
      if (account.sessionCookie) {
        balance = await this.checkPointsViaSession(account.sessionCookie);
      }

      if (balance === null) {
        const apiResult = await this.checkViaApi(account.apiKey);
        if (!apiResult.alive) {
          if (apiResult.reason === "no_credits") {
            await prisma.account.update({
              where: { id: account.id },
              data: { status: "DEPLETED", credits: 0 },
            });
            depleted++;
          } else {
            await prisma.account.update({
              where: { id: account.id },
              data: { status: "DEAD" },
            });
            dead++;
          }
          continue;
        }
        balance = 0;
      }

      const newStatus = balance === 0 ? "DEPLETED" : "ACTIVE";
      await prisma.account.update({
        where: { id: account.id },
        data: {
          credits: balance ?? 0,
          status: newStatus,
          lastCheckAt: new Date(),
        },
      });

      if (newStatus === "ACTIVE") alive++;
      else if (newStatus === "DEPLETED") depleted++;
      else dead++;
    }

    return { total: accounts.length, alive, dead, depleted };
  }

  /**
   * 分配策略：
   * - 候选池 = 最新入库的 N 个 ACTIVE 账号 (N = POOL_SIZE, 默认 500)
   * - 过滤掉 credits < MIN_CREDITS 的（BankOfAI pre-consume 需要 ~6000,留余量）
   * - LRU 选择：lastUsedAt 最早（或 null）的优先
   */
  async allocateKey(): Promise<{
    apiKey: string;
    accountId: string;
    credits: number;
  } | null> {
    const POOL_SIZE = parseInt(process.env.ALLOC_POOL_SIZE ?? "500");
    const MIN_CREDITS = parseInt(process.env.ALLOC_MIN_CREDITS ?? "10000");

    const candidates = await prisma.account.findMany({
      orderBy: { createdAt: "desc" },
      take: POOL_SIZE,
      where: {
        status: "ACTIVE",
        credits: { gte: MIN_CREDITS },
      },
    });

    if (candidates.length === 0) return null;

    // LRU: pick the one with oldest lastUsedAt (null = never used, highest priority)
    candidates.sort((a, b) => {
      const aTime = a.lastUsedAt?.getTime() ?? 0;
      const bTime = b.lastUsedAt?.getTime() ?? 0;
      return aTime - bTime;
    });

    const account = candidates[0];
    await prisma.account.update({
      where: { id: account.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      apiKey: account.apiKey,
      accountId: account.id,
      credits: account.credits,
    };
  }

  /**
   * 请求完毕后更新 key 额度状态。
   *   remainingCredits = 0 或负 → DEPLETED
   *   remainingCredits = -1 (sentinel) → 只标 DEPLETED，不改 credits（用于 upstream "insufficient balance" 错误）
   */
  async checkAndRetireIfDepleted(accountId: string, remainingCredits: number): Promise<boolean> {
    if (remainingCredits <= 0) {
      await prisma.account.update({
        where: { id: accountId },
        data: { status: "DEPLETED", credits: Math.max(0, remainingCredits) },
      });
      return true;
    }
    await prisma.account.update({
      where: { id: accountId },
      data: { credits: remainingCredits },
    });
    return false;
  }

  /**
   * 根据 upstream response (JSON / text) 更新账号状态。
   * - `insufficient balance (401002), balance=N required=M` → 设 credits=N + 若 N < MIN_CREDITS 则 DEPLETED
   * - `insufficient` / `quota` / `exhausted` (无具体数字) → DEPLETED
   * - 正常响应 usage.total_tokens → 只更新 lastUsedAt（按 tokens 扣太不准，不扣；等下次错误来校正）
   */
  async updateFromResponse(accountId: string, responseBody: string, httpStatus: number): Promise<{ retired: boolean; balance?: number }> {
    const MIN_CREDITS = parseInt(process.env.ALLOC_MIN_CREDITS ?? "10000");

    // Try to extract balance=N from error message
    const balMatch = responseBody.match(/balance=(-?\d+)/);
    if (balMatch) {
      const balance = parseInt(balMatch[1]);
      const shouldRetire = balance < MIN_CREDITS;
      await prisma.account.update({
        where: { id: accountId },
        data: {
          credits: Math.max(0, balance),
          status: shouldRetire ? "DEPLETED" : "ACTIVE",
          lastCheckAt: new Date(),
        },
      });
      return { retired: shouldRetire, balance };
    }

    // No balance number but explicit exhausted error
    if (
      httpStatus === 402 ||
      /insufficient|quota|exhausted|401002/i.test(responseBody)
    ) {
      await prisma.account.update({
        where: { id: accountId },
        data: { status: "DEPLETED", credits: 0, lastCheckAt: new Date() },
      });
      return { retired: true };
    }

    return { retired: false };
  }

  /**
   * 刷新废弃账号（重新注册替换）
   */
  async refreshAccount(accountId: string): Promise<boolean> {
    const proxy = stickyProxyPool.getNext();
    if (!proxy) return false;

    const result = await registerOne(proxy);
    if (result.success) {
      stickyProxyPool.markSuccess(proxy);
      await prisma.account.update({
        where: { id: accountId },
        data: { status: "DEAD" },
      });
      await saveAccount(result);
      return true;
    }
    stickyProxyPool.markFailed(proxy);
    return false;
  }
}

export const quotaService = new QuotaService();
