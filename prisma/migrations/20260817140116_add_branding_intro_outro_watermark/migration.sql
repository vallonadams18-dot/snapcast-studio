-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'client',
    "planEventsPerMonth" INTEGER NOT NULL DEFAULT 5,
    "extraCredits" INTEGER NOT NULL DEFAULT 0,
    "periodEventsUsed" INTEGER NOT NULL DEFAULT 0,
    "periodStartedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "brandLogoUrl" TEXT,
    "brandTone" TEXT NOT NULL DEFAULT 'playful',
    "brandColors" TEXT NOT NULL DEFAULT '[]',
    "webhookSecret" TEXT NOT NULL,
    "consecutiveApprovals" INTEGER NOT NULL DEFAULT 0,
    "trustModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "guestPortalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "introEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outroEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outroText" TEXT,
    "watermarkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "watermarkPosition" TEXT NOT NULL DEFAULT 'bottom-right',
    "watermarkOpacity" REAL NOT NULL DEFAULT 0.65,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Account" ("brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "extraCredits", "guestPortalEnabled", "id", "passwordHash", "periodEventsUsed", "periodStartedAt", "planEventsPerMonth", "role", "trustModeEnabled", "webhookSecret") SELECT "brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "extraCredits", "guestPortalEnabled", "id", "passwordHash", "periodEventsUsed", "periodStartedAt", "planEventsPerMonth", "role", "trustModeEnabled", "webhookSecret" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
