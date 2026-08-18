import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getStorageAdapter } from "@/lib/storage";
import {
  isBrandSlot,
  maxBytesForSlot,
  validateBrandUpload,
  brandAssetKey,
  type BrandSlot,
} from "@/lib/brandAssets";
import { MAX_SNIFF_BYTES } from "@/lib/webhooks/safeDownload";
import type { Account } from "@/generated/prisma/client";

// The Brand Kit state the UI needs — preview URLs only, never storage refs.
// (For local storage the ref is a server disk path; that must not leak.)
function brandKitSnapshot(account: Account) {
  return {
    logoPreviewUrl: account.brandLogoAssetUrl ?? account.brandLogoUrl,
    hasLogo: Boolean(account.brandLogoAssetUrl || account.brandLogoUrl),
    introKind: account.introKind,
    introPreviewUrl: account.introAssetUrl,
    outroKind: account.outroKind,
    outroPreviewUrl: account.outroAssetUrl,
  };
}

export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const slot = form.get("slot");
  const file = form.get("file");
  if (!isBrandSlot(slot)) {
    return NextResponse.json({ error: "slot must be logo, intro, or outro" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  // Cheap size gate before touching the bytes; the authoritative check runs
  // against the real buffer length inside validateBrandUpload.
  if (file.size > maxBytesForSlot(slot)) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Filename, extension, and file.type are untrusted and unused — the leading
  // bytes decide what this file is.
  const verdict = validateBrandUpload(slot, buffer.subarray(0, MAX_SNIFF_BYTES), buffer.byteLength);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: 415 });
  }

  const key = brandAssetKey(account.id, slot, verdict.detected.extension);
  const saved = await getStorageAdapter().save(key, buffer, verdict.detected.contentType);

  // Each upload writes NEW storage bytes under a fresh key and only repoints
  // the account row. Previous asset files are left in place on purpose:
  // rendered videos have the old pixels burned in and reference nothing, but
  // an in-flight render may still be reading the old file, and a cleanup
  // system that deletes media is exactly the kind of thing that eventually
  // deletes the wrong file. Orphaned brand assets are tiny; leave them.
  const data =
    slot === "logo"
      ? { brandLogoAssetPath: saved.storageRef, brandLogoAssetUrl: saved.url }
      : slot === "intro"
        ? {
            introKind: verdict.detected.kind === "video" ? "video" : "image",
            introAssetPath: saved.storageRef,
            introAssetUrl: saved.url,
          }
        : {
            outroKind: verdict.detected.kind === "video" ? "video" : "image",
            outroAssetPath: saved.storageRef,
            outroAssetUrl: saved.url,
          };

  const updated = await prisma.account.update({ where: { id: account.id }, data });
  return NextResponse.json(brandKitSnapshot(updated));
}

export async function DELETE(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let slot: BrandSlot;
  try {
    const body = await request.json();
    if (!isBrandSlot(body?.slot)) throw new Error("bad slot");
    slot = body.slot;
  } catch {
    return NextResponse.json({ error: "slot must be logo, intro, or outro" }, { status: 400 });
  }

  // Clears the REFERENCE only — stored bytes stay (see the note in POST).
  // Removing the logo clears the legacy URL too: "Remove" that silently
  // resurrects an old URL the client typed months ago would be confusing.
  const data =
    slot === "logo"
      ? { brandLogoAssetPath: null, brandLogoAssetUrl: null, brandLogoUrl: null }
      : slot === "intro"
        ? { introKind: "none", introAssetPath: null, introAssetUrl: null }
        : { outroKind: "none", outroAssetPath: null, outroAssetUrl: null };

  const updated = await prisma.account.update({ where: { id: account.id }, data });
  return NextResponse.json(brandKitSnapshot(updated));
}
