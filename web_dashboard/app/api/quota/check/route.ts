import { NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";

export async function POST() {
  try {
    const result = await quotaService.checkAllAccounts();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Quota check error:", error);
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
