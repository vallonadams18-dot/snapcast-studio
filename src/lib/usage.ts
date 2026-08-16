import { prisma } from "@/lib/prisma";

// Flat per-call-type cost estimates (cents) — not real token accounting,
// just enough for admin cost visibility to be directionally useful.
const ESTIMATED_COST_CENTS: Record<string, number> = {
  caption: 2,
  clip: 15,
  blog_post: 5,
  regenerate: 2,
  montage: 25,
};

export type UsageKind = keyof typeof ESTIMATED_COST_CENTS;

export async function logUsageEvent(accountId: string, kind: UsageKind) {
  await prisma.usageEvent.create({
    data: { accountId, kind, estimatedCostCents: ESTIMATED_COST_CENTS[kind] },
  });
}

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

export interface CreditStatus {
  planEventsPerMonth: number;
  extraCredits: number;
  periodEventsUsed: number;
  remaining: number;
}

// Lazily rolls the monthly period over on read/write (no cron needed at
// this scale) — if periodStartedAt is more than ~30 days old, usage resets
// and a fresh period begins from now.
export async function getCreditStatus(accountId: string): Promise<CreditStatus> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

  if (Date.now() - account.periodStartedAt.getTime() > MS_PER_MONTH) {
    const reset = await prisma.account.update({
      where: { id: accountId },
      data: { periodEventsUsed: 0, periodStartedAt: new Date() },
    });
    return {
      planEventsPerMonth: reset.planEventsPerMonth,
      extraCredits: reset.extraCredits,
      periodEventsUsed: 0,
      remaining: reset.planEventsPerMonth + reset.extraCredits,
    };
  }

  const remaining = account.planEventsPerMonth + account.extraCredits - account.periodEventsUsed;
  return {
    planEventsPerMonth: account.planEventsPerMonth,
    extraCredits: account.extraCredits,
    periodEventsUsed: account.periodEventsUsed,
    remaining,
  };
}

// Call before creating a new Event. Throws with a client-safe message if
// the account is out of credits for the period.
export async function consumeEventCredit(accountId: string): Promise<void> {
  const status = await getCreditStatus(accountId);
  if (status.remaining <= 0) {
    throw new Error(
      `You've used all ${status.planEventsPerMonth + status.extraCredits} events included this period. Contact us to add more credits.`,
    );
  }
  await prisma.account.update({
    where: { id: accountId },
    data: { periodEventsUsed: { increment: 1 } },
  });
}
