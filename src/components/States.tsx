export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-10 text-center">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm text-neutral-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 px-4 py-3">
      <span className="mt-0.5 text-error">⚠</span>
      <div className="flex-1">
        <p className="text-sm text-error">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="tap-scale mt-2 rounded-lg border border-error/40 px-3 py-1 text-xs font-medium text-error"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function SuccessBanner({ message }: { message: string }) {
  return (
    <div className="card-enter flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-4 py-3">
      <span className="text-success">✓</span>
      <p className="text-sm text-success">{message}</p>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="skeleton aspect-square w-full" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-4 w-20 rounded-lg" />
        <div className="skeleton h-4 w-full rounded-lg" />
        <div className="skeleton h-4 w-3/4 rounded-lg" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton aspect-square rounded-xl" />
      ))}
    </div>
  );
}
