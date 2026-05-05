import { NextRequest, NextResponse } from "next/server";
import { registerBatchWithSticky } from "@/lib/services/BankOfAIService";
import { stickyProxyPool } from "@/lib/services/StickyProxyPool";
import { settingService } from "@/lib/services/SettingService";
import { CLOUDBYPASS } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const count = body.count ?? 1;
    // 优先用请求体里的 remoteUrl，否则读设置
    const remoteUrl = body.remoteUrl ?? (await settingService.get("remote_server_url")) ?? "";

    const concurrency = await settingService.getInt("registration_concurrency", 3);

    if (!CLOUDBYPASS.enabled) {
      return NextResponse.json({ error: "No proxy configured" }, { status: 400 });
    }

    const effectiveConcurrency = Math.min(count, concurrency);
    stickyProxyPool.setBatchSize(effectiveConcurrency);
    const result = await registerBatchWithSticky(count, effectiveConcurrency, stickyProxyPool);

    if (result.errors && result.errors.length > 0) {
      console.error(`Registration failures (${result.errors.length}):`);
      result.errors.forEach((e: string) => console.error(`  - ${e}`));
    }

    // 如果指定了远程 URL，把本次注册的账号推送过去
    let remotePush = null;
    if (remoteUrl && result.success > 0) {
      try {
        // 获取最新注册的 N 个账号（含完整数据）
        const newAccounts = await prisma.account.findMany({
          orderBy: { createdAt: "desc" },
          take: result.success,
          select: {
            address: true,
            privateKey: true,
            sessionCookie: true,
            apiKey: true,
            credits: true,
            proxy: true,
            status: true,
          },
        });

        const pushRes = await fetch(`${remoteUrl}/api/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accounts: newAccounts }),
        });
        const pushData = await pushRes.json();
        remotePush = {
          success: pushRes.ok,
          imported: pushData.imported,
          skipped: pushData.skipped,
        };
        console.log(`[register] Pushed ${pushData.imported} accounts to ${remoteUrl}`);
      } catch (e) {
        remotePush = {
          success: false,
          error: e instanceof Error ? e.message : "Push failed",
        };
        console.error(`[register] Remote push failed:`, e);
      }
    }

    return NextResponse.json({
      success: result.success,
      failed: result.failed,
      total: result.total,
      errors: result.errors,
      timeline: (result as unknown as Record<string, unknown>).timeline,
      proxyMode: "cloudbypass-sticky-2phase",
      remotePush,
    });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
