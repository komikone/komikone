import { Link, NavLink, Outlet } from 'react-router-dom';
import { DashboardProvider, useDashboard } from './DashboardContext';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/dashboard/profile', label: 'Profile' },
  { to: '/dashboard/registrations', label: 'Registrations' },
  { to: '/dashboard/billing', label: 'Billing' },
  { to: '/dashboard/invitations', label: 'Invitations' },
];

function DashboardShell() {
  const { loading, years, selectedYearId, setSelectedYearId, yearObj, error } = useDashboard();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-gray-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex">
      <aside className="w-56 shrink-0 border-r border-gray-800 bg-gray-900/80 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-800">
          <Link to="/" className="font-bangers text-2xl text-white tracking-wide block">
            komikone
          </Link>
          <p className="text-gray-500 text-xs mt-1">Dashboard</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `block px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600/20 text-blue-300 font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800/60'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-gray-800">
          {years.length > 1 ? (
            <select
              value={selectedYearId ?? ''}
              onChange={(e) => setSelectedYearId(Number(e.target.value))}
              className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-2"
            >
              {years.map((y) => (
                <option key={y.con_year} value={y.con_year}>{y.name}</option>
              ))}
            </select>
          ) : yearObj ? (
            <p className="text-gray-500 text-xs truncate">{yearObj.name}</p>
          ) : null}
          <Link to="/" className="text-gray-600 hover:text-gray-400 text-xs mt-3 block">
            ← Back to home
          </Link>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        {error && (
          <div className="px-6 py-2 bg-red-950/50 border-b border-red-900 text-red-300 text-sm">
            {error}
          </div>
        )}
        <Outlet />
      </main>
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
