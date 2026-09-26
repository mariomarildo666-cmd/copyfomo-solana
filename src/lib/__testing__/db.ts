// Test helper: a throwaway SQLite database with the current Prisma schema (never the project's dev.db).
// Call createTestDatabase() BEFORE importing anything that imports ../db: the Prisma client reads
// DATABASE_URL when it is constructed. Each `node --test` file runs in its own process.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTestDatabase(): { url: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "copyfomo-test-"));
  const url = `file:${join(dir, "test.db").replace(/\\/g, "/")}`;
  const cli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [cli, "db", "push", "--skip-generate", "--schema", join(process.cwd(), "prisma", "schema.prisma")], {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  process.env.DATABASE_URL = url;
  return {
    url,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may still hold the file open; the OS temp dir is cleaned eventually */
      }
    },
  };
}
