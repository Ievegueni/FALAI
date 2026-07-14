import { prisma } from "@falai/db";
import { encryptSecret, decryptSecret, maskSecret } from "./crypto.service.js";

export interface SettingView {
  key: string;
  value: string;     // mascarado se isSecret
  isSecret: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

export async function getAllSettings(includeDecrypted = false): Promise<SettingView[]> {
  const rows = await prisma.systemSetting.findMany({ orderBy: { key: "asc" } });
  return rows.map((r) => ({
    key: r.key,
    value: r.isSecret
      ? includeDecrypted
        ? decryptSecret(r.value)
        : maskSecret(r.value)
      : r.value,
    isSecret: r.isSecret,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  }));
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (!row) return null;
  return row.isSecret ? decryptSecret(row.value) : row.value;
}

export async function upsertSetting(params: {
  key: string;
  value: string;
  isSecret?: boolean;
  updatedBy: string;
}): Promise<void> {
  const storedValue = params.isSecret ? encryptSecret(params.value) : params.value;
  await prisma.systemSetting.upsert({
    where: { key: params.key },
    create: {
      key: params.key,
      value: storedValue,
      isSecret: params.isSecret ?? false,
      updatedBy: params.updatedBy,
    },
    update: {
      value: storedValue,
      isSecret: params.isSecret ?? false,
      updatedBy: params.updatedBy,
    },
  });
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.systemSetting.delete({ where: { key } });
}
