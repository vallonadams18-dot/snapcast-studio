/*
  Warnings:

  - The required column `webhookSecret` was added to the `Account` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "brandLogoUrl" TEXT,
    "brandTone" TEXT NOT NULL DEFAULT 'playful',
    "brandColors" TEXT NOT NULL DEFAULT '[]',
    "webhookSecret" TEXT NOT NULL,
    "consecutiveApprovals" INTEGER NOT NULL DEFAULT 0,
    "trustModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Account" ("brandColors", "brandLogoUrl", "brandTone", "businessName", "createdAt", "email", "id", "passwordHash") SELECT "brandColors", "brandLogoUrl", "brandTone", "businessName", "createdAt", "email", "id", "passwordHash" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
