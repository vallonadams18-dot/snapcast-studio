import { redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { OnboardingForm } from "./OnboardingForm";

export default async function OnboardingPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  return <OnboardingForm initialTone={account.brandTone} initialLogoUrl={account.brandLogoUrl ?? ""} />;
}
