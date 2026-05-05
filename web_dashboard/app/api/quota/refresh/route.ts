import { NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    // 找出所有 DEPLETED 账号
    const depleted = await prisma.account.findMany({
      where: { status: "DEPLETED" },
      select: { id: true },
    });

    let refreshed = 0;
    let failed = 0;

    for (const account of depleted) {
      const ok = await quotaService.refreshAccount(account.id);
      if (ok) refreshed++;
      else failed++;
    }

    return NextResponse.json({ refreshed, failed, total: depleted.length });
  } catch (error) {
    console.error("Quota refresh error:", error);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
