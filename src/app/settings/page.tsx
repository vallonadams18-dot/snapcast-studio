import { redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WebhookInfo } from "../WebhookInfo";
import { GuestPortalToggle } from "../GuestPortalToggle";
import { BrandingPanel } from "../BrandingPanel";

export default async function SettingsPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  const claimCount = await prisma.guestClaim.count({ where: { accountId: account.id } });

  const headerList = await headers();
  const origin = `${headerList.get("x-forwarded-proto") ?? "http"}://${headerList.get("host")}`;
  const webhookUrl = `${origin}/api/webhooks/${account.id}`;

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <Link href="/" className="tap-scale inline-flex min-h-11 items-center text-sm text-neutral-500 underline">
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold text-foreground">Settings</h1>
      <p className="mb-6 text-sm text-neutral-500">
        One-time setup for how content reaches Snapcast Studio and how guests can share it.
      </p>

      <BrandingPanel
        brandLogoUrl={account.brandLogoUrl}
        brandLogoAssetUrl={account.brandLogoAssetUrl}
        introKind={account.introKind}
        introAssetUrl={account.introAssetUrl}
        outroKind={account.outroKind}
        outroAssetUrl={account.outroAssetUrl}
        introEnabled={account.introEnabled}
        outroEnabled={account.outroEnabled}
        outroText={account.outroText}
        watermarkEnabled={account.watermarkEnabled}
        watermarkPosition={account.watermarkPosition}
        watermarkOpacity={account.watermarkOpacity}
        watermarkScale={account.watermarkScale}
      />
      <GuestPortalToggle initialEnabled={account.guestPortalEnabled} claimCount={claimCount} />
      <WebhookInfo webhookUrl={webhookUrl} secret={account.webhookSecret} />
    </div>
  );
}
