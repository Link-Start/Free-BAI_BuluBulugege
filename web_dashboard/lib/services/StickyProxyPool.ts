import { CLOUDBYPASS } from "@/lib/constants";

export interface StickyProxy {
  url: string;          // http://user:pass@gw.cloudbypass.com:1288
  session: string;      // 完整 session 后缀，如 s1a2b3c4d5e6-5m
  usedCount: number;    // 已注册次数
  isActive: boolean;
  failCount: number;
  createdAt: Date;
}

/**
 * CloudBypass 粘性 IP 代理池
 * 通过 session 后缀控制 IP 固定 5 分钟
 * 每个 session 最多注册 maxUsesPerIp 次，失败自动刷新
 */
export class StickyProxyPool {
  private pool: StickyProxy[] = [];
  private currentIndex = 0;
  private maxUsesPerIp = 8;
  private batchSize = 10;

  /**
   * 生成随机 session 后缀
   * 格式: s{random12chars}-{duration}m
   * 例: s1a2b3c4d5e6-5m
   */
  private generateSession(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let random = "s";
    for (let i = 0; i < 12; i++) {
      random += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${random}-5m`;
  }

  /**
   * 生成一批粘性代理
   * 每个不同的 session 会得到不同的固定 IP
   */
  generateBatch(count: number = this.batchSize): StickyProxy[] {
    const { user, pass, host, port } = CLOUDBYPASS;
    return Array.from({ length: count }, () => {
      const session = this.generateSession();
      return {
        url: `http://${user}_${session}:${pass}@${host}:${port}`,
        session,
        usedCount: 0,
        isActive: true,
        failCount: 0,
        createdAt: new Date(),
      };
    });
  }

  /**
   * 获取下一个可用代理
   * 如果当前池子用尽，自动生成新的一批
   * 注意：获取即占用（usedCount++），防止并发时多人拿到同一个 IP
   */
  getNext(): StickyProxy | null {
    // 清理已用尽或失效的
    this.pool = this.pool.filter(
      (p) => p.isActive && p.usedCount < this.maxUsesPerIp && p.failCount < 1
    );

    if (this.currentIndex >= this.pool.length) {
      this.currentIndex = 0;
    }

    if (this.pool.length === 0) {
      // 池子空了，自动生成新的一批
      const newBatch = this.generateBatch();
      if (newBatch.length === 0) return null;
      this.pool = newBatch;
    }

    const proxy = this.pool[this.currentIndex];
    this.currentIndex++;
    // 立即占用，防止并发重复分配
    proxy.usedCount++;
    return proxy;
  }

  /**
   * 标记代理注册成功（usedCount 已在 getNext 时递增）
   */
  markSuccess(proxy: StickyProxy) {
    proxy.failCount = 0;
  }

  /**
   * 标记代理注册失败
   * 失败 1 次即退役，触发整批刷新
   */
  markFailed(proxy: StickyProxy) {
    proxy.failCount++;
    proxy.isActive = false;
  }

  /**
   * 强制刷新整个代理池
   */
  refresh(count: number = this.batchSize): StickyProxy[] {
    this.pool = [];
    this.currentIndex = 0;
    const newBatch = this.generateBatch(count);
    this.pool = newBatch;
    return newBatch;
  }

  getStats() {
    return {
      total: this.pool.length,
      active: this.pool.filter((p) => p.isActive && p.usedCount < this.maxUsesPerIp).length,
      usedUp: this.pool.filter((p) => p.usedCount >= this.maxUsesPerIp).length,
      failed: this.pool.filter((p) => p.failCount >= 1).length,
    };
  }

  setMaxUsesPerIp(max: number) {
    this.maxUsesPerIp = max;
  }

  setBatchSize(size: number) {
    this.batchSize = size;
  }
}

export const stickyProxyPool = new StickyProxyPool();
