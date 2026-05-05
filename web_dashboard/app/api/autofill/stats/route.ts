import { NextResponse } from "next/server";
import { autoFillWorker } from "@/lib/services/AutoFillWorker";

export async function GET() {
  try {
    const stats = autoFillWorker.getStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("AutoFill stats error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get stats" },
      { status: 500 }
    );
  }
}
