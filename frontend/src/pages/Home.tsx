import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventSummary } from '../lib/api';
import { useTheme } from '../lib/useTheme';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

type YearStat = { year: number; reg_type: 'return' | 'open'; total: number; purchased_any: number };
type StatsData = { years: YearStat[] };

export default function Home() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { toggle, isDark } = useTheme();
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    api.events.list().then(setEvents).catch(() => {});
  }, []);

  const active = events.filter((e) => e.status !== 'complete');

  return (
    <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Fixed nav */}
      <header className="fixed top-0 left-0 right-0 z-40 bg-black/90 backdrop-blur-sm border-b-2 border-white/10">
        <div className="px-6 py-3 flex items-center justify-between max-w-6xl mx-auto">
          <span className="font-bangers text-2xl text-white tracking-wide">komikone</span>
          <div className="flex items-center gap-5">
            <button
              onClick={toggle}
              className="text-xs text-gray-400 hover:text-yellow-400 transition-colors"
            >
              {isDark ? '☀ Day' : '◑ Night'}
            </button>
            <Link
              to="/admin"
              className="text-xs text-gray-400 hover:text-white transition-colors uppercase tracking-widest"
            >
              Admin
            </Link>
          </div>
        </div>
      </header>

      <HeroSection onRequestInvite={() => setInviteOpen(true)} />

      <main>
        {active.length > 0 && (
          <section className="border-y-4 border-black bg-red-50 dark:bg-red-950/20 scroll-mt-16">
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
              <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 tracking-wide">Active Events</h2>
              {active.map((e) => <EventCard key={e.id} event={e} token={token} />)}
            </div>
          </section>
        )}

        <AboutSection />

        <HowItWorksSection />

        <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
          <StatsSection />

          <WantInSection onOpen={() => setInviteOpen(true)} />
        </div>
      </main>

      <Footer />

      {inviteOpen && <InviteRequestModal onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function HeroSection({ onRequestInvite }: { onRequestInvite: () => void }) {
  const [offsetY, setOffsetY] = useState(0);

  useEffect(() => {
    const onScroll = () => setOffsetY(window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <section className="relative h-screen overflow-hidden bg-black flex items-center justify-center">
      {/* Parallax background layer */}
      <div
        className="absolute inset-0 will-change-transform"
        style={{ transform: `translateY(${offsetY * 0.45}px)` }}
      >
        {/* Speed lines */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'repeating-conic-gradient(from 0deg at 50% 48%, rgba(220,38,38,0.18) 0deg 1.2deg, transparent 1.2deg 5deg)',
          }}
        />
        <div className="halftone-bg absolute inset-0 opacity-25" />
        {/* Ghost SDCC lettering */}
        <div className="absolute inset-0 flex items-center justify-center select-none pointer-events-none">
          <span className="font-bangers text-[38vw] text-red-900 opacity-[0.07] leading-none tracking-wider">
            SDCC
          </span>
        </div>
      </div>

      {/* Content — scrolls slightly slower than page for depth */}
      <div
        className="relative z-10 text-center px-6 max-w-4xl mx-auto"
        style={{ transform: `translateY(${offsetY * 0.12}px)` }}
      >
        {/* Caption label */}
        <div className="inline-block bg-yellow-400 border-2 border-black comic-shadow-sm px-4 py-1 mb-6 -rotate-1">
          <span className="font-bangers text-black text-sm tracking-widest uppercase">
            San Diego Comic-Con · Private Group
          </span>
        </div>

        {/* Title */}
        <h1
          className="font-bangers text-[clamp(4.5rem,18vw,11rem)] text-white leading-none mb-3"
          style={{ textShadow: '5px 5px 0 #dc2626, 11px 11px 0 rgba(0,0,0,0.55)' }}
        >
          komikone
        </h1>

        <p className="text-red-300 text-sm md:text-base uppercase tracking-[0.3em] mb-10 font-medium">
          Badge Coordination · Est. 2020
        </p>

        <div className="flex gap-4 justify-center flex-wrap">
          <button
            onClick={onRequestInvite}
            className="font-bangers tracking-wide text-2xl bg-red-600 hover:bg-red-700 text-white px-10 py-3 border-2 border-white comic-shadow hover:translate-x-px hover:translate-y-px transition-all"
          >
            Request an Invite →
          </button>
          <a
            href="#how-it-works"
            className="font-bangers tracking-wide text-2xl text-white px-10 py-3 border-2 border-white/40 hover:border-white transition-colors"
          >
            How It Works
          </a>
        </div>
      </div>

      {/* SDCC logo */}
      <img
        src="/sdcc-logo.svg"
        alt=""
        className="absolute bottom-8 right-8 h-14 opacity-20 select-none"
        draggable={false}
      />

      {/* Scroll hint */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-gray-600 text-xs uppercase tracking-widest">
        <span className="animate-bounce">↓</span>
      </div>
    </section>
  );
}

// ─── About (comic panels) ─────────────────────────────────────────────────────

function AboutSection() {
  return (
    <section className="bg-white dark:bg-gray-900 border-b-4 border-black dark:border-gray-700">
      <div className="max-w-5xl mx-auto">
        <div className="border-x-4 border-black dark:border-white grid grid-cols-1 md:grid-cols-3">
          {/* Panel 1 — top-left, 2 cols */}
          <div className="md:col-span-2 border-b-4 md:border-r-4 border-black dark:border-white p-7 bg-amber-50 dark:bg-gray-950 relative overflow-hidden flex flex-col justify-between min-h-[220px]">
            <div className="bg-yellow-400 border border-black px-2 py-0.5 inline-block text-xs font-bold uppercase tracking-wider text-black self-start">
              The Challenge
            </div>
            <div className="mt-4">
              <p className="font-bangers text-4xl md:text-5xl text-gray-900 dark:text-white leading-tight">
                SDCC badges sell out in <span className="text-red-600">minutes.</span>
              </p>
              <p className="font-bangers text-4xl md:text-5xl text-gray-900 dark:text-white leading-tight">
                The system is <span className="text-red-600">chaos.</span>
              </p>
            </div>
            <div className="halftone-bg absolute bottom-0 right-0 w-36 h-36 opacity-30 pointer-events-none" />
          </div>

          {/* Panel 2 — right column, spans 2 rows */}
          <div className="md:row-span-2 border-b-4 md:border-b-0 border-black dark:border-white bg-red-600 p-6 relative overflow-hidden flex flex-col items-center justify-center text-center min-h-[180px]">
            <div className="halftone-bg absolute inset-0 opacity-20 pointer-events-none" />
            <p className="relative font-bangers text-white leading-tight mb-3" style={{ fontSize: 'clamp(2.2rem, 5vw, 3.5rem)' }}>
              WE BUY<br />AS A<br />CREW.
            </p>
            <p className="relative text-red-200 text-sm leading-snug max-w-[12rem]">
              Coordinated. Efficient.<br />No one gets left behind.
            </p>
          </div>

          {/* Panel 3 — bottom-left */}
          <div className="border-b-4 md:border-b-0 md:border-r-4 border-black dark:border-white p-5 bg-white dark:bg-gray-900 flex flex-col gap-2 min-h-[140px]">
            <span className="text-2xl">🎯</span>
            <p className="font-bangers text-xl text-gray-900 dark:text-white leading-tight">
              Multiple coordinators buying simultaneously
            </p>
            <p className="text-gray-500 dark:text-gray-400 text-xs">More carts in the water = better odds</p>
          </div>

          {/* Panel 4 — bottom-middle */}
          <div className="md:border-r-4 border-black dark:border-white p-5 bg-white dark:bg-gray-900 flex flex-col gap-2 min-h-[140px]">
            <span className="text-2xl">⚡</span>
            <p className="font-bangers text-xl text-gray-900 dark:text-white leading-tight">
              Live board tracks every badge in real time
            </p>
            <p className="text-gray-500 dark:text-gray-400 text-xs">No confusion, no double-buying</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── How It Works (comic panels) ─────────────────────────────────────────────

function HowItWorksSection() {
  const steps = [
    {
      num: '01',
      color: 'bg-blue-600',
      title: 'Register',
      items: [
        'Fill out the form with your name, Member ID, and desired days.',
        'Tony confirms eligibility and assigns your coordinator.',
        'Bringing a friend? Register them separately with you as sponsor.',
      ],
    },
    {
      num: '02',
      color: 'bg-red-600',
      title: 'Go Live',
      items: [
        'Join the Zoom call on purchase day.',
        'Coordinators claim a row → buy → check off days in real time.',
        'Live board refreshes every 8 seconds. No chaos.',
      ],
    },
    {
      num: '03',
      color: 'bg-purple-600',
      title: 'Pay Up',
      items: [
        'The Payment page shows exactly what you owe and to whom.',
        'Send via Venmo, Zelle, or PayPal.',
        'Mark yourself paid. You\'re done.',
      ],
    },
  ];

  return (
    <section
      id="how-it-works"
      className="bg-amber-50 dark:bg-gray-950 border-y-4 border-black dark:border-gray-700 scroll-mt-16"
    >
      <div className="max-w-5xl mx-auto">
        <div className="px-6 pt-8">
          <h2 className="font-bangers text-4xl text-red-600 dark:text-yellow-400 tracking-wide">
            How It Works
          </h2>
        </div>
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 border-t-4 border-black dark:border-gray-700">
          {steps.map((step, i) => (
            <div
              key={step.num}
              className={`p-6 bg-white dark:bg-gray-900 ${
                i < steps.length - 1
                  ? 'border-b-4 md:border-b-0 md:border-r-4 border-black dark:border-gray-700'
                  : ''
              }`}
            >
              <div
                className={`${step.color} text-white font-bangers text-4xl w-12 h-12 flex items-center justify-center border-2 border-black comic-shadow-sm mb-4`}
              >
                {step.num}
              </div>
              <h3 className="font-bangers text-3xl text-gray-900 dark:text-white tracking-wide mb-3">
                {step.title}
              </h3>
              <ul className="space-y-2">
                {step.items.map((item) => (
                  <li key={item} className="text-gray-700 dark:text-gray-400 text-sm leading-snug flex gap-2">
                    <span className="text-red-500 dark:text-yellow-600 shrink-0 mt-0.5">▸</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Badge type notes */}
        <div className="border-t-4 border-black dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 px-6 py-4">
          <p className="text-xs text-gray-500 dark:text-gray-500 uppercase tracking-widest mb-2 font-bold">Badge Type Notes</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
            <span><strong className="text-gray-800 dark:text-gray-200">ADULT</strong> — standard price</span>
            <span><strong className="text-gray-800 dark:text-gray-200">JUNIOR / MILITARY / SENIOR</strong> — discounted (select JUNIOR when registering)</span>
            <span><strong className="text-gray-800 dark:text-gray-200">Preview Night</strong> — separate from Thursday, purchased independently</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Want In ─────────────────────────────────────────────────────────────────

function WantInSection({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="border-2 border-black dark:border-yellow-400 bg-white dark:bg-gray-900 p-6 comic-shadow">
      <h2 className="font-bangers text-3xl text-red-600 dark:text-yellow-400 tracking-wide mb-1">Want In?</h2>
      <p className="text-gray-600 dark:text-gray-400 text-sm mb-5">
        This is a private purchasing train. Space is limited — if someone in the group referred you,
        reach out and we'll get you on the list.
      </p>
      <button
        onClick={onOpen}
        className="font-bangers tracking-wide text-xl bg-red-600 hover:bg-red-700 dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-black text-white px-8 py-2.5 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
      >
        Request an Invite →
      </button>
    </section>
  );
}

// ─── Invite Request Modal ─────────────────────────────────────────────────────

function InviteRequestModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ email: '', referred_by: '', notes: '' });
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('submitting');
    setErrorMsg('');
    try {
      await api.inviteRequests.submit(form);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong');
      setStatus('error');
    }
  };

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const inputCls =
    'w-full bg-gray-50 dark:bg-gray-800 border-2 border-black dark:border-gray-600 px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-red-500 dark:focus:border-yellow-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md border-2 border-black dark:border-yellow-400 bg-white dark:bg-gray-900 comic-shadow">
        <div className="flex items-center justify-between border-b-2 border-black dark:border-gray-700 px-5 py-3">
          <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 tracking-wide">
            Request an Invite
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 dark:hover:text-white text-xl leading-none">
            ✕
          </button>
        </div>

        {status === 'done' ? (
          <div className="p-8 text-center">
            <div className="text-5xl mb-3">✓</div>
            <p className="font-bangers text-xl text-red-600 dark:text-yellow-400 tracking-wide mb-1">
              Request Received!
            </p>
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              We'll review your request and reach out soon.
            </p>
            <button
              onClick={onClose}
              className="mt-5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                Email *
              </label>
              <input
                type="email"
                required
                value={form.email}
                onChange={set('email')}
                placeholder="you@example.com"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                Who referred you? *
              </label>
              <input
                type="text"
                required
                value={form.referred_by}
                onChange={set('referred_by')}
                placeholder="Name of the group member who told you about this"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                Anything else?{' '}
                <span className="normal-case text-gray-400">(optional)</span>
              </label>
              <textarea
                value={form.notes}
                onChange={set('notes')}
                placeholder="Returning member ID, badge type you need, years attending, etc."
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </div>

            {status === 'error' && (
              <p className="text-red-500 dark:text-red-400 text-sm">{errorMsg}</p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={status === 'submitting'}
                className="font-bangers tracking-wide text-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-black text-white px-8 py-2 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
              >
                {status === 'submitting' ? 'Sending…' : 'Submit →'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
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

  const FOUNDING_YEAR = 2018;
  const currentYear = new Date().getFullYear();
  const yearsRunning = currentYear - FOUNDING_YEAR + 1;

  const complete = stats.years.filter((y) => y.year < currentYear && y.year >= currentYear - 3);
  if (complete.length === 0) return null;

  const totalParticipants = complete.reduce((s, y) => s + y.total, 0);
  const totalPurchased = complete.reduce((s, y) => s + y.purchased_any, 0);
  const successRate = Math.round((totalPurchased / totalParticipants) * 100);
  const years = [...new Set(complete.map((y) => y.year))].sort();

  const yearTotals = years.map((yr) => {
    const rows = complete.filter((y) => y.year === yr);
    const total = rows.reduce((s, y) => s + y.total, 0);
    const bought = rows.reduce((s, y) => s + y.purchased_any, 0);
    return { yr, total, bought, rate: Math.round((bought / total) * 100) };
  });

  const maxTotal = Math.max(...yearTotals.map((y) => y.total));

  const W = 560, H = 140, PAD_L = 32, PAD_B = 28, PAD_T = 14;
  const chartW = W - PAD_L - 8;
  const chartH = H - PAD_B - PAD_T;
  const barW = Math.min(52, Math.floor(chartW / years.length) - 10);
  const gap = chartW / years.length;

  return (
    <section>
      <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 mb-4 tracking-wide">
        Track Record
      </h2>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { value: yearsRunning, label: 'Years Running' },
          { value: totalParticipants, label: 'Badges Coordinated' },
          { value: `${successRate}%`, label: 'Success Rate' },
        ].map(({ value, label }) => (
          <div
            key={label}
            className="border-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 p-4 comic-shadow text-center"
          >
            <div className="font-bangers text-4xl text-red-600 dark:text-yellow-400 leading-none">{value}</div>
            <div className="text-gray-500 dark:text-gray-500 text-xs mt-1 uppercase tracking-widest">{label}</div>
          </div>
        ))}
      </div>

      <div className="border-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 p-4 comic-shadow">
        <p className="text-xs text-gray-400 dark:text-gray-600 uppercase tracking-widest mb-3">
          Participants per year · % got badges
        </p>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 160 }}>
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

          {yearTotals.map(({ yr, total, bought, rate }, i) => {
            const cx = PAD_L + gap * i + gap / 2;
            const totalH = (total / maxTotal) * chartH;
            const boughtH = (bought / maxTotal) * chartH;
            const barX = cx - barW / 2;
            const successColor = rate >= 90 ? '#22c55e' : rate >= 75 ? '#eab308' : '#ef4444';
            return (
              <g key={yr}>
                <rect x={barX} y={PAD_T + chartH - totalH} width={barW} height={totalH} fill="currentColor" opacity={0.08} rx={2} />
                <rect x={barX} y={PAD_T + chartH - boughtH} width={barW} height={boughtH} fill={successColor} opacity={0.85} rx={2} />
                <text x={cx} y={PAD_T + chartH - totalH - 4} textAnchor="middle" fontSize={9} fontWeight="bold" fill={successColor}>
                  {rate}%
                </text>
                <text x={cx} y={PAD_T + chartH - 5} textAnchor="middle" fontSize={8} fill="currentColor" opacity={0.5}>
                  {total}
                </text>
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={10} fontWeight="bold" fill="currentColor" opacity={0.7}>
                  {yr}
                </text>
              </g>
            );
          })}

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

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t-4 border-black dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-8">
      <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="text-center sm:text-left">
          <p className="font-bangers text-xl text-gray-900 dark:text-white tracking-wide">komikone</p>
          <p className="text-gray-400 dark:text-gray-600 text-xs mt-0.5">
            Built with ☕ for the SDCC crew
          </p>
        </div>
        <a
          href="https://buymeacoffee.com/tonynguyen"
          target="_blank"
          rel="noopener noreferrer"
          className="font-bangers tracking-wide text-lg bg-yellow-400 hover:bg-yellow-300 text-black px-6 py-2 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all flex items-center gap-2 whitespace-nowrap"
        >
          ☕ Buy me a coffee
        </a>
      </div>
    </footer>
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
          <h3 className="font-bangers text-2xl text-gray-900 dark:text-white tracking-wide leading-tight">
            {event.name}
          </h3>
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
