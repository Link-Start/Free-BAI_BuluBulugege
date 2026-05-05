import { NextRequest, NextResponse } from "next/server";
import { relayRegistrar } from "@/lib/services/RelayRegistrar";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const target = Number(body.target ?? 1000);
    if (!Number.isFinite(target) || target <= 0) {
      return NextResponse.json({ error: "invalid target" }, { status: 400 });
    }
    const res = await relayRegistrar.start(target);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    return NextResponse.json({ success: true, message: res.message });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
