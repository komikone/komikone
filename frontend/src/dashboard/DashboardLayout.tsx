import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { DashboardProvider, useDashboard } from './DashboardContext';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/dashboard/profile', label: 'Profile' },
  { to: '/dashboard/registrations', label: 'Registrations' },
  { to: '/dashboard/billing', label: 'Billing' },
  { to: '/dashboard/invitations', label: 'Invitations' },
];

function DashboardShell() {
  const {
    loading, years, selectedYearId, setSelectedYearId, yearObj, error, activeEvent, member,
  } = useDashboard();

  const canUseLiveBoard = !!(member?.member_id?.trim());

  const { pathname } = useLocation();
  const mobileNavRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = mobileNavRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab) return;
    const tabRight = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < nav.scrollLeft || tabRight > nav.scrollLeft + nav.clientWidth) {
      nav.scrollTo({ left: tab.offsetLeft - 12, behavior: 'smooth' });
    }
  }, [pathname, loading]);

  /**
   * Rendered twice: as a sidebar on desktop and a horizontal scroller on phones. The
   * sidebar alone used to be a fixed w-56 with no breakpoint, which swallowed most of a
   * phone screen and left the dashboard unusable for anyone signing up on mobile.
   */
  const navLinks = (mobile: boolean) => {
    const base = mobile
      ? 'shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-sm transition-colors'
      : 'block px-3 py-2.5 rounded-lg text-sm transition-colors';
    const idle = 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800/60';
    const active = 'bg-blue-600/20 text-blue-700 dark:text-blue-300 font-medium';

    return (
      <>
        {NAV.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `${base} ${isActive ? active : idle}`}
          >
            {label}
          </NavLink>
        ))}
        {activeEvent && canUseLiveBoard && (
          <Link to={`/live/${activeEvent.id}`} className={`${base} ${idle}`}>
            Live Board
          </Link>
        )}
        {activeEvent && !canUseLiveBoard && member && (
          <Link
            to="/dashboard/profile"
            title="Set your Member ID to open Live Board"
            className={`${base} text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40`}
          >
            Live Board
            {!mobile && (
              <span className="block text-[10px] font-normal text-amber-500/80 normal-case tracking-normal">
                Set Member ID first
              </span>
            )}
          </Link>
        )}
      </>
    );
  };

  const yearPicker = (compact: boolean) =>
    years.length > 1 ? (
      <select
        value={selectedYearId ?? ''}
        onChange={(e) => setSelectedYearId(Number(e.target.value))}
        className={`bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white text-xs rounded-lg px-2 py-2 ${
          compact ? 'shrink-0 max-w-[9rem]' : 'w-full'
        }`}
      >
        {years.map((y) => (
          <option key={y.con_year} value={y.con_year}>{y.name}</option>
        ))}
      </select>
    ) : yearObj && !compact ? (
      <p className="text-gray-500 text-xs truncate">{yearObj.name}</p>
    ) : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white flex flex-col">
        <AppHeader title="Dashboard" />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-400">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white flex flex-col">
      <AppHeader title="Dashboard" />

      <nav ref={mobileNavRef} className="lg:hidden relative shrink-0 flex items-center gap-1.5 overflow-x-auto px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/80">
        {navLinks(true)}
        {yearPicker(true)}
      </nav>

      <div className="flex flex-1 min-h-0">
        <aside className="hidden lg:flex w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/80 flex-col">
          <div className="px-5 py-5 border-b border-gray-200 dark:border-gray-800">
            <p className="text-gray-500 text-xs uppercase tracking-wider">Your account</p>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-0.5">
            {navLinks(false)}
          </nav>

          <div className="px-4 py-4 border-t border-gray-200 dark:border-gray-800">
            {yearPicker(false)}
            <Link to="/" className="text-gray-600 hover:text-gray-400 text-xs mt-3 block">
              ← Back to home
            </Link>
          </div>
        </aside>

        <main className="flex-1 min-w-0 flex flex-col">
          {error && (
            <div className="px-6 py-2 bg-red-50 dark:bg-red-950/50 border-b border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout() {
  return (
    <DashboardProvider>
      <DashboardShell />
    </DashboardProvider>
  );
}
