import { prisma } from "@/lib/prisma";
import { DEFAULT_SETTINGS } from "@/lib/constants";

class SettingService {
  async get(key: string): Promise<string | null> {
    const setting = await prisma.setting.findUnique({ where: { key } });
    return setting?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getInt(key: string, defaultValue: number): Promise<number> {
    const val = await this.get(key);
    return val ? parseInt(val, 10) : defaultValue;
  }

  async getBool(key: string, defaultValue: boolean): Promise<boolean> {
    const val = await this.get(key);
    return val ? val === "true" : defaultValue;
  }

  async getAll(): Promise<Record<string, string>> {
    const settings = await prisma.setting.findMany();
    return settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
  }

  async initDefaults(): Promise<void> {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = await prisma.setting.findUnique({ where: { key } });
      if (!existing) {
        await prisma.setting.create({ data: { key, value } });
      }
    }
  }
}

export const settingService = new SettingService();
