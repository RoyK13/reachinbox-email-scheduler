import { ChevronDown, Gauge, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useLogout } from '../hooks/queries';
import { urls } from '../services/api';
import type { AuthUser } from '../types';
import { Avatar } from './ui/Avatar';
import { Popover } from './ui/Popover';

/** Figma sidebar user card (avatar, name, email, chevron) with a dropdown. */
export function UserMenu({ user }: { user: AuthUser }) {
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <Popover
      align="left"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 rounded-xl bg-surface px-2.5 py-2 text-left transition-colors hover:bg-[#efefef]"
        >
          <Avatar name={user.name} src={user.avatarUrl} size={34} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronDown className={`size-4 text-faint transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div className="w-60 p-1.5 text-sm">
          <a
            href={urls.bullBoard}
            target="_blank"
            rel="noreferrer"
            onClick={close}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink hover:bg-surface"
          >
            <Gauge className="size-4 text-muted" aria-hidden />
            Queue dashboard
          </a>
          <button
            type="button"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => {
                  toast.success('Logged out');
                  navigate('/login', { replace: true });
                },
                onError: (err) => toast.error(err.message),
              })
            }
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-red-600 hover:bg-red-50"
          >
            <LogOut className="size-4" aria-hidden />
            Log out
          </button>
        </div>
      )}
    </Popover>
  );
}
