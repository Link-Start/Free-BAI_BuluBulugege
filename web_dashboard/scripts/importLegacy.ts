/**
 * 一次性导入脚本：将 all_keys.json 中的账号导入 SQLite
 * 用法：npx ts-node --import tsconfig-paths/register scripts/importLegacy.ts
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const dbPath = path.join(process.cwd(), "dev.db");
const adapter = new PrismaBetterSqlite3({ url: dbPath });
const prisma = new PrismaClient({ adapter });

interface LegacyKey {
  address: string;
  apiKey: string;
  credits: number;
  proxy?: string;
  privateKey?: string;
  sessionCookie?: string;
}

async function importLegacy() {
  const keysPath = path.join(
    process.cwd(),
    "..",
    "web_reverse_chat_bankofai",
    "all_keys.json"
  );

  console.log("读取文件:", keysPath);
  const raw = fs.readFileSync(keysPath, "utf-8");
  const keys: LegacyKey[] = JSON.parse(raw);

  console.log(`共 ${keys.length} 个账号待导入`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const key of keys) {
    try {
      const existing = await prisma.account.findUnique({
        where: { apiKey: key.apiKey },
      });
      if (existing) {
        skipped++;
        continue;
      }

      await prisma.account.create({
        data: {
          address: key.address,
          privateKey: key.privateKey ?? "imported-no-private-key",
          sessionCookie: key.sessionCookie ?? "",
          apiKey: key.apiKey,
          credits: key.credits ?? 100000,
          proxy: key.proxy ?? null,
          status: "ACTIVE",
        },
      });
      imported++;
      if (imported % 50 === 0) {
        console.log(`已导入 ${imported} 个…`);
      }
    } catch (e) {
      errors++;
      console.error(`导入失败 ${key.address}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`\n导入完成！`);
  console.log(`  成功: ${imported}`);
  console.log(`  跳过（已存在）: ${skipped}`);
  console.log(`  失败: ${errors}`);
  console.log(`  总计: ${keys.length}`);
}

importLegacy()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
