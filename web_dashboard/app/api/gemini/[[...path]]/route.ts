import { NextRequest, NextResponse } from "next/server";
import { quotaService } from "@/lib/services/QuotaService";
import { API_BASE } from "@/lib/constants";

/**
 * Gemini 原生格式代理
 *
 * POST /api/gemini/models/{model}:generateContent         → 非流式
 * POST /api/gemini/models/{model}:streamGenerateContent   → 流式 SSE
 *
 * 接收 Gemini 原生格式 → 转成 OpenAI 格式 → 调号池 → 转回 Gemini 格式返回
 */

// ========== 格式转换 ==========

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

interface GeminiRequest {
  system_instruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    candidateCount?: number;
    responseMimeType?: string;
  };
  safetySettings?: unknown[];
}

function geminiToOpenAI(model: string, body: GeminiRequest, stream: boolean) {
  const messages: { role: string; content: string }[] = [];

  // system_instruction → system message
  if (body.system_instruction?.parts?.length) {
    const text = body.system_instruction.parts.map((p) => p.text ?? "").join("");
    if (text) messages.push({ role: "system", content: text });
  }

  // contents → messages
  for (const c of body.contents ?? []) {
    const role = c.role === "model" ? "assistant" : "user";
    const text = (c.parts ?? []).map((p) => p.text ?? "").join("");
    if (text) messages.push({ role, content: text });
  }

  const config = body.generationConfig;
  const payload: Record<string, unknown> = { model, messages, stream };

  if (config?.temperature !== undefined) payload.temperature = config.temperature;
  if (config?.topP !== undefined) payload.top_p = config.topP;
  if (config?.maxOutputTokens !== undefined) payload.max_tokens = config.maxOutputTokens;
  if (config?.stopSequences?.length) payload.stop = config.stopSequences;

  return payload;
}

function openAIToGemini(data: Record<string, unknown>) {
  const choices = data.choices as { message?: { content?: string }; finish_reason?: string }[];
  const choice = choices?.[0];
  const text = choice?.message?.content ?? "";

  const finishMap: Record<string, string> = {
    stop: "STOP",
    length: "MAX_TOKENS",
    content_filter: "SAFETY",
  };

  const usage = data.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | undefined;

  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: finishMap[choice?.finish_reason ?? "stop"] ?? "STOP",
        index: 0,
      },
    ],
    usageMetadata: usage
      ? {
          promptTokenCount: usage.prompt_tokens ?? 0,
          candidatesTokenCount: usage.completion_tokens ?? 0,
          totalTokenCount: usage.total_tokens ?? 0,
        }
      : undefined,
    modelVersion: data.model as string | undefined,
  };
}

function openAIStreamChunkToGemini(chunk: string, _isLast: boolean) {
  try {
    const data = JSON.parse(chunk);
    const delta = data.choices?.[0]?.delta;
    const finishReason = data.choices?.[0]?.finish_reason;
    const text = delta?.content ?? "";

    if (!text && !finishReason) return null;

    const candidate: Record<string, unknown> = {
      content: { parts: [{ text }], role: "model" },
      index: 0,
    };

    if (finishReason) {
      const finishMap: Record<string, string> = {
        stop: "STOP",
        length: "MAX_TOKENS",
        content_filter: "SAFETY",
      };
      candidate.finishReason = finishMap[finishReason] ?? "STOP";
    }

    const result: Record<string, unknown> = { candidates: [candidate] };

    if (data.usage) {
      result.usageMetadata = {
        promptTokenCount: data.usage.prompt_tokens ?? 0,
        candidatesTokenCount: data.usage.completion_tokens ?? 0,
        totalTokenCount: data.usage.total_tokens ?? 0,
      };
    }

    return result;
  } catch {
    return null;
  }
}

// ========== Stream helper: OpenAI SSE → Gemini SSE ==========

function openAIStreamToGemini(res: Response): Response {
  if (!res.body) {
    return NextResponse.json(
      { error: { code: 502, message: "upstream stream missing body" } },
      { status: 502 }
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") {
            controller.close();
            return;
          }
          const geminiChunk = openAIStreamChunkToGemini(payload, false);
          if (geminiChunk) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(geminiChunk)}\n\n`)
            );
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ========== 路由解析 ==========

function parseGeminiPath(path: string[]): { model: string; action: string } | null {
  // path: ["models", "gemini-3.1-pro:generateContent"]
  // or:   ["models", "gemini-3-flash:streamGenerateContent"]
  const joined = path.join("/");

  const match = joined.match(/^models\/(.+?):(generateContent|streamGenerateContent)$/);
  if (!match) return null;

  return { model: match[1], action: match[2] };
}

// ========== POST handler ==========

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  try {
    const { path } = await params;
    if (!path?.length) {
      return NextResponse.json(
        { error: { code: 400, message: "Invalid path. Use /models/{model}:generateContent" } },
        { status: 400 }
      );
    }

    const parsed = parseGeminiPath(path);
    if (!parsed) {
      return NextResponse.json(
        { error: { code: 400, message: `Invalid path: ${path.join("/")}` } },
        { status: 400 }
      );
    }

    const { model, action } = parsed;
    const isStream = action === "streamGenerateContent";
    const body: GeminiRequest = await request.json();
    const openaiPayload = geminiToOpenAI(model, body, isStream);
    const payloadStr = JSON.stringify(openaiPayload);

    const MAX_KEY_TRIES = 4;
    const triedIds: string[] = [];
    let lastErrBody = "";
    let lastStatus = 0;

    for (let attempt = 0; attempt < MAX_KEY_TRIES; attempt++) {
      const allocated = await quotaService.allocateKey();
      if (!allocated) {
        return NextResponse.json(
          { error: { code: 503, message: "No available keys in pool", status: "UNAVAILABLE" } },
          { status: 503 }
        );
      }
      if (triedIds.includes(allocated.accountId)) {
        return NextResponse.json(
          { error: { code: 503, message: "Pool exhausted (all tried insufficient)", status: "UNAVAILABLE" } },
          { status: 503 }
        );
      }
      triedIds.push(allocated.accountId);

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${allocated.apiKey}`,
          },
          body: payloadStr,
        });
      } catch (e) {
        lastErrBody = e instanceof Error ? e.message : "upstream fetch failed";
        lastStatus = 502;
        continue;
      }

      // Streaming success: pipe directly (no quota update since we don't parse stream body)
      if (isStream && res.ok && res.body) {
        return openAIStreamToGemini(res);
      }

      // Non-stream or error: peek body for quota update
      const respText = await res.text();
      const update = await quotaService.updateFromResponse(allocated.accountId, respText, res.status);
      if (update.retired) {
        lastErrBody = respText;
        lastStatus = res.status;
        continue;
      }

      if (!isStream) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(respText); } catch { data = {}; }
        if (!res.ok) {
          const err = data.error as { message?: string } | undefined;
          return NextResponse.json(
            { error: { code: res.status, message: err?.message ?? "Backend error" } },
            { status: res.status }
          );
        }
        return NextResponse.json(openAIToGemini(data));
      }

      // Streaming but upstream not ok and not depleted
      lastErrBody = respText;
      lastStatus = res.status;
      break;
    }

    return NextResponse.json(
      { error: { code: lastStatus || 429, message: lastErrBody.slice(0, 300) || "all keys insufficient" } },
      { status: lastStatus || 429 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: 500,
          message: error instanceof Error ? error.message : "Internal error",
          status: "INTERNAL",
        },
      },
      { status: 500 }
    );
  }
}
