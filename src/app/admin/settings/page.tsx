import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { KNOWN_FLAGS } from "@/lib/featureFlags";
import { FeatureFlagToggle } from "./FeatureFlagToggle";

export default async function AdminSettingsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");

  const existingFlags = await prisma.featureFlag.findMany();
  const flagMap = new Map(existingFlags.map((f) => [f.key, f.enabled]));

  return (
    <div className="mx-auto w-full max-w-2xl p-6 text-neutral-200">
      <a href="/admin" className="tap-scale text-sm text-neutral-500 underline">
        ← Admin dashboard
      </a>
      <h1 className="mb-1 mt-2 text-xl font-bold text-white">Global settings</h1>
      <p className="mb-6 text-sm text-neutral-500">Platform-wide feature flags — off switches for every client at once.</p>

      <div className="flex flex-col gap-2">
        {KNOWN_FLAGS.map((flag) => (
          <FeatureFlagToggle
            key={flag.key}
            flagKey={flag.key}
            description={flag.description}
            initialEnabled={flagMap.get(flag.key) ?? true}
          />
        ))}
      </div>
    </div>
  );
}
