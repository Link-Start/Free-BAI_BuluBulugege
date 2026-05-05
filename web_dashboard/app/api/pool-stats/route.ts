import { NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";

export async function GET() {
  try {
    const stats = await quotaService.getPoolStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json({ error: "Failed to get stats" }, { status: 500 });
  }
}
