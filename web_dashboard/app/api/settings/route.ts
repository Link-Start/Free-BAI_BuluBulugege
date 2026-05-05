import { NextRequest, NextResponse } from "next/server";
import { settingService } from "@/lib/services/SettingService";

export async function GET() {
  const settings = await settingService.getAll();
  return NextResponse.json(settings);
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: "Missing key or value" }, { status: 400 });
    }

    if (key === "registration_concurrency") {
      const val = parseInt(value);
      if (isNaN(val) || val < 1) {
        return NextResponse.json({ error: "Concurrency must be ≥ 1" }, { status: 400 });
      }
    }

    if (key === "proxy_fetch_count") {
      const val = parseInt(value);
      if (isNaN(val) || val < 1) {
        return NextResponse.json({ error: "Proxy count must be ≥ 1" }, { status: 400 });
      }
    }

    await settingService.set(key, String(value));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Settings update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
