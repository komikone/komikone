import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventSummary } from '../lib/api';
import { useTheme } from '../lib/useTheme';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

type YearStat = {
  year: number;
  reg_type: 'return' | 'open';
  total: number;
  purchased_any: number;
};
type StatsData = { years: YearStat[] };

export default function Home() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { toggle, isDark } = useTheme();

  useEffect(() => {
    api.events.list().then(setEvents).catch(() => {});
  }, []);

  const active = events.filter((e) => e.status !== 'complete');
  const past = events.filter((e) => e.status === 'complete');

  return (
    <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <header className="relative bg-red-600 dark:bg-black border-b-4 border-black dark:border-yellow-400 overflow-hidden">
        <div className="halftone-bg absolute inset-0" />
        <div className="relative px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="font-bangers text-5xl text-white dark:text-yellow-400 leading-none">komikone</h1>
            <p className="text-red-200 dark:text-gray-400 text-xs mt-1 uppercase tracking-widest">
              San Diego Comic-Con · Badge Coordinator
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* SDCC official logo */}
            <img
              src="/sdcc-logo.svg"
              alt="San Diego Comic-Con"
              className="h-14 w-auto select-none"
              draggable={false}
            />
            <button
              onClick={toggle}
              className="text-xs text-red-200 dark:text-gray-500 hover:text-white dark:hover:text-yellow-400 border border-red-400 dark:border-gray-700 px-2 py-1 rounded transition-colors uppercase tracking-widest"
            >
              {isDark ? '☀ Day' : '◑ Night'}
            </button>
            <Link
              to="/admin"
              className="text-xs text-red-200 dark:text-gray-500 hover:text-white dark:hover:text-yellow-400 transition-colors uppercase tracking-widest"
            >
              Admin
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Active events */}
        {active.length > 0 && (
          <section>
            <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 mb-4 tracking-wide">Active Events</h2>
            <div className="space-y-4">
              {active.map((e) => (
                <EventCard key={e.id} event={e} token={token} />
              ))}
            </div>
          </section>
        )}

        {/* Stats */}
        <StatsSection />

        {/* Request an invite */}
        <section className="border-2 border-black dark:border-yellow-400 bg-white dark:bg-gray-900 p-6 comic-shadow text-center">
          <h2 className="font-bangers text-3xl text-red-600 dark:text-yellow-400 tracking-wide mb-2">Want In?</h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm mb-5 max-w-md mx-auto">
            This is a private purchasing train. If you're interested in joining future SDCC badge runs, send a request and we'll be in touch.
          </p>
          <a
            href="mailto:tony@tonynguyen.com?subject=SDCC%20Purchasing%20Train%20%E2%80%94%20Invite%20Request"
            className="inline-block font-bangers tracking-wide text-xl bg-red-600 hover:bg-red-700 dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-black text-white px-8 py-2.5 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
          >
            Request an Invite →
          </a>
        </section>

        {/* Instructions */}
        <section>
          <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 mb-4 tracking-wide">How It Works</h2>
          <BuyingInstructions />
        </section>

        {/* Past events */}
        {past.length > 0 && (
          <section>
            <h2 className="font-bangers text-xl text-gray-400 dark:text-gray-600 mb-3 tracking-wide">Past Events</h2>
            <div className="space-y-1">
              {past.map((e) => (
                <div key={e.id} className="text-gray-500 dark:text-gray-600 text-sm">
                  {e.name} — {e.reg_type === 'return' ? 'Return Reg' : 'Open Reg'}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function StatsSection() {
  const [stats, setStats] = useState<StatsData | null>(null);

  useEffect(() => {
    fetch(`${BASE}/api/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) return null;

  const complete = stats.years.filter((y) => y.year < 2026);
  if (complete.length === 0) return null;

  const totalParticipants = complete.reduce((s, y) => s + y.total, 0);
  const totalPurchased = complete.reduce((s, y) => s + y.purchased_any, 0);
  const successRate = Math.round((totalPurchased / totalParticipants) * 100);
  const years = [...new Set(complete.map((y) => y.year))].sort();

  // Build per-year combined totals for the chart
  const yearTotals = years.map((yr) => {
    const rows = complete.filter((y) => y.year === yr);
    const total = rows.reduce((s, y) => s + y.total, 0);
    const bought = rows.reduce((s, y) => s + y.purchased_any, 0);
    return { yr, total, bought, rate: Math.round((bought / total) * 100) };
  });

  const maxTotal = Math.max(...yearTotals.map((y) => y.total));

  // SVG chart dimensions
  const W = 560;
  const H = 140;
  const PAD_L = 32;
  const PAD_B = 28;
  const PAD_T = 14;
  const chartW = W - PAD_L - 8;
  const chartH = H - PAD_B - PAD_T;
  const barW = Math.min(52, Math.floor(chartW / years.length) - 10);
  const gap = chartW / years.length;

  return (
    <section>
      <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 mb-4 tracking-wide">Track Record</h2>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { value: years.length, label: 'Years Running' },
          { value: totalParticipants, label: 'Badges Coordinated' },
          { value: `${successRate}%`, label: 'Success Rate' },
        ].map(({ value, label }) => (
          <div key={label} className="border-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 p-4 comic-shadow text-center">
            <div className="font-bangers text-4xl text-red-600 dark:text-yellow-400 leading-none">{value}</div>
            <div className="text-gray-500 dark:text-gray-500 text-xs mt-1 uppercase tracking-widest">{label}</div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="border-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 p-4 comic-shadow">
        <p className="text-xs text-gray-400 dark:text-gray-600 uppercase tracking-widest mb-3">Participants per year · % got badges</p>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 160 }}>
          {/* Y gridlines */}
          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const y = PAD_T + chartH * (1 - frac);
            return (
              <g key={frac}>
                <line x1={PAD_L} x2={W - 8} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.07} strokeWidth={1} />
                <text x={PAD_L - 4} y={y + 4} textAnchor="end" fontSize={8} fill="currentColor" opacity={0.35}>
                  {Math.round(maxTotal * frac)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {yearTotals.map(({ yr, total, bought, rate }, i) => {
            const cx = PAD_L + gap * i + gap / 2;
            const totalH = (total / maxTotal) * chartH;
            const boughtH = (bought / maxTotal) * chartH;
            const barX = cx - barW / 2;
            const successColor = rate >= 90 ? '#22c55e' : rate >= 75 ? '#eab308' : '#ef4444';

            return (
              <g key={yr}>
                {/* Total bar (background) */}
                <rect
                  x={barX} y={PAD_T + chartH - totalH}
                  width={barW} height={totalH}
                  fill="currentColor" opacity={0.08}
                  rx={2}
                />
                {/* Purchased bar (foreground) */}
                <rect
                  x={barX} y={PAD_T + chartH - boughtH}
                  width={barW} height={boughtH}
                  fill={successColor} opacity={0.85}
                  rx={2}
                />
                {/* Success % label above bar */}
                <text
                  x={cx} y={PAD_T + chartH - totalH - 4}
                  textAnchor="middle" fontSize={9} fontWeight="bold"
                  fill={successColor}
                >
                  {rate}%
                </text>
                {/* Total count inside/below bar */}
                <text
                  x={cx} y={PAD_T + chartH - 5}
                  textAnchor="middle" fontSize={8}
                  fill="currentColor" opacity={0.5}
                >
                  {total}
                </text>
                {/* Year label */}
                <text
                  x={cx} y={H - 6}
                  textAnchor="middle" fontSize={10} fontWeight="bold"
                  fill="currentColor" opacity={0.7}
                >
                  {yr}
                </text>
              </g>
            );
          })}

          {/* Baseline */}
          <line x1={PAD_L} x2={W - 8} y1={PAD_T + chartH} y2={PAD_T + chartH} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} />
        </svg>

        <div className="flex gap-4 mt-2 text-xs text-gray-400 dark:text-gray-600">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500 opacity-85" /> ≥ 90% success
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-yellow-500 opacity-85" /> 75–89%
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500 opacity-85" /> &lt; 75%
          </span>
          <span className="flex items-center gap-1.5 ml-auto">
            <Link to="/stats" className="text-red-500 dark:text-yellow-500 hover:underline">Full stats →</Link>
          </span>
        </div>
      </div>
    </section>
  );
}

// ─── Event cards ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: EventSummary['status'] }) {
  const styles: Record<EventSummary['status'], string> = {
    setup:        'bg-gray-200 text-gray-600 border border-gray-400 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600',
    registration: 'bg-blue-600 text-white border border-blue-400',
    purchasing:   'bg-red-600 text-white border-2 border-black dark:bg-yellow-400 dark:text-black dark:border-black animate-pulse',
    payment:      'bg-purple-600 text-white border border-purple-400',
    complete:     'bg-green-600 text-white border border-green-400 dark:bg-green-800 dark:text-green-300 dark:border-green-600',
  };
  const labels: Record<EventSummary['status'], string> = {
    setup:        'Setting Up',
    registration: 'Registration Open',
    purchasing:   '★ LIVE NOW ★',
    payment:      'Payment Collection',
    complete:     'Complete',
  };
  return (
    <span className={`font-bangers text-sm tracking-wide px-3 py-1 ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function EventCard({ event, token }: { event: EventSummary; token: string }) {
  const isPurchasing = event.status === 'purchasing';
  const isRegistration = event.status === 'registration';
  const isPayment = event.status === 'payment';

  return (
    <div
      className={`border-2 p-5 comic-shadow ${
        isPurchasing
          ? 'border-red-600 bg-red-50 dark:border-yellow-400 dark:bg-yellow-950/20'
          : 'border-black bg-white dark:border-gray-600 dark:bg-gray-900'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bangers text-2xl text-gray-900 dark:text-white tracking-wide leading-tight">{event.name}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5 uppercase tracking-widest">
            {event.reg_type === 'return' ? 'Return Registration' : 'Open Registration'}
          </p>
        </div>
        <StatusBadge status={event.status} />
      </div>

      {token && (
        <div className="flex gap-3 mt-4 flex-wrap">
          {isRegistration && (
            <Link
              to={`/register/${event.id}?token=${token}`}
              className="font-bangers tracking-wide text-base bg-blue-600 hover:bg-blue-700 text-white px-5 py-1.5 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
            >
              Register →
            </Link>
          )}
          {isPurchasing && (
            <Link
              to={`/live/${event.id}?token=${token}`}
              className="font-bangers tracking-wide text-base bg-red-600 hover:bg-red-700 text-white px-5 py-1.5 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-black"
            >
              Open Live Board →
            </Link>
          )}
          {(isPayment || isPurchasing) && (
            <Link
              to={`/payment/${event.id}?token=${token}`}
              className="font-bangers tracking-wide text-base bg-purple-600 hover:bg-purple-700 text-white px-5 py-1.5 border-2 border-purple-400 comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
            >
              Payment Info →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function BuyingInstructions() {
  const sections = [
    {
      title: 'Before Purchase Day',
      items: [
        'Fill out the registration form with your name, Member ID, and desired days.',
        'Tony will confirm your return eligibility and assign you a purchasing coordinator.',
        "If you're bringing a friend, list them as a separate participant with yourself as sponsor.",
      ],
    },
    {
      title: 'On Purchase Day',
      items: [
        'Join the Zoom call — Tony will share the link beforehand.',
        'Coordinators: when you\'re ready to buy for someone, click "Claim" on their row to lock it (prevents double-buying).',
        'After you complete a purchase, check the days you bought and enter your name.',
        'The "Gaps" column shows days that still need to be purchased for each person.',
        'The board auto-refreshes every 8 seconds — no need to manually reload.',
      ],
    },
    {
      title: 'After Purchase Day',
      items: [
        'Go to the Payment page to see exactly what you owe and to whom.',
        'Pay your coordinator via Venmo, Zelle, or PayPal as listed.',
        'Mark yourself as paid once you\'ve sent the money.',
        'Coordinators: enter your payment handles on the Payment page so people can find you.',
      ],
    },
    {
      title: 'Badge Type Notes',
      items: [
        'ADULT — standard badge price.',
        'JUNIOR / MILITARY / SENIOR — discounted price (select JUNIOR badge type when registering).',
        'Preview Night is separate from the Thursday badge and must be purchased independently.',
      ],
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sections.map(({ title, items }) => (
        <div key={title} className="border-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 p-4 comic-shadow">
          <h3 className="font-bangers text-lg text-red-600 dark:text-yellow-400 tracking-wide mb-2">{title}</h3>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item} className="text-gray-700 dark:text-gray-400 text-sm leading-snug flex gap-2">
                <span className="text-red-500 dark:text-yellow-600 mt-0.5 shrink-0">▸</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
