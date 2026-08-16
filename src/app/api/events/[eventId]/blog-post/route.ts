import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { generateBlogPost } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";
import { isFeatureEnabled } from "@/lib/featureFlags";

const STATUSES = ["approved", "edited"];

export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!(await isFeatureEnabled("blog_posts"))) {
    return NextResponse.json({ error: "Blog post generation is temporarily unavailable." }, { status: 503 });
  }

  if (!rateLimit(`blog-post:${account.id}`, 10, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many blog posts generated at once. Wait a few minutes and try again." }, { status: 429 });
  }

  const { eventId } = await params;
  const event = await prisma.event.findFirst({ where: { id: eventId, accountId: account.id } });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json();
  const inputNotes = typeof body.inputNotes === "string" ? body.inputNotes.trim() : "";
  if (!inputNotes) {
    return NextResponse.json({ error: "Tell us a bit about the event first — highlights, quotes, vibe." }, { status: 400 });
  }

  const approvedDrafts = await prisma.draft.findMany({
    where: { eventId, status: { in: ["approved", "edited"] } },
    take: 10,
  });
  const approvedCaptions = approvedDrafts.map((d) => d.editedCaption ?? d.generatedCaption);

  try {
    const generatedContent = await generateBlogPost(event, account, inputNotes, approvedCaptions);
    await logUsageEvent(account.id, "blog_post");
    const blogPost = await prisma.blogPost.upsert({
      where: { eventId },
      create: { accountId: account.id, eventId, inputNotes, generatedContent },
      update: { inputNotes, generatedContent, editedContent: null, status: "pending" },
    });
    return NextResponse.json(blogPost);
  } catch {
    return NextResponse.json({ error: "Couldn't generate a blog post right now. Try again in a moment." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { eventId } = await params;
  const existing = await prisma.blogPost.findUnique({ where: { eventId } });
  if (!existing || existing.accountId !== account.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json();
  const status = typeof body.status === "string" && STATUSES.includes(body.status) ? body.status : null;
  if (!status) return NextResponse.json({ error: "status must be approved or edited" }, { status: 400 });
  const editedContent = status === "edited" && typeof body.editedContent === "string" ? body.editedContent : undefined;

  const updated = await prisma.blogPost.update({
    where: { eventId },
    data: { status, ...(editedContent !== undefined ? { editedContent } : {}) },
  });
  return NextResponse.json(updated);
}
