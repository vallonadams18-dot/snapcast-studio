import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
  // Busy timeout: on a write-lock collision, wait rather than immediately
  // throwing SQLITE_BUSY. (The adapter passes this straight through to
  // better-sqlite3's Options — it has no `pragmas` option, so journal_mode
  // is set separately below.)
  timeout: 5000,
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

// WAL lets readers run concurrently with a writer instead of blocking on it —
// the difference between "fine" and "users see timeouts" once someone reviews
// drafts while an upload is writing. It's a persistent property of the
// database file, so this only has to succeed once, but it's cheap to re-assert
// on boot and makes a fresh deploy self-configuring.
//
// NOTE: SQLite is a single-writer database. If this app ever runs as multiple
// instances against one file, that's the point to move to Postgres.
if (!globalForPrisma.prisma) {
  prisma
    .$executeRawUnsafe("PRAGMA journal_mode = WAL")
    .catch((err) => console.error("[prisma] Could not enable WAL mode", err));
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
