-- AlterTable
ALTER TABLE "Media" ADD COLUMN "musicStartSeconds" REAL;
ALTER TABLE "Media" ADD COLUMN "musicTrackId" TEXT;
ALTER TABLE "Media" ADD COLUMN "musicTrackTitle" TEXT;

-- CreateTable
CREATE TABLE "SavedTrack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "lengthSeconds" INTEGER,
    "waveformUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedTrack_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SavedTrack_accountId_createdAt_idx" ON "SavedTrack"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedTrack_accountId_trackId_key" ON "SavedTrack"("accountId", "trackId");
