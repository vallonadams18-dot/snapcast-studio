import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit";

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { accountId } = await params;
  const target = await prisma.account.findFirst({ where: { id: accountId, role: "client" } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json();
  const noteBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!noteBody) return NextResponse.json({ error: "Note can't be empty." }, { status: 400 });

  const note = await prisma.adminNote.create({ data: { accountId, body: noteBody } });
  await logAdminAction({ actorAccountId: admin.id, targetAccountId: accountId, action: "note_added" });

  return NextResponse.json(note);
}
