export const AES_KEY = "1wT1r7z8bZxDHVmZKAs6VFYSXOxmyh0lLByiw5TmF0=";
export const BASE_URL = "https://chat.bankofai.io";
export const AUTH_URL = "https://chat.bankofai.io/api/auth";
export const TRPC_URL = "https://chat.bankofai.io/trpc/lambda";
export const API_BASE = "https://api.bankofai.io/v1";

export const POOL_SIZE = 200; // 只使用最新入库的200个参与分配

export const CLOUDBYPASS = {
  host: process.env.CLOUDBYPASS_HOST ?? "gw.cloudbypass.com",
  port: process.env.CLOUDBYPASS_PORT ?? "1288",
  user: process.env.CLOUDBYPASS_USER ?? "",
  pass: process.env.CLOUDBYPASS_PASS ?? "",
  get url() {
    return `http://${this.user}:${this.pass}@${this.host}:${this.port}`;
  },
  get enabled() {
    return !!(this.user && this.pass);
  },
};

// Kookeey dynamic-IP pool（账密模式，socks5 / http 均返回 host:port:user:pass）
export const KOOKEEY = {
  extractUrl: process.env.KOOKEEY_EXTRACT_URL ?? "",
  protocol: (process.env.KOOKEEY_PROTOCOL ?? "socks5") as "socks5" | "http",
  get enabled() {
    return !!this.extractUrl;
  },
};

// Base L2 funder：每个新钱包在 claim 前收到一笔 dust，让 claimSignupBonus 的余额检查通过
export const BASE_CHAIN = {
  rpc: process.env.BASE_RPC ?? "https://mainnet.base.org",
  funderPrivateKey: process.env.FUNDER_PRIVATE_KEY ?? "",
  dustEth: process.env.DUST_ETH ?? "0.00000000001", // 1e-11 ETH = 10,000,000 wei
  get enabled() {
    return !!this.funderPrivateKey;
  },
};

export const DEFAULT_SETTINGS = {
  registration_concurrency: "3",
  proxy_fetch_count: "10",
  quota_check_interval: "300",
  auto_refresh_enabled: "true",
  proxy_api_url: process.env.PROXY_API_URL ?? "",
  litellm_master_key: "sk-bankofai-pool-master",
} as const;
