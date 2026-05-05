import { NextRequest, NextResponse } from "next/server";
import { autoFillWorker } from "@/lib/services/AutoFillWorker";
import { settingService } from "@/lib/services/SettingService";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const concurrency = await settingService.getInt("registration_concurrency", 50);
    const remoteUrl = (await settingService.get("remote_server_url")) ?? "";
    const forceMode = body.mode as "cloudbypass" | "siyetian" | "kookeey" | undefined;

    await autoFillWorker.start({
      concurrency,
      maxRetriesPerIp: 2,
      maxIpsPerBatch: concurrency,
      remoteUrl: remoteUrl || undefined,
      forceMode,
    });

    return NextResponse.json({ success: true, message: "自动补号已启动" });
  } catch (error) {
    console.error("AutoFill start error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start autofill" },
      { status: 500 }
    );
  }
}
