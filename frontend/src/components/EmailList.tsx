import { ExternalLink, RotateCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useEmailList } from '../hooks/queries';
import { useDebounce } from '../hooks/useDebounce';
import type { EmailListItem, EmailListKind } from '../types';
import { formatDateTime, formatPillTime } from '../utils/format';
import { Pagination } from './Pagination';
import { StatusBadge } from './StatusBadge';
import { IconButton } from './ui/Button';
import { EmptyState, ErrorState, LoadingState } from './ui/States';

const PAGE_SIZE = 25;

export interface EmailListConfig {
  kind: EmailListKind;
  emptyTitle: string;
  emptyDescription: string;
  /** Timestamp shown in the row tooltip / accessible label. */
  timeLabel: (email: EmailListItem) => string;
  /** Optional compact time shown at the end of the row (the Sent tab's "Sent Time"). */
  rowTime?: (email: EmailListItem) => string | null;
}

/**
 * Shared list used by the Scheduled and Sent tabs: Elasticsearch-backed search,
 * server-side pagination, loading / empty / error states, manual refresh.
 */
export function EmailList({ config }: { config: EmailListConfig }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounce(search.trim(), 300);
  const { data, isPending, isError, error, refetch, isFetching } = useEmailList(config.kind, q, page, PAGE_SIZE);
  const navigate = useNavigate();

  useEffect(() => setPage(1), [q, config.kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar — Figma: rounded search field + refresh */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <label className="relative flex-1">
          <span className="sr-only">Search emails</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient or subject"
            className="h-9 w-full rounded-full bg-surface pr-4 pl-9 text-sm outline-none ring-1 ring-transparent placeholder:text-faint focus:bg-white focus:ring-brand-500"
          />
        </label>
        <IconButton label="Refresh" onClick={() => void refetch()}>
          <RotateCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {isPending ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : data.items.length === 0 ? (
          <EmptyState
            title={q ? `No results for “${q}”` : config.emptyTitle}
            description={q ? 'Try a different recipient address or subject.' : config.emptyDescription}
            action={
              !q && config.kind === 'scheduled' ? (
                <Link to="/compose" className="text-sm font-medium text-brand-700 hover:underline">
                  Compose a new email
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line" aria-label={`${config.kind} emails`}>
            {data.items.map((email) => (
              <li key={email.id}>
                <div
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/emails/${email.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/emails/${email.id}`)}
                  title={config.timeLabel(email)}
                  className="grid cursor-pointer grid-cols-1 gap-1 rounded-md px-3 py-3.5 text-sm hover:bg-surface md:grid-cols-[minmax(160px,220px)_auto_1fr_auto] md:items-center md:gap-4"
                >
                  <span className="truncate font-medium text-ink">
                    <span className="text-muted">To: </span>
                    {email.recipientEmail}
                  </span>
                  <span>
                    <StatusBadge email={email} />
                  </span>
                  <span className="min-w-0 truncate">
                    <span className="font-semibold text-ink">{email.subject}</span>
                    {email.bodyPreview && <span className="text-faint"> - {email.bodyPreview}</span>}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {config.rowTime?.(email) && <span className="whitespace-nowrap">{config.rowTime(email)}</span>}
                    {email.etherealPreviewUrl && (
                      <a
                        href={email.etherealPreviewUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                      >
                        Preview <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPage={setPage} />}
    </div>
  );
}

export function ScheduledEmailsTable() {
  return (
    <EmailList
      config={{
        kind: 'scheduled',
        emptyTitle: 'No scheduled emails',
        emptyDescription: 'Emails you schedule appear here until they are sent.',
        timeLabel: (e) => `Scheduled for ${formatDateTime(e.scheduledAt)}`,
      }}
    />
  );
}

export function SentEmailsTable() {
  return (
    <EmailList
      config={{
        kind: 'sent',
        emptyTitle: 'Nothing sent yet',
        emptyDescription: 'Sent and failed emails show up here once the worker processes them.',
        timeLabel: (e) =>
          e.sentAt ? `Sent ${formatDateTime(e.sentAt)}` : e.failedAt ? `Failed ${formatDateTime(e.failedAt)}` : '',
        rowTime: (e) => {
          const at = e.sentAt ?? e.failedAt;
          return at ? formatPillTime(at) : null;
        },
      }}
    />
  );
}
