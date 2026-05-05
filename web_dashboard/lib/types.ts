import type { AccountStatus } from "@/app/generated/prisma/client";

export interface RegisterResult {
  success: boolean;
  address?: string;
  privateKey?: string;
  sessionCookie?: string;
  apiKey?: string;
  credits?: number;
  proxy?: string;
  error?: string;
  step?: string;
}

export interface PoolStats {
  total: number;
  active: number;
  depleted: number;
  dead: number;
  registering: number;
}

export interface AccountSafe {
  id: string;
  address: string;
  apiKey: string;
  credits: number;
  status: AccountStatus;
  proxy: string | null;
  createdAt: Date;
  lastCheckAt: Date | null;
  lastUsedAt: Date | null;
}

export interface LogEntry {
  id: string;
  type: "info" | "success" | "warn" | "error";
  message: string;
  timestamp: Date;
}
