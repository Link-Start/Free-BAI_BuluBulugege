"use client";

import { useState } from "react";

const MODELS = [
  { name: "GLM-5", provider: "智谱 AI", id: "glm-5" },
  { name: "GPT-5.4", provider: "OpenAI", id: "gpt-5.4" },
  { name: "Gemini 3.1 Pro", provider: "Google", id: "gemini-3.1-pro" },
  { name: "Gemini 3 Flash", provider: "Google", id: "gemini-3-flash" },
];

function CodeBlock({ children, title }: { children: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: "relative", marginBottom: "var(--space-3)" }}>
      {title && (
        <div
          style={{
            fontSize: "0.6875rem",
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--cream)",
            background: "var(--ink)",
            padding: "var(--space-1) var(--space-3)",
            borderTopLeftRadius: "var(--radius)",
            borderTopRightRadius: "var(--radius)",
            border: "var(--border)",
            borderBottom: "none",
          }}
        >
          {title}
        </div>
      )}
      <pre
        style={{
          background: "#1e1e2e",
          color: "#cdd6f4",
          padding: "var(--space-4)",
          fontSize: "0.75rem",
          lineHeight: 1.6,
          overflowX: "auto",
          border: "var(--border)",
          borderRadius: title ? "0 0 var(--radius) var(--radius)" : "var(--radius)",
          margin: 0,
        }}
      >
        <code>{children}</code>
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{
          position: "absolute",
          top: title ? "32px" : "6px",
          right: "8px",
          fontSize: "0.625rem",
          padding: "2px 8px",
          background: copied ? "var(--green)" : "rgba(255,255,255,0.1)",
          color: "var(--cream)",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: "2px",
          cursor: "pointer",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function ApiDocs() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="nb-card animate-fade-in-up animate-delay-4">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          接入文档
        </h2>
        <span
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            color: "var(--blue)",
            userSelect: "none",
          }}
        >
          {expanded ? "收起" : "展开"}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: "var(--space-6)" }}>
          {/* Supported Models */}
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              marginBottom: "var(--space-3)",
            }}
          >
            支持的模型
          </h3>
          <table className="nb-table" style={{ marginBottom: "var(--space-6)" }}>
            <thead>
              <tr>
                <th>模型</th>
                <th>提供商</th>
                <th>Model ID</th>
                <th>格式</th>
              </tr>
            </thead>
            <tbody>
              {MODELS.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td>{m.provider}</td>
                  <td>
                    <code style={{ fontSize: "0.75rem", background: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: "2px" }}>
                      {m.id}
                    </code>
                  </td>
                  <td style={{ fontSize: "0.75rem" }}>
                    {m.id.startsWith("gemini")
                      ? "OpenAI / Anthropic / Gemini"
                      : "OpenAI / Anthropic"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Base URL */}
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              marginBottom: "var(--space-3)",
            }}
          >
            接入地址
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "var(--space-3)",
              marginBottom: "var(--space-6)",
            }}
          >
            {[
              { label: "LiteLLM Proxy", value: "http://localhost:4000" },
              { label: "Master Key", value: "sk-bankofai-pool-master" },
              { label: "Key 分配 API", value: "POST /api/alloc" },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  padding: "var(--space-3)",
                  border: "var(--border)",
                  borderRadius: "var(--radius)",
                }}
              >
                <div style={{ fontSize: "0.6875rem", fontWeight: 700, opacity: 0.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {item.label}
                </div>
                <div style={{ fontSize: "0.8125rem", fontWeight: 600, marginTop: "2px", wordBreak: "break-all" }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {/* OpenAI format */}
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              marginBottom: "var(--space-3)",
            }}
          >
            请求示例
          </h3>

          <CodeBlock title="OpenAI 格式">{`curl http://localhost:4000/v1/chat/completions \\
  -H "Authorization: Bearer sk-bankofai-pool-master" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'`}</CodeBlock>

          <CodeBlock title="Anthropic 格式">{`curl http://localhost:4000/v1/messages \\
  -H "x-api-key: sk-bankofai-pool-master" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'`}</CodeBlock>

          <CodeBlock title="Python (OpenAI SDK)">{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000/v1",
    api_key=YOUR_KEY
)

response = client.chat.completions.create(
    model="gemini-3-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)`}</CodeBlock>

          <CodeBlock title="分配一个 Key">{`# 从池中分配一个可用 API Key（LRU 策略）
curl -X POST http://localhost:3999/api/alloc

# 返回: {"apiKey": "sk-xxx...", "credits": 100000}`}</CodeBlock>

          {/* Key rotation */}
          <h3
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              marginTop: "var(--space-4)",
              marginBottom: "var(--space-3)",
            }}
          >
            轮换策略
          </h3>
          <ul
            style={{
              fontSize: "0.8125rem",
              lineHeight: 2,
              paddingLeft: "var(--space-6)",
              marginBottom: 0,
            }}
          >
            <li>池子容量：最新入库的 <strong>200 个</strong> ACTIVE 账号参与分配</li>
            <li>分配算法：最近最少使用（LRU）</li>
            <li>每账号额度：<strong>100,000 credits</strong></li>
            <li>额度用尽：标记为 DEPLETED，可通过「刷新废弃账号」重新注册替换</li>
            <li>代理：CloudBypass 粘性 IP，失败即切换</li>
          </ul>
        </div>
      )}
    </div>
  );
}
