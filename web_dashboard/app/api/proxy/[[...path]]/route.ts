import { NextRequest, NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";
import { API_BASE } from "@/lib/constants";

/**
 * POST /api/proxy — 代理转发，支持 streaming
 *
 * baseUrl 为空或 "auto" → 自动从号池分配 key，直接调 BankOfAI API
 * stream=true → SSE 流式响应
 */

const MAX_KEY_TRIES = 4;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      format = "openai",
      model,
      messages,
      max_tokens = 2048,
      stream = false,
      baseUrl = "",
      masterKey = "",
    } = body;

    const useDirect = !baseUrl || baseUrl === "auto";

    // Direct pool mode: retry up to MAX_KEY_TRIES on insufficient balance
    if (useDirect) {
      const payload = JSON.stringify({ model, messages, max_tokens, stream });
      const triedIds: string[] = [];
      let lastErr = "";
      let lastStatus = 0;

      for (let attempt = 0; attempt < MAX_KEY_TRIES; attempt++) {
        const allocated = await quotaService.allocateKey();
        if (!allocated) {
          return NextResponse.json(
            { error: { message: "No available keys in pool" } },
            { status: 503 }
          );
        }
        if (triedIds.includes(allocated.accountId)) {
          return NextResponse.json(
            { error: { message: "Pool exhausted (all tried keys insufficient)" } },
            { status: 503 }
          );
        }
        triedIds.push(allocated.accountId);

        let res: Response;
        try {
          res = await fetch(`${API_BASE}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${allocated.apiKey}` },
            body: payload,
          });
        } catch (e) {
          lastErr = e instanceof Error ? e.message : "upstream fetch failed";
          lastStatus = 502;
          continue;
        }

        if (stream && res.ok && res.body) {
          return new Response(res.body as ReadableStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        const respBody = await res.text();
        const update = await quotaService.updateFromResponse(allocated.accountId, respBody, res.status);
        if (update.retired) {
          lastErr = respBody;
          lastStatus = res.status;
          continue;
        }

        return new Response(respBody, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
        });
      }

      return new Response(lastErr || JSON.stringify({ error: { message: "all keys insufficient" } }), {
        status: lastStatus || 429,
        headers: { "Content-Type": "application/json" },
      });
    }

    // External mode (baseUrl + masterKey)
    let url: string;
    let headers: Record<string, string>;
    let payloadObj: Record<string, unknown>;

    if (format === "anthropic") {
      url = `${baseUrl}/v1/messages`;
      headers = {
        "Content-Type": "application/json",
        "x-api-key": masterKey,
        "anthropic-version": "2023-06-01",
      };
      payloadObj = { model, messages, max_tokens, stream };
    } else {
      url = `${baseUrl}/v1/chat/completions`;
      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      };
      payloadObj = { model, messages, max_tokens, stream };
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payloadObj),
    });

    if (stream && res.ok && res.body) {
      return new Response(res.body as ReadableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : "Proxy failed" } },
      { status: 502 }
    );
  }
}
