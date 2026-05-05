"use client";

import { useState } from "react";
import { PoolStatus } from "./PoolStatus";
import { SettingsForm } from "./SettingsForm";
import { AccountTable } from "./AccountTable";
import { LogViewer } from "./LogViewer";
import { RelayControl } from "./RelayControl";
import { ApiDocs } from "./ApiDocs";
import type { LogEntry } from "@/lib/types";

function emitLog(entry: Omit<LogEntry, "id" | "timestamp">) {
  if (typeof window !== "undefined") {
    (window as Window & { emitLog?: (e: LogEntry) => void }).emitLog?.({
      ...entry,
      id: Math.random().toString(36).slice(2),
      timestamp: new Date(),
    });
  }
}

export default function Dashboard() {
  const [registering, setRegistering] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRegister() {
    if (registering) return;
    setRegistering(true);
    emitLog({ type: "info", message: "开始注册 1 个账号…" });
    try {
      const res = await fetch("/api/accounts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      });
      const data = await res.json();
      if (res.ok) {
        emitLog({
          type: data.success > 0 ? "success" : "error",
          message: `注册完成：${data.success > 0 ? "成功" : "失败"}`,
        });
      } else {
        emitLog({ type: "error", message: `注册失败：${data.error}` });
      }
    } catch (e: unknown) {
      emitLog({
        type: "error",
        message: `注册异常：${e instanceof Error ? e.message : "unknown"}`,
      });
    } finally {
      setRegistering(false);
    }
  }

  async function handleCheck() {
    if (checking) return;
    setChecking(true);
    emitLog({ type: "info", message: "开始检查所有账号额度…" });
    try {
      const res = await fetch("/api/quota/check", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        emitLog({
          type: "success",
          message: `额度检查完成：可用 ${data.alive}，已用尽 ${data.depleted}，已废弃 ${data.dead}`,
        });
      } else {
        emitLog({ type: "error", message: `检查失败：${data.error}` });
      }
    } catch (e: unknown) {
      emitLog({
        type: "error",
        message: `检查异常：${e instanceof Error ? e.message : "unknown"}`,
      });
    } finally {
      setChecking(false);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    emitLog({ type: "info", message: "开始刷新废弃账号…" });
    try {
      const res = await fetch("/api/quota/refresh", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        emitLog({
          type: "success",
          message: `刷新完成：新注册 ${data.refreshed} 个，失败 ${data.failed} 个`,
        });
      } else {
        emitLog({ type: "error", message: `刷新失败：${data.error}` });
      }
    } catch (e: unknown) {
      emitLog({
        type: "error",
        message: `刷新异常：${e instanceof Error ? e.message : "unknown"}`,
      });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh" }}>
      {/* Header */}
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
              fontSize: "clamp(1.25rem, 3vw, 1.75rem)",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            号池机
          </h1>
          <p
            style={{
              fontSize: "0.75rem",
              opacity: 0.5,
              marginTop: "2px",
              fontWeight: 500,
            }}
          >
            Bank of AI · API Key Pool Manager
          </p>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <button
            className="nb-btn nb-btn-secondary"
            onClick={handleRegister}
            disabled={registering}
          >
            {registering ? "注册中…" : "+1 测试"}
          </button>
          <button
            className="nb-btn nb-btn-success"
            onClick={handleCheck}
            disabled={checking}
          >
            {checking ? "检查中…" : "检查额度"}
          </button>
          <button
            className="nb-btn nb-btn-blue"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? "刷新中…" : "刷新废弃账号"}
          </button>
          <a
            href="/playground"
            className="nb-btn nb-btn-secondary"
            style={{ textDecoration: "none" }}
          >
            Playground
          </a>
        </div>
      </header>

      {/* Main content */}
      <div className="container page-padding">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          {/* Pool status overview */}
          <PoolStatus />

          {/* Settings + Relay */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gap: "var(--space-6)",
            }}
          >
            <SettingsForm />
            <RelayControl />
          </div>

          {/* Action status bar */}
          {(registering || checking || refreshing) && (
            <div
              className="nb-card-sm"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                background: "var(--yellow)",
                borderColor: "var(--ink)",
              }}
            >
              <div
                className="loading-dot"
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "var(--ink)",
                }}
              />
              <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                {registering && "正在注册测试账号…"}
                {checking && "正在检查所有账号额度…"}
                {refreshing && "正在刷新废弃账号…"}
              </span>
            </div>
          )}

          {/* Account table */}
          <AccountTable />

          {/* API docs */}
          <ApiDocs />

          {/* Log viewer */}
          <LogViewer />

          {/* Footer */}
          <footer
            style={{
              borderTop: "var(--border)",
              paddingTop: "var(--space-4)",
              marginTop: "var(--space-4)",
              opacity: 0.4,
              fontSize: "0.75rem",
              textAlign: "center",
            }}
          >
            号池机 · Bank of AI API Key Pool · {new Date().getFullYear()}
          </footer>
        </div>
      </div>
    </main>
  );
}
