import { PrismaClient } from "@prisma/client";

// One client per process. In dev, Next.js hot reload re-evaluates modules, so cache on globalThis
// to avoid exhausting SQLite/Postgres connections.
const globalForPrisma = globalThis as unknown as { __copyfomoPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__copyfomoPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__copyfomoPrisma = prisma;

/**
 * Read a JSON value from the Kv table. The value is returned as-is (typed by the caller):
 * callers that read data written by another process should validate it.
 * A corrupt (non-JSON) row reads as missing.
 */
export async function kvGet<T>(key: string): Promise<{ value: T; updatedAt: Date } | null> {
  const row = await prisma.kv.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

/** Upsert a JSON value. Always bumps `updatedAt` (used as the freshness timestamp). */
export async function kvSet(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value) ?? "null";
  await prisma.kv.upsert({
    where: { key },
    create: { key, value: serialized },
    update: { value: serialized },
  });
}
