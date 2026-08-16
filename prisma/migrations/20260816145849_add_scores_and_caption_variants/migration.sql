-- AlterTable
ALTER TABLE "Media" ADD COLUMN "energyScore" INTEGER;
ALTER TABLE "Media" ADD COLUMN "momentRarityScore" INTEGER;
ALTER TABLE "Media" ADD COLUMN "scoreSummary" TEXT;
ALTER TABLE "Media" ADD COLUMN "visualQualityScore" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Draft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "variantIndex" INTEGER NOT NULL DEFAULT 0,
    "generatedCaption" TEXT NOT NULL,
    "editedCaption" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Draft_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Draft_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Draft" ("accountId", "createdAt", "editedCaption", "eventId", "generatedCaption", "id", "mediaId", "platform", "status", "updatedAt") SELECT "accountId", "createdAt", "editedCaption", "eventId", "generatedCaption", "id", "mediaId", "platform", "status", "updatedAt" FROM "Draft";
DROP TABLE "Draft";
ALTER TABLE "new_Draft" RENAME TO "Draft";
CREATE INDEX "Draft_accountId_eventId_status_idx" ON "Draft"("accountId", "eventId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
