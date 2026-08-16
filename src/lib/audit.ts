import { prisma } from "@/lib/prisma";

export async function logAdminAction(params: {
  actorAccountId: string;
  targetAccountId?: string;
  action: string;
  detail?: string;
}) {
  await prisma.auditLog.create({
    data: {
      actorAccountId: params.actorAccountId,
      targetAccountId: params.targetAccountId,
      action: params.action,
      detail: params.detail,
    },
  });
}
