import { NextRequest, NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";
import { API_BASE } from "@/lib/constants";

/**
 * POST /api/v1/chat/completions
 *
 * OpenAI-compatible. Use base_url=http://<host>:3999/api/v1 in your SDK.
 *
 * - Pool allocates a key per request (LRU over the most recent 500 ACTIVE,
 *   filtered by credits >= ALLOC_MIN_CREDITS).
 * - Auto-retry up to MAX_KEY_TRIES on insufficient-balance errors.
 * - Streaming and non-streaming both supported.
 */

const MAX_KEY_TRIES = 4;

export async function POST(request: NextRequest) {
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json({ error: { message: "invalid body" } }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: { message: "invalid json" } }, { status: 400 });
  }

  const stream = body.stream === true;
  const triedAccountIds: string[] = [];
  let lastErrorBody = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_KEY_TRIES; attempt++) {
    const allocated = await quotaService.allocateKey();
    if (!allocated) {
      return NextResponse.json(
        { error: { message: "No available keys in pool", type: "service_unavailable" } },
        { status: 503 }
      );
    }

    if (triedAccountIds.includes(allocated.accountId)) {
      // Couldn't get a fresh one — pool exhausted of healthy keys
      return NextResponse.json(
        { error: { message: "Pool exhausted (all attempted keys insufficient)", type: "service_unavailable" } },
        { status: 503 }
      );
    }
    triedAccountIds.push(allocated.accountId);

    let upstream: Response;
    try {
      upstream = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${allocated.apiKey}`,
        },
        body: bodyText,
      });
    } catch (e) {
      // Transport error — retry with new key
      lastErrorBody = e instanceof Error ? e.message : "upstream fetch failed";
      lastStatus = 502;
      continue;
    }

    // Streaming success path: pipe through immediately, no quota update (we don't peek into stream)
    if (stream && upstream.ok && upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming or upstream error: peek body to update quota & decide on retry
    const respBody = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "application/json";

    // Update quota state based on response (errors carry balance=N)
    const update = await quotaService.updateFromResponse(allocated.accountId, respBody, upstream.status);

    // Retry if this key was retired
    if (update.retired) {
      lastErrorBody = respBody;
      lastStatus = upstream.status;
      continue;
    }

    // Otherwise: pass-through to caller
    return new Response(respBody, {
      status: upstream.status,
      headers: { "Content-Type": ct },
    });
  }

  // All attempts exhausted on insufficient-balance
  return new Response(lastErrorBody || JSON.stringify({ error: { message: "all keys insufficient" } }), {
    status: lastStatus || 429,
    headers: { "Content-Type": "application/json" },
  });
}
