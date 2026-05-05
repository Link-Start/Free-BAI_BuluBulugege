"use client";

import { useState, useEffect } from "react";
import type { AccountSafe } from "@/lib/types";

export function AccountTable() {
  const [accounts, setAccounts] = useState<AccountSafe[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = `/api/accounts?page=${pagination.page}&limit=${pagination.limit}${
      statusFilter ? `&status=${statusFilter}` : ""
    }`;
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setAccounts(data.accounts ?? []);
        setPagination(data.pagination ?? { page: 1, limit: 20, total: 0, pages: 0 });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pagination.page, pagination.limit, statusFilter]);

  function maskKey(key: string) {
    if (key.length <= 8) return "sk-••••••••";
    return key.slice(0, 6) + "••••••••" + key.slice(-4);
  }

  function maskAddress(addr: string) {
    return addr.slice(0, 6) + "••••••" + addr.slice(-4);
  }

  function formatDate(date: string | Date | null) {
    if (!date) return "—";
    return new Date(date).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="nb-card animate-fade-in-up animate-delay-3">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--space-4)",
          flexWrap: "wrap",
          gap: "var(--space-3)",
        }}
      >
        <h2
          style={{
            fontSize: "1rem",
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          账号列表
        </h2>

        <select
          className="nb-input"
          style={{ width: "auto", cursor: "pointer" }}
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPagination((p) => ({ ...p, page: 1 }));
          }}
        >
          <option value="">全部状态</option>
          <option value="ACTIVE">可用</option>
          <option value="DEPLETED">已用尽</option>
          <option value="DEAD">已废弃</option>
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", opacity: 0.5 }}>
          加载中…
        </div>
      ) : accounts.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "var(--space-8)",
            opacity: 0.4,
            fontSize: "0.875rem",
          }}
        >
          暂无账号，点击上方「补号」开始
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="nb-table">
              <thead>
                <tr>
                  <th>地址</th>
                  <th>API Key</th>
                  <th>额度</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>最近使用</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id}>
                    <td
                      className="mono"
                      style={{ fontSize: "0.75rem", maxWidth: "120px" }}
                      title={acc.address}
                    >
                      {maskAddress(acc.address)}
                    </td>
                    <td
                      className="mono"
                      style={{ fontSize: "0.75rem", maxWidth: "140px" }}
                      title={acc.apiKey}
                    >
                      {maskKey(acc.apiKey)}
                    </td>
                    <td className="mono" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                      {acc.credits.toLocaleString()}
                    </td>
                    <td>
                      <span className={`nb-badge nb-badge-${acc.status.toLowerCase()}`}>
                        {acc.status === "ACTIVE"
                          ? "可用"
                          : acc.status === "DEPLETED"
                          ? "已用尽"
                          : acc.status === "REGISTERING"
                          ? "注册中"
                          : "已废弃"}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                      {formatDate(acc.createdAt)}
                    </td>
                    <td className="mono" style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                      {formatDate(acc.lastUsedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "var(--space-4)",
              paddingTop: "var(--space-4)",
              borderTop: "1px solid rgba(26,20,35,0.1)",
              flexWrap: "wrap",
              gap: "var(--space-2)",
            }}
          >
            <span style={{ fontSize: "0.75rem", opacity: 0.6 }}>
              共 {pagination.total} 条，第 {pagination.page} / {pagination.pages || 1} 页
            </span>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                className="nb-btn nb-btn-secondary nb-card-sm"
                style={{ padding: "4px 12px", fontSize: "0.75rem" }}
                disabled={pagination.page <= 1}
                onClick={() =>
                  setPagination((p) => ({ ...p, page: p.page - 1 }))
                }
              >
                ← 上一页
              </button>
              <button
                className="nb-btn nb-btn-secondary nb-card-sm"
                style={{ padding: "4px 12px", fontSize: "0.75rem" }}
                disabled={pagination.page >= pagination.pages}
                onClick={() =>
                  setPagination((p) => ({ ...p, page: p.page + 1 }))
                }
              >
                下一页 →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
