"use client";

import { useState, useEffect } from "react";
import type { PoolStats } from "@/lib/types";

export function PoolStatus() {
  const [stats, setStats] = useState<PoolStats>({
    total: 0,
    active: 0,
    depleted: 0,
    dead: 0,
    registering: 0,
  });
  const [loading, setLoading] = useState(true);

  async function fetchStats() {
    try {
      const res = await fetch("/api/pool-stats");
      const data = await res.json();
      if (res.ok) {
        setStats(data);
      }
    } catch (err) {
      console.error("Failed to fetch stats:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const cards = [
    {
      label: "账号总数",
      value: stats.total,
      bg: "var(--ink)",
      color: "var(--cream)",
      borderColor: "var(--ink)",
    },
    {
      label: "可用",
      value: stats.active,
      bg: "var(--green)",
      color: "var(--cream)",
      borderColor: "var(--green)",
    },
    {
      label: "已用尽",
      value: stats.depleted,
      bg: "var(--yellow)",
      color: "var(--ink)",
      borderColor: "var(--yellow)",
    },
    {
      label: "已废弃",
      value: stats.dead,
      bg: "var(--red)",
      color: "var(--cream)",
      borderColor: "var(--red)",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "var(--space-4)",
      }}
    >
      {cards.map((card, i) => (
        <div
          key={card.label}
          className="nb-card animate-fade-in-up"
          style={{
            animationDelay: `${i * 0.1}s`,
            background: card.bg,
            color: card.color,
            borderColor: card.borderColor,
            border: `2.5px solid ${card.borderColor}`,
          }}
        >
          <div
            style={{
              fontSize: "0.6875rem",
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              opacity: 0.8,
              marginBottom: "var(--space-2)",
            }}
          >
            {card.label}
          </div>
          {loading ? (
            <div
              style={{
                fontSize: "2.5rem",
                fontWeight: 800,
                fontFamily: "var(--font-display)",
                letterSpacing: "-0.04em",
              }}
              className="loading-dot"
            >
              —
            </div>
          ) : (
            <div
              style={{
                fontSize: "2.5rem",
                fontWeight: 800,
                fontFamily: "var(--font-display)",
                letterSpacing: "-0.04em",
                lineHeight: 1,
              }}
            >
              {card.value.toLocaleString()}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
