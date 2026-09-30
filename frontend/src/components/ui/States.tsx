import { AlertCircle, Inbox, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <span className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-surface text-faint">
        <Inbox className="size-6" aria-hidden />
      </span>
      <p className="font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <span className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-red-50 text-red-500">
        <AlertCircle className="size-6" aria-hidden />
      </span>
      <p className="font-medium text-ink">Something went wrong</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" pill className="mt-4" icon={<RotateCw className="size-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Skeleton rows shaped like the email list rows. */
export function LoadingState({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-6 px-4 py-4">
          <div className="h-3.5 w-40 rounded bg-surface" />
          <div className="h-5 w-32 rounded-full bg-surface" />
          <div className="h-3.5 flex-1 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="size-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" aria-label="Loading" />
    </div>
  );
}
