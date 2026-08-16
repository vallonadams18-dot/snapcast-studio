import { prisma } from "@/lib/prisma";

// Flags default to enabled if no row exists yet — a flag only restricts
// once an admin has explicitly created/toggled it off.
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return flag ? flag.enabled : true;
}

export const KNOWN_FLAGS = [
  { key: "blog_posts", description: "Optional per-event blog post generation" },
  { key: "video_clips", description: "AI highlight clip generation from uploaded video" },
  { key: "photo_montage", description: "Compile event photos into a Ken Burns video slideshow with music" },
  { key: "guest_portal", description: "Public guest photo-claim/share portal" },
];
