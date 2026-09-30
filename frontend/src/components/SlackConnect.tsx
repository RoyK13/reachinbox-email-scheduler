import { toast } from 'sonner';
import { useSlackDisconnect, useSlackStatus } from '../hooks/queries';
import { urls } from '../services/api';
import { Button } from './ui/Button';

function SlackLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#E01E5A" d="M5.04 15.17a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52Zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 1 1-5.04 0v-6.31Z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83Zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31Z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83Zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31Z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31Z" />
    </svg>
  );
}

/** Slack connection card: real OAuth connect, status from the API, disconnect. */
export function SlackConnect() {
  const { data, isPending, isError, refetch } = useSlackStatus();
  const disconnect = useSlackDisconnect();

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <SlackLogo />
        Slack alerts
      </div>
      {isPending ? (
        <p className="mt-1 text-xs text-faint">Checking connection…</p>
      ) : isError ? (
        <button type="button" onClick={() => void refetch()} className="mt-1 text-xs text-red-600 hover:underline">
          Couldn’t load status — retry
        </button>
      ) : data.connected ? (
        <>
          <p className="mt-1 text-xs text-muted">
            <span className="mr-1 inline-block size-1.5 rounded-full bg-brand-600 align-middle" />
            Connected{data.teamName ? ` to ${data.teamName}` : ''}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 -ml-2 text-red-600 hover:text-red-700"
            loading={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () => toast.success('Slack disconnected'),
                onError: (err) => toast.error(err.message),
              })
            }
          >
            Disconnect
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">Get notified when a sender hits its hourly limit.</p>
          <Button
            variant="outline"
            size="sm"
            pill
            className="mt-2 w-full"
            onClick={() => {
              window.location.href = urls.slackConnect;
            }}
          >
            Connect Slack
          </Button>
        </>
      )}
    </div>
  );
}
