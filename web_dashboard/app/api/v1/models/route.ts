import { NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";
import { API_BASE } from "@/lib/constants";

/**
 * GET /api/v1/models — OpenAI-compatible model list.
 * Uses any available pool key to proxy upstream /v1/models.
 */
export async function GET() {
  const allocated = await quotaService.allocateKey();
  if (!allocated) {
    return NextResponse.json(
      { error: { message: "No available keys in pool" } },
      { status: 503 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${allocated.apiKey}` },
    });
  } catch (e) {
    return NextResponse.json(
      { error: { message: e instanceof Error ? e.message : "upstream fetch failed" } },
      { status: 502 }
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
