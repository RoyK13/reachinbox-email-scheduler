import DOMPurify from 'dompurify';
import { ArrowLeft, ExternalLink, Paperclip } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { StatusBadge } from '../components/StatusBadge';
import { Avatar } from '../components/ui/Avatar';
import { ErrorState, FullPageSpinner } from '../components/ui/States';
import { useEmail } from '../hooks/queries';
import { api } from '../services/api';
import { formatBytes, formatDateTime } from '../utils/format';

/** Figma "email view": back arrow + subject, sender row with date, rendered body. */
export function EmailDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: email, isPending, isError, error, refetch } = useEmail(id);
  const safeBody = useMemo(() => (email ? DOMPurify.sanitize(email.body) : ''), [email]);

  if (isPending) return <FullPageSpinner />;
  if (isError) return <ErrorState message={error.message} onRetry={() => void refetch()} />;

  const back = email.status === 'SENT' || email.status === 'FAILED' ? '/sent' : '/scheduled';
  const when = email.sentAt ?? email.failedAt ?? email.scheduledAt;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5 md:px-6">
        <button
          type="button"
          aria-label="Back"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(back))}
          className="rounded p-1 text-ink hover:bg-surface"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-medium">{email.subject}</h1>
        <StatusBadge email={email} />
      </div>

      <article className="px-4 py-6 md:px-16">
        <header className="flex flex-wrap items-start gap-3">
          <Avatar name={email.fromName} size={36} />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-semibold">{email.fromName}</span>{' '}
              <span className="text-muted">&lt;{email.fromEmail}&gt;</span>
            </p>
            <p className="text-xs text-muted">
              to {email.recipientEmail} · via {email.senderEmail}
            </p>
          </div>
          <time className="text-xs text-muted" dateTime={when}>
            {formatDateTime(when)}
          </time>
        </header>

        <div className="email-content mt-6 max-w-3xl text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: safeBody }} />

        {email.attachments.length > 0 && (
          <ul className="mt-6 flex flex-wrap gap-3" aria-label="Attachments">
            {email.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={api.attachmentUrl(a.id)}
                  className="flex w-52 items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs hover:bg-surface"
                >
                  <Paperclip className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{a.filename}</span>
                    <span className="text-muted">{formatBytes(a.size)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <dl className="mt-10 grid max-w-3xl grid-cols-[140px_1fr] gap-y-1.5 rounded-xl bg-surface p-4 text-xs">
          <dt className="text-muted">Scheduled for</dt>
          <dd>{formatDateTime(email.scheduledAt)}</dd>
          {email.sentAt && (
            <>
              <dt className="text-muted">Sent at</dt>
              <dd>{formatDateTime(email.sentAt)}</dd>
            </>
          )}
          {email.failedAt && (
            <>
              <dt className="text-muted">Failed at</dt>
              <dd className="text-red-600">
                {formatDateTime(email.failedAt)} — {email.errorMessage}
              </dd>
            </>
          )}
          <dt className="text-muted">Attempts</dt>
          <dd>{email.attemptCount}</dd>
          {email.messageId && (
            <>
              <dt className="text-muted">Message-ID</dt>
              <dd className="truncate font-mono">{email.messageId}</dd>
            </>
          )}
          {email.etherealPreviewUrl && (
            <>
              <dt className="text-muted">Ethereal</dt>
              <dd>
                <a
                  href={email.etherealPreviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                >
                  Open preview <ExternalLink className="size-3" aria-hidden />
                </a>
              </dd>
            </>
          )}
        </dl>

        <Link to={back} className="mt-6 inline-block text-sm text-brand-700 hover:underline">
          ← Back to {back === '/sent' ? 'Sent' : 'Scheduled'}
        </Link>
      </article>
    </div>
  );
}
