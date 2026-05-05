"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";

const MODELS = [
  { id: "glm-5", name: "GLM-5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
];

const FORMATS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
];

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Playground() {
  const [model, setModel] = useState("gpt-5.4");
  const [format, setFormat] = useState("openai");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("auto");
  const [masterKey, setMasterKey] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  async function send() {
    if (!input.trim() || loading) return;
    const userMsg: Message = { role: "user", content: input.trim() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);
    setError(null);

    const allMessages = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // 流式请求
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          model,
          messages: allMessages,
          max_tokens: 2048,
          stream: true,
          baseUrl,
          masterKey,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }

      // 添加空的 assistant 消息，逐步填充
      setMessages((m) => [...m, { role: "assistant", content: "" }]);

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const payload = trimmed.slice(6);
            if (payload === "[DONE]") break;

            try {
              const chunk = JSON.parse(payload);
              const delta =
                chunk.choices?.[0]?.delta?.content ??
                chunk.delta?.text ??
                "";
              if (delta) {
                setMessages((m) => {
                  const updated = [...m];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + delta,
                    };
                  }
                  return updated;
                });
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      }

      // 如果流式没有产生内容，fallback 读取完整响应
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last?.role === "assistant" && !last.content) {
          return [...m.slice(0, -1), { role: "assistant" as const, content: "(empty response)" }];
        }
        return m;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh" }}>
      <header
        style={{
          borderBottom: "var(--border)",
          padding: "var(--space-4) var(--space-6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-3)",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "clamp(1.25rem, 3vw, 1.5rem)",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            Playground
          </h1>
          <p style={{ fontSize: "0.75rem", opacity: 0.5, marginTop: "2px" }}>
            模型测试对话
          </p>
        </div>
        <Link
          href="/"
          className="nb-btn nb-btn-secondary"
          style={{ fontSize: "0.8125rem", textDecoration: "none" }}
        >
          ← 返回 Dashboard
        </Link>
      </header>

      <div className="container page-padding">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          {/* Controls */}
          <div className="nb-card">
            <div
              style={{
                display: "flex",
                gap: "var(--space-4)",
                flexWrap: "wrap",
                alignItems: "flex-end",
              }}
            >
              <div>
                <label className="nb-label">模型</label>
                <select
                  className="nb-input"
                  style={{ width: "auto" }}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="nb-label">输出格式</label>
                <select
                  className="nb-input"
                  style={{ width: "auto" }}
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  {FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="nb-label">来源</label>
                <select
                  className="nb-input"
                  style={{ width: "auto" }}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                >
                  <option value="auto">号池直连</option>
                  <option value="http://localhost:4000">LiteLLM (localhost:4000)</option>
                </select>
              </div>
              {baseUrl !== "auto" && (
                <div style={{ minWidth: "160px" }}>
                  <label className="nb-label">API Key</label>
                  <input
                    className="nb-input"
                    value={masterKey}
                    onChange={(e) => setMasterKey(e.target.value)}
                    type="password"
                    placeholder="sk-..."
                  />
                </div>
              )}
              <button
                className="nb-btn nb-btn-secondary"
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
                style={{ fontSize: "0.8125rem" }}
              >
                清空对话
              </button>
            </div>
          </div>

          {/* Chat area */}
          <div className="nb-card" style={{ padding: 0 }}>
            <div
              ref={scrollRef}
              style={{
                height: "50vh",
                overflowY: "auto",
                padding: "var(--space-6)",
              }}
            >
              {messages.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    opacity: 0.3,
                    padding: "var(--space-12)",
                    fontSize: "0.875rem",
                  }}
                >
                  选择模型和格式，输入消息开始对话
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: "var(--space-3)",
                    marginBottom: "var(--space-4)",
                    flexDirection: msg.role === "user" ? "row-reverse" : "row",
                  }}
                >
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      border: "var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.6875rem",
                      fontWeight: 800,
                      flexShrink: 0,
                      background:
                        msg.role === "user" ? "var(--orange)" : "var(--ink)",
                      color: "var(--cream)",
                    }}
                  >
                    {msg.role === "user" ? "U" : "AI"}
                  </div>
                  <div
                    style={{
                      background:
                        msg.role === "user"
                          ? "var(--orange)"
                          : "var(--ink)",
                      color: "var(--cream)",
                      padding: "var(--space-3) var(--space-4)",
                      borderRadius: "var(--radius)",
                      border: "var(--border)",
                      maxWidth: "75%",
                      fontSize: "0.8125rem",
                      lineHeight: 1.7,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-3)",
                    marginBottom: "var(--space-4)",
                  }}
                >
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      border: "var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.6875rem",
                      fontWeight: 800,
                      background: "var(--ink)",
                      color: "var(--cream)",
                      flexShrink: 0,
                    }}
                  >
                    AI
                  </div>
                  <div
                    className="loading-dot"
                    style={{
                      background: "var(--ink)",
                      color: "var(--cream)",
                      padding: "var(--space-3) var(--space-4)",
                      borderRadius: "var(--radius)",
                      border: "var(--border)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    思考中…
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div
                style={{
                  background: "var(--red)",
                  color: "var(--cream)",
                  padding: "var(--space-3) var(--space-6)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  borderTop: "var(--border)",
                }}
              >
                {error}
              </div>
            )}

            {/* Input */}
            <div
              style={{
                borderTop: "var(--border)",
                padding: "var(--space-4) var(--space-6)",
                display: "flex",
                gap: "var(--space-3)",
              }}
            >
              <input
                className="nb-input"
                style={{ flex: 1 }}
                placeholder="输入消息…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={loading}
              />
              <button
                className="nb-btn nb-btn-primary"
                onClick={send}
                disabled={loading || !input.trim()}
              >
                {loading ? "…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
