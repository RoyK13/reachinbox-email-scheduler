import { Clock, Loader2 } from 'lucide-react';
import type { EmailListItem } from '../types';
import { formatPillTime } from '../utils/format';

/**
 * Figma pills: scheduled = orange clock pill with the send time,
 * sent = grey "Sent" pill. Failed adds a red variant.
 */
export function StatusBadge({ email }: { email: Pick<EmailListItem, 'status' | 'scheduledAt' | 'errorMessage'> }) {
  switch (email.status) {
    case 'SCHEDULED':
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-pending-line bg-pending-bg px-2 py-0.5 text-xs font-medium text-pending-fg">
          <Clock className="size-3" aria-hidden />
          {formatPillTime(email.scheduledAt)}
        </span>
      );
    case 'SENDING':
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Sending
        </span>
      );
    case 'SENT':
      return (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-[#ededed] px-2 py-0.5 text-xs font-medium text-ink">
          Sent
        </span>
      );
    case 'FAILED':
      return (
        <span
          title={email.errorMessage ?? undefined}
          className="inline-flex items-center whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600"
        >
          Failed
        </span>
      );
  }
}
