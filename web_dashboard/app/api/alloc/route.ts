import { NextRequest, NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";

/**
 * POST /api/alloc — 分配一个可用 key（随机从最新 100 个 ACTIVE 账号中选）
 * POST /api/alloc { accountId, remainingCredits } — 请求后上报额度，<=0 自动废弃
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    // 上报模式：请求完毕后检查额度
    if (body.accountId && body.remainingCredits !== undefined) {
      const retired = await quotaService.checkAndRetireIfDepleted(
        body.accountId,
        body.remainingCredits
      );
      return NextResponse.json({ retired });
    }

    // 分配模式
    const allocated = await quotaService.allocateKey();
    if (!allocated) {
      return NextResponse.json({ error: "No available keys" }, { status: 404 });
    }

    return NextResponse.json(allocated);
  } catch (error) {
    console.error("Allocation error:", error);
    return NextResponse.json({ error: "Allocation failed" }, { status: 500 });
  }
}
