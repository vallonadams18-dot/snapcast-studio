-- AlterTable
ALTER TABLE "Session" ADD COLUMN "impersonatedByAccountId" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorAccountId" TEXT,
    "targetAccountId" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminNote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "estimatedCostCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OnboardingChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingChecklistItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Account" ("brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "guestPortalEnabled", "id", "passwordHash", "trustModeEnabled", "webhookSecret") SELECT "brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "guestPortalEnabled", "id", "passwordHash", "trustModeEnabled", "webhookSecret" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AuditLog_targetAccountId_createdAt_idx" ON "AuditLog"("targetAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "AdminNote_accountId_createdAt_idx" ON "AdminNote"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_accountId_createdAt_idx" ON "UsageEvent"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "OnboardingChecklistItem_accountId_idx" ON "OnboardingChecklistItem"("accountId");
