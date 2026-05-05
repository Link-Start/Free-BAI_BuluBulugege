"use client";

import { useState, useEffect, useRef } from "react";
import type { LogEntry } from "@/lib/types";

export function LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 模拟日志更新（实际由外部事件驱动）
  useEffect(() => {
    const handler = (event: CustomEvent<LogEntry>) => {
      setLogs((prev) => [event.detail, ...prev].slice(0, 200));
    };
    window.addEventListener("pool-log" as keyof WindowEventMap, handler as EventListener);
    return () =>
      window.removeEventListener("pool-log" as keyof WindowEventMap, handler as EventListener);
  }, []);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const typeStyles: Record<LogEntry["type"], { bg: string; label: string }> = {
    info: { bg: "var(--blue)", label: "INFO" },
    success: { bg: "var(--green)", label: "OK" },
    warn: { bg: "var(--yellow)", label: "WARN" },
    error: { bg: "var(--red)", label: "ERR" },
  };

  return (
    <div className="nb-card animate-fade-in-up animate-delay-4">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--space-4)",
        }}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          实时日志
        </h2>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "0.75rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          自动滚动
        </label>
      </div>

      <div
        style={{
          background: "var(--ink)",
          color: "var(--cream)",
          borderRadius: "var(--radius)",
          padding: "var(--space-3)",
          height: "240px",
          overflowY: "auto",
          fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
          fontSize: "0.75rem",
          lineHeight: 1.7,
        }}
      >
        {logs.length === 0 ? (
          <div style={{ opacity: 0.4, padding: "var(--space-2)" }}>
            [等待日志…] 点击「补号」或「检查额度」开始
          </div>
        ) : (
          logs.map((log) => {
            const style = typeStyles[log.type];
            return (
              <div
                key={log.id}
                style={{
                  display: "flex",
                  gap: "var(--space-3)",
                  padding: "1px 0",
                  borderBottom: "1px solid rgba(255,254,245,0.05)",
                }}
              >
                <span style={{ opacity: 0.4, flexShrink: 0, minWidth: "80px" }}>
                  {new Date(log.timestamp).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span
                  style={{
                    background: style.bg,
                    color: style.bg === "var(--yellow)" ? "var(--ink)" : "var(--cream)",
                    padding: "0 4px",
                    fontWeight: 700,
                    fontSize: "0.6875rem",
                    flexShrink: 0,
                    minWidth: "36px",
                    textAlign: "center",
                  }}
                >
                  {style.label}
                </span>
                <span style={{ opacity: 0.9 }}>{log.message}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// 全局日志发射函数
if (typeof window !== "undefined") {
  (window as Window & { emitLog?: (entry: LogEntry) => void }).emitLog = (entry: LogEntry) => {
    window.dispatchEvent(new CustomEvent("pool-log", { detail: entry }));
  };
}
