-- CreateTable
CREATE TABLE "GuestClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "guestName" TEXT,
    "guestContact" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestClaim_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GuestClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GuestClaim_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
    "guestPortalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Account" ("brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "id", "passwordHash", "trustModeEnabled", "webhookSecret") SELECT "brandColors", "brandLogoUrl", "brandTone", "businessName", "consecutiveApprovals", "createdAt", "email", "id", "passwordHash", "trustModeEnabled", "webhookSecret" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
CREATE TABLE "new_Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourceMediaId" TEXT,
    "clipStartSeconds" REAL,
    "clipEndSeconds" REAL,
    "musicTrack" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Media_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Media_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "Media" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Media" ("accountId", "createdAt", "eventId", "id", "mediaType", "sourceUrl", "status", "storagePath") SELECT "accountId", "createdAt", "eventId", "id", "mediaType", "sourceUrl", "status", "storagePath" FROM "Media";
DROP TABLE "Media";
ALTER TABLE "new_Media" RENAME TO "Media";
CREATE INDEX "Media_accountId_eventId_idx" ON "Media"("accountId", "eventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "GuestClaim_accountId_eventId_idx" ON "GuestClaim"("accountId", "eventId");
