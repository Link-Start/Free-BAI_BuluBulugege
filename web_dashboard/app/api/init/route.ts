import { NextResponse } from "next/server";
import { settingService } from "@/lib/services/SettingService";

export async function POST() {
  try {
    await settingService.initDefaults();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Init error:", error);
    return NextResponse.json({ error: "Init failed" }, { status: 500 });
  }
}
