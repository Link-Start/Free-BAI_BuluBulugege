import { settingService } from "./SettingService";
import { fetch as undiciFetch } from "undici";
import { KOOKEEY } from "@/lib/constants";

export interface Proxy {
  url: string;
  ip: string;
  port: number;
  isActive: boolean;
  failCount: number;
  lastUsedAt?: Date;
}

class ProxyPoolService {
  private proxyCache: Proxy[] = [];
  private usedProxies = new Set<string>();
  private failedProxies = new Set<string>();

  // ========== 从 batch_proxy.js 迁移 ==========

  lastFetchDebug = "";

  /**
   * 从 kookeey 提取链接拉一批代理
   * 格式: gate.kookeey.info:1000:user:pass-global-<sessionid>-<duration>m
   */
  async fetchKookeey(): Promise<string[]> {
    if (!KOOKEEY.enabled) { this.lastFetchDebug = "no kookeey url"; return []; }
    try {
      const res = await undiciFetch(KOOKEEY.extractUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PoolManager/1.0)" },
      });
      const text = await res.text();
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const proto = KOOKEEY.protocol;
      const proxies = lines.map((line) => {
        const parts = line.split(":");
        if (parts.length === 4) {
          const [host, port, user, pass] = parts;
          return `${proto}://${user}:${pass}@${host}:${port}`;
        }
        return `${proto}://${line}`;
      });
      this.lastFetchDebug = `kookeey len=${text.length} parsed=${proxies.length} proto=${proto}`;
      return proxies;
    } catch (e) {
      this.lastFetchDebug = `kookeey err: ${e instanceof Error ? e.message : "unknown"}`;
      return [];
    }
  }

  async fetchProxies(): Promise<string[]> {
    const apiUrl = await settingService.get("proxy_api_url");
    if (!apiUrl) { this.lastFetchDebug = "no apiUrl"; return []; }

    try {
      const res = await undiciFetch(apiUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PoolManager/1.0)" },
      });
      const text = await res.text();
      const len = text.length;
      const hasBr = text.includes("<br />");

      let proxies: string[];
      if (hasBr) {
        // Siyetian: ip:port<br />ip:port<br />...
        proxies = text.split("<br />").map((s) => s.trim()).filter(Boolean).map((p) => `http://${p}`);
      } else {
        // 换行分隔
        const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
        proxies = lines.map((line) => {
          // 格式1: user:pass@host:port → 判断是否为 SOCKS5
          if (line.includes("@")) {
            // SOCKS5 网关域名（kookeey 等）使用 socks5://
            if (line.includes("kookeey") || line.includes("socks")) {
              return `socks5://${line}`;
            }
            return `http://${line}`;
          }
          // 格式2: host:port:user:pass → 转换为代理URL
          // Kookeey SOCKS5 粘性: gate.kookeey.info:1000:user:pass-global-12345  (pass 末尾有数字)
          // Kookeey HTTP 旋转: gate.kookeey.info:1000:user:pass-global            (pass 末尾无数字)
          const parts = line.split(":");
          if (parts.length === 4) {
            if (parts[0].includes("kookeey")) {
              // 末尾是数字 → SOCKS5 粘性；否则 → HTTP 每连接换IP
              const isStickySession = /\-\d+$/.test(parts[3]);
              if (isStickySession) {
                return `socks5://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
              } else {
                return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
              }
            }
            return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
          }
          // 格式3: ip:port → 直接加 http://
          return `http://${line}`;
        });
      }
      this.lastFetchDebug = `len=${len} br=${hasBr} parsed=${proxies.length}`;
      return proxies;
    } catch (e) {
      this.lastFetchDebug = `err: ${e instanceof Error ? e.message : 'unknown'}`;
      return [];
    }
  }

  // ========== 代理状态管理 ==========

  async getActiveProxies(count?: number): Promise<string[]> {
    if (this.proxyCache.length === 0) {
      const rawProxies = await this.fetchProxies();
      this.proxyCache = rawProxies.map((url) => {
        const parts = url.replace("http://", "").split(":");
        return {
          url,
          ip: parts[0],
          port: parseInt(parts[1]),
          isActive: true,
          failCount: 0,
        };
      });
    }

    const active = this.proxyCache
      .filter((p) => p.isActive && !this.failedProxies.has(p.url))
      .map((p) => p.url);

    if (count && count > 0) {
      return active.slice(0, count);
    }
    return active;
  }

  markProxyFailed(proxyUrl: string) {
    this.failedProxies.add(proxyUrl);
    const proxy = this.proxyCache.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.failCount++;
      if (proxy.failCount >= 2) {
        proxy.isActive = false;
      }
    }
  }

  markProxySuccess(proxyUrl: string) {
    this.usedProxies.add(proxyUrl);
    const proxy = this.proxyCache.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.lastUsedAt = new Date();
      proxy.failCount = 0;
    }
  }

  async retireProxy(proxyUrl: string) {
    this.failedProxies.add(proxyUrl);
    const proxy = this.proxyCache.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.isActive = false;
    }
  }

  getStats() {
    return {
      total: this.proxyCache.length,
      active: this.proxyCache.filter((p) => p.isActive).length,
      used: this.usedProxies.size,
      failed: this.failedProxies.size,
    };
  }

  reset() {
    this.proxyCache = [];
    this.failedProxies.clear();
    this.usedProxies.clear();
  }
}

export const proxyPoolService = new ProxyPoolService();
