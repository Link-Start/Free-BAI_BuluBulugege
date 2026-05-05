"use client";

import { useState, useEffect, useRef } from "react";

interface AutoFillStats {
  running: boolean;
  stats: { success: number; failed: number; ipRetired: number; batches: number };
  mode?: string;
}

export function AutoFillControl() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState({ success: 0, failed: 0, ipRetired: 0, batches: 0 });
  const [mode, setMode] = useState("");
  const [selectedMode, setSelectedMode] = useState<string>("auto");
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStats = () => {
    fetch("/api/autofill/stats")
      .then((r) => r.json())
      .then((data: AutoFillStats) => {
        setRunning(data.running);
        setStats(data.stats ?? { success: 0, failed: 0, ipRetired: 0, batches: 0 });
        setMode(data.mode ?? "");
      })
      .catch(() => {});
  };

  useEffect(() => {
    pollStats();
  }, []);

  useEffect(() => {
    if (running) {
      pollRef.current = setInterval(pollStats, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [running]);

  async function toggle() {
    setLoading(true);
    try {
      if (running) {
        await fetch("/api/autofill/stop", { method: "POST" });
        setRunning(false);
      } else {
        await fetch("/api/autofill/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(selectedMode !== "auto" ? { mode: selectedMode } : {}),
        });
        setRunning(true);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="nb-card animate-fade-in-up animate-delay-3">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: running ? "var(--space-4)" : 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
            自动补号
          </h2>
          {running && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--green)",
              }}
            >
              <div
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "var(--green)",
                }}
                className="loading-dot"
              />
              运行中
              {mode && <span style={{ opacity: 0.6, marginLeft: 4 }}>({mode})</span>}
            </div>
          )}
        </div>

        {!running && (
          <select
            className="nb-input"
            style={{ width: "auto", fontSize: "0.75rem", padding: "var(--space-1) var(--space-2)" }}
            value={selectedMode}
            onChange={(e) => setSelectedMode(e.target.value)}
          >
            <option value="auto">自动选择</option>
            <option value="kookeey">Kookeey (Base+dust)</option>
            <option value="cloudbypass">CloudBypass</option>
            <option value="siyetian">Siyetian</option>
          </select>
        )}

        <button
          className={`nb-btn ${running ? "nb-btn-danger" : "nb-btn-success"}`}
          onClick={toggle}
          disabled={loading}
          style={{ padding: "var(--space-2) var(--space-4)", fontSize: "0.8125rem" }}
        >
          {loading ? "..." : running ? "停止" : "启动"}
        </button>
      </div>

      {/* Live stats */}
      {running && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "var(--space-3)",
          }}
        >
          {[
            { label: "成功", value: stats.success, color: "var(--green)" },
            { label: "失败", value: stats.failed, color: "var(--red)" },
            { label: "IP 切换", value: stats.ipRetired, color: "var(--yellow)" },
            { label: "批次", value: stats.batches, color: "var(--blue)" },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: "var(--ink)",
                color: s.color,
                borderRadius: "var(--radius)",
                padding: "var(--space-2) var(--space-3)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "1.25rem", fontWeight: 800, fontFamily: "var(--font-display)" }}>
                {s.value}
              </div>
              <div style={{ fontSize: "0.6875rem", opacity: 0.6, marginTop: "2px" }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
