import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { saveUploadedFile } from "@/lib/media";
import { analyzeMedia, PLATFORMS } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";

export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Each file triggers a paid Claude vision call — bound how often one
  // account can hit this endpoint, independent of how many files per call.
  if (!rateLimit(`media-upload:${account.id}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "You're uploading too quickly. Wait a few minutes and try again." }, { status: 429 });
  }

  const { eventId } = await params;
  const event = await prisma.event.findFirst({ where: { id: eventId, accountId: account.id } });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });

  const formData = await request.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files selected. Choose at least one photo or video." }, { status: 400 });
  }

  const created = [];
  const failed: string[] = [];

  for (const file of files) {
    try {
      const saved = await saveUploadedFile(eventId, file);
      const media = await prisma.media.create({
        data: {
          accountId: account.id,
          eventId,
          mediaType: saved.mediaType,
          storagePath: saved.storagePath,
          sourceUrl: saved.sourceUrl,
          status: "ready",
        },
      });

      // Caption generation has its own internal fallback to placeholder
      // text, so a slow or failing model never blocks the upload itself.
      const analysis = await analyzeMedia(media, event, account);
      await prisma.media.update({ where: { id: media.id }, data: analysis.scores });
      await logUsageEvent(account.id, "caption");
      await prisma.draft.createMany({
        data: PLATFORMS.flatMap((platform) =>
          analysis.captions[platform].map((generatedCaption, variantIndex) => ({
            accountId: account.id,
            eventId,
            mediaId: media.id,
            platform,
            variantIndex,
            generatedCaption,
          })),
        ),
      });

      created.push(media);
    } catch (err) {
      failed.push(err instanceof Error ? `${file.name} (${err.message})` : file.name);
    }
  }

  if (created.length === 0) {
    return NextResponse.json(
      { error: failed.length > 0 ? failed.join("; ") : "We couldn't save your upload. Check the file and try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    media: created,
    ...(failed.length > 0 ? { warning: `${failed.length} file(s) failed to upload: ${failed.join(", ")}` } : {}),
  });
}
