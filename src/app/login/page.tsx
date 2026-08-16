"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { ErrorState } from "@/components/States";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Login failed.");
      setSubmitting(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8 shadow-2xl">
        <h1 className="mb-1 bg-gradient-to-r from-primary-purple to-primary-pink bg-clip-text text-3xl font-bold text-transparent">
          Snapcast Studio
        </h1>
        <p className="mb-6 text-sm text-neutral-500">Log in to your account</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="text-sm text-foreground">
            Email
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 min-h-11"
            />
          </label>
          <label className="text-sm text-foreground">
            Password
            <Input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 min-h-11"
            />
          </label>
          {error && <ErrorState message={error} />}
          <Button type="submit" disabled={submitting} className="min-h-11 w-full">
            {submitting ? "Logging in…" : "Log in"}
          </Button>
        </form>
        <p className="mt-6 text-sm text-neutral-500">
          Need an account?{" "}
          <a href="/signup" className="font-medium text-primary-pink underline">
            Sign up
          </a>
        </p>
      </Card>
    </div>
  );
}
