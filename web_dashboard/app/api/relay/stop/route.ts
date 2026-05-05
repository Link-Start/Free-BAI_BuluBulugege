import { NextResponse } from "next/server";
import { relayRegistrar } from "@/lib/services/RelayRegistrar";

export async function POST() {
  await relayRegistrar.stopNow();
  return NextResponse.json({ success: true });
}
