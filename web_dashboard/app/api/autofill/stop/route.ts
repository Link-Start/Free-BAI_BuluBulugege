import { NextResponse } from "next/server";
import { autoFillWorker } from "@/lib/services/AutoFillWorker";

export async function POST() {
  try {
    await autoFillWorker.stop();
    return NextResponse.json({ success: true, message: "自动补号已停止" });
  } catch (error) {
    console.error("AutoFill stop error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop autofill" },
      { status: 500 }
    );
  }
}
