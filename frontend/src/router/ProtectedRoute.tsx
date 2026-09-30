import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ErrorState, FullPageSpinner } from '../components/ui/States';
import { queryKeys, useMe } from '../hooks/queries';
import { DashboardLayout } from '../layouts/DashboardLayout';
import { ApiError } from '../services/api';

const SLACK_RESULTS: Record<string, [kind: 'success' | 'error', message: string]> = {
  connected: ['success', 'Slack connected'],
  denied: ['error', 'Slack connection was cancelled'],
  error: ['error', 'Slack connection failed. Please try again.'],
};

/** Handles ?slack=… after the OAuth callback redirect: toast, refresh status, clean the URL. */
function useSlackCallbackToast() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const slack = params.get('slack');
  useEffect(() => {
    if (!slack) return;
    const result = SLACK_RESULTS[slack];
    if (result) toast[result[0]](result[1]);
    void client.invalidateQueries({ queryKey: queryKeys.slack });
    params.delete('slack');
    setParams(params, { replace: true });
  }, [slack, client, params, setParams]);
}

export function ProtectedRoute() {
  const { data: user, isPending, error, refetch } = useMe();
  const location = useLocation();
  useSlackCallbackToast();

  if (isPending) return <FullPageSpinner />;
  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (error || !user) return <ErrorState message={error?.message ?? 'Could not load your account'} onRetry={() => void refetch()} />;
  return <DashboardLayout user={user} />;
}

/** Signed-in users visiting /login go straight to the dashboard. */
export function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { data: user, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  if (user) return <Navigate to="/scheduled" replace />;
  return <>{children}</>;
}
