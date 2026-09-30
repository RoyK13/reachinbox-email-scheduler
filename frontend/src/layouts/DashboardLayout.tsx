import { Clock, Menu, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext } from 'react-router';
import { Logo } from '../components/Logo';
import { SlackConnect } from '../components/SlackConnect';
import { UserMenu } from '../components/UserMenu';
import { useEmailStats } from '../hooks/queries';
import type { AuthUser } from '../types';
import { formatNumber } from '../utils/format';

function NavItem({ to, icon, label, count }: { to: string; icon: React.ReactNode; label: string; count?: number | undefined }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
          isActive ? 'bg-brand-50 font-semibold text-ink' : 'text-ink/80 hover:bg-surface'
        }`
      }
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-xs font-normal text-muted">{formatNumber(count)}</span>}
    </NavLink>
  );
}

function Sidebar({ user }: { user: AuthUser }) {
  const { data: stats } = useEmailStats();
  return (
    <div className="flex h-full flex-col gap-4 px-3 py-4">
      <Link to="/scheduled" className="px-2">
        <Logo />
      </Link>
      <UserMenu user={user} />
      <Link
        to="/compose"
        className="flex h-10 items-center justify-center rounded-full border border-brand-600 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50"
      >
        Compose
      </Link>
      <nav aria-label="Mailboxes" className="flex flex-col gap-1">
        <p className="px-3 pb-1 text-[11px] font-medium tracking-wider text-faint uppercase">Core</p>
        <NavItem to="/scheduled" icon={<Clock className="size-4" aria-hidden />} label="Scheduled" count={stats?.scheduled} />
        <NavItem to="/sent" icon={<Send className="size-4" aria-hidden />} label="Sent" count={stats?.sent} />
      </nav>
      <div className="mt-auto">
        <SlackConnect />
      </div>
    </div>
  );
}

export function DashboardLayout({ user }: { user: AuthUser }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line md:block">
        <Sidebar user={user} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute top-4 right-3 rounded p-1 text-muted"
              onClick={() => setMobileOpen(false)}
            >
              <X className="size-5" />
            </button>
            <Sidebar user={user} />
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
          <button type="button" aria-label="Open menu" className="rounded p-1.5 text-muted" onClick={() => setMobileOpen(true)}>
            <Menu className="size-5" />
          </button>
          <Logo className="text-xl" />
        </div>
        <div className="min-h-0 flex-1">
          <Outlet context={{ user }} />
        </div>
      </main>
    </div>
  );
}

export function useDashboardUser(): AuthUser {
  return useOutletContext<{ user: AuthUser }>().user;
}
