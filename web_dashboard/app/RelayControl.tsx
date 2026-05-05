"use client";

import { useEffect, useRef, useState } from "react";

interface RelayStats {
  running: boolean;
  target: number;
  produced: number;
  failed: number;
  hopsCompleted: number;
  batches: number;
  funderSpent: string;
  startedAt: string | null;
  lastKeyAt: string | null;
}

const DEFAULT: RelayStats = {
  running: false,
  target: 0,
  produced: 0,
  failed: 0,
  hopsCompleted: 0,
  batches: 0,
  funderSpent: "0",
  startedAt: null,
  lastKeyAt: null,
};

export function RelayControl() {
  const [stats, setStats] = useState<RelayStats>(DEFAULT);
  const [target, setTarget] = useState(1000);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = () => {
    fetch("/api/relay/stats")
      .then((r) => r.json())
      .then((d: RelayStats) => setStats(d))
      .catch(() => {});
  };

  useEffect(() => { poll(); }, []);
  useEffect(() => {
    if (stats.running) {
      pollRef.current = setInterval(poll, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [stats.running]);

  async function toggle() {
    setLoading(true);
    try {
      if (stats.running) {
        await fetch("/api/relay/stop", { method: "POST" });
      } else {
        await fetch("/api/relay/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
      }
      await new Promise((r) => setTimeout(r, 600));
      poll();
    } finally { setLoading(false); }
  }

  const spentEth = Number(stats.funderSpent) / 1e18;
  const spentUsd = spentEth * 3000;
  const perKey = stats.produced > 0 ? spentUsd / stats.produced : 0;
  const successRate = stats.produced + stats.failed > 0
    ? (stats.produced / (stats.produced + stats.failed) * 100)
    : 0;

  return (
    <div className="nb-card animate-fade-in-up animate-delay-3">
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-4)", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em", margin: 0 }}>
          链式接力注册
        </h2>
        {stats.running && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "0.75rem", fontWeight: 700, color: "var(--green)" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)" }} className="loading-dot" />
            运行中 {stats.produced}/{stats.target}
          </div>
        )}
      </div>

      {/* Control row */}
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", marginBottom: stats.running ? "var(--space-4)" : 0 }}>
        <label style={{ fontSize: "0.8125rem", fontWeight: 600, opacity: 0.7 }}>
          目标
        </label>
        <input
          type="number"
          className="nb-input"
          value={target}
          onChange={(e) => setTarget(Number(e.target.value) || 0)}
          disabled={stats.running}
          style={{ flex: 1, fontSize: "0.875rem", padding: "var(--space-2) var(--space-3)", minWidth: 0 }}
          min={1}
        />
        <button
          className={`nb-btn ${stats.running ? "nb-btn-danger" : "nb-btn-success"}`}
          onClick={toggle}
          disabled={loading}
          style={{ padding: "var(--space-2) var(--space-5)", fontSize: "0.8125rem", whiteSpace: "nowrap" }}
        >
          {loading ? "..." : stats.running ? "停止" : "启动"}
        </button>
      </div>

      {/* Stats grid */}
      {stats.running && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(80px, 1fr))", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
            {[
              { label: "已产出", value: String(stats.produced), color: "var(--green)" },
              { label: "失败", value: String(stats.failed), color: "var(--red)" },
              { label: "成功率", value: `${successRate.toFixed(1)}%`, color: "var(--blue)" },
              { label: "已花 USD", value: `$${spentUsd.toFixed(3)}`, color: "var(--yellow)" },
              { label: "每 key", value: `$${perKey.toFixed(5)}`, color: "var(--orange)" },
            ].map((s) => (
              <div key={s.label} style={{ background: "var(--ink)", color: s.color, borderRadius: "var(--radius)", padding: "var(--space-2)", textAlign: "center", minWidth: 0 }}>
                <div style={{ fontSize: "1rem", fontWeight: 800, fontFamily: "var(--font-display)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.value}
                </div>
                <div style={{ fontSize: "0.625rem", opacity: 0.6, marginTop: 2, whiteSpace: "nowrap" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
