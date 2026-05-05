import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/accounts — 批量导入账号（用于本地注册后推送到远程服务器）
 * Body: { accounts: [{ address, privateKey, sessionCookie, apiKey, credits, proxy }] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const accounts = body.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return NextResponse.json({ error: "accounts array required" }, { status: 400 });
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const acc of accounts) {
      if (!acc.address || !acc.apiKey) {
        skipped++;
        continue;
      }
      try {
        // 跳过已存在的（按 apiKey 去重）
        const existing = await prisma.account.findFirst({
          where: { apiKey: acc.apiKey },
        });
        if (existing) {
          skipped++;
          continue;
        }
        await prisma.account.create({
          data: {
            address: acc.address,
            privateKey: acc.privateKey ?? "",
            sessionCookie: acc.sessionCookie ?? "",
            apiKey: acc.apiKey,
            credits: acc.credits ?? 500000,
            proxy: acc.proxy ?? null,
            status: acc.status ?? "ACTIVE",
          },
        });
        imported++;
      } catch (e) {
        errors.push(`${acc.apiKey?.slice(0, 10)}: ${e instanceof Error ? e.message : "unknown"}`);
        skipped++;
      }
    }

    return NextResponse.json({ imported, skipped, errors });
  } catch (error) {
    console.error("Import accounts error:", error);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "50");

    const where = status ? { status: status as "ACTIVE" | "DEPLETED" | "DEAD" | "REGISTERING" } : {};

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          address: true,
          apiKey: true,
          credits: true,
          status: true,
          proxy: true,
          createdAt: true,
          lastCheckAt: true,
          lastUsedAt: true,
        },
      }),
      prisma.account.count({ where }),
    ]);

    return NextResponse.json({
      accounts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Fetch accounts error:", error);
    return NextResponse.json({ error: "Fetch failed" }, { status: 500 });
  }
}
