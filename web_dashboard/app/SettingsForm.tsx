"use client";

import { useState, useEffect, useCallback } from "react";

export function SettingsForm() {
  const [concurrency, setConcurrency] = useState("50");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setConcurrency(data.registration_concurrency ?? "50");
        setRemoteUrl(data.remote_server_url ?? "");
      });
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div className="nb-card animate-fade-in-up animate-delay-2">
      <h2
        style={{
          fontSize: "1rem",
          fontWeight: 700,
          marginBottom: "var(--space-4)",
          letterSpacing: "-0.01em",
        }}
      >
        系统设置
      </h2>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <label className="nb-label" htmlFor="concurrency" style={{ marginBottom: 0, minWidth: "70px" }}>
            并发量
          </label>
          <input
            id="concurrency"
            type="number"
            min="1"
            className="nb-input"
            style={{ width: "80px" }}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            onBlur={(e) => save("registration_concurrency", e.target.value)}
          />
          <span style={{ fontSize: "0.6875rem", opacity: 0.5 }}>
            Phase1 并行登录数
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <label className="nb-label" htmlFor="remoteUrl" style={{ marginBottom: 0, minWidth: "70px" }}>
            远程服务器
          </label>
          <input
            id="remoteUrl"
            type="text"
            className="nb-input"
            style={{ flex: 1 }}
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            onBlur={(e) => save("remote_server_url", e.target.value)}
            placeholder="http://15.204.210.31:3999（留空不推送）"
          />
        </div>

        <div style={{ fontSize: "0.6875rem", opacity: 0.5, lineHeight: 1.5 }}>
          代理模式自动检测：有 CloudBypass 凭据走流水线，否则走 Siyetian
          {remoteUrl && <><br />注册完成后自动推送到远程服务器 ✓</>}
        </div>

        {(saving || saved) && (
          <div style={{ fontSize: "0.75rem" }}>
            {saving && <span className="loading-dot">保存中…</span>}
            {saved && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ 已保存</span>}
          </div>
        )}
      </div>
    </div>
  );
}
