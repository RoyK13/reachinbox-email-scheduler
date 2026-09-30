import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../services/api';
import type { EmailListKind, ScheduleRequest } from '../types';

export const queryKeys = {
  me: ['me'] as const,
  senders: ['senders'] as const,
  stats: ['emails', 'stats'] as const,
  list: (kind: EmailListKind, q: string, page: number, pageSize: number) => ['emails', kind, { q, page, pageSize }] as const,
  email: (id: string) => ['emails', 'detail', id] as const,
  slack: ['slack', 'status'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: api.me,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });
}

export function useSenders() {
  return useQuery({ queryKey: queryKeys.senders, queryFn: api.senders, staleTime: 5 * 60_000 });
}

export function useEmailStats() {
  return useQuery({ queryKey: queryKeys.stats, queryFn: api.emailStats, refetchInterval: 15_000 });
}

export function useEmailList(kind: EmailListKind, q: string, page: number, pageSize: number) {
  return useQuery({
    queryKey: queryKeys.list(kind, q, page, pageSize),
    queryFn: () => api.listEmails(kind, { q, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useEmail(id: string) {
  return useQuery({ queryKey: queryKeys.email(id), queryFn: () => api.email(id) });
}

export function useSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleRequest) => api.schedule(body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['emails'] }),
  });
}

export function useSlackStatus() {
  return useQuery({ queryKey: queryKeys.slack, queryFn: api.slackStatus });
}

export function useSlackDisconnect() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.slackDisconnect,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.slack }),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      client.clear();
    },
  });
}
