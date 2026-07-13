import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { api, type EventSummary } from '../lib/api';
import { HeaderUserMenu } from '../components/HeaderUserMenu';
import { useBackgroundImage } from '../lib/useBackgrounds';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const HOME_CONTENT = 'max-w-5xl mx-auto px-6';
const TOUCAN_PROGRESS_GIF = '/walking-toucan-progress-bar.gif';

type YearStat = { year: number; reg_type: 'return' | 'open'; total: number; purchased_any: number };
type StatsData = { years: YearStat[] };

export default function Home() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const { isSignedIn } = useUser();

  useEffect(() => {
    api.events.list().then(setEvents).catch(() => {});
  }, []);

  const active = events.filter((e) => e.status !== 'complete');

  return (
    <div className="min-h-screen bg-amber-50 text-gray-900">
      {/* Fixed nav */}
      <header className="fixed top-0 left-0 right-0 z-40 bg-black/90 backdrop-blur-sm border-b-2 border-white/10">
        <div className="px-6 py-3 flex items-center justify-between max-w-6xl mx-auto">
          <span className="font-bangers text-2xl text-white tracking-wide">komikone</span>
          <div className="flex items-center gap-5">
            {isSignedIn && <HeaderUserMenu />}
          </div>
        </div>
      </header>

      <HeroSection isSignedIn={!!isSignedIn} onRequestAccess={() => setInviteOpen(true)} />

      <main>
        <HomeFeatureBand>
          {active.length > 0 && (
            <section className="border-b-4 border-black dark:border-gray-300 scroll-mt-16">
              <div className={`${HOME_CONTENT} py-6 space-y-4`}>
                <h2 className="font-bangers text-2xl text-red-600 tracking-wide">Active Events</h2>
                {active.map((e) => <EventCard key={e.id} event={e} />)}
              </div>
            </section>
          )}

          <AboutSection />
          <HowItWorksSection />
          <StatsSection />

          {!isSignedIn && (
            <div className={`${HOME_CONTENT} py-10`}>
              <WantInSection onOpen={() => setInviteOpen(true)} />
            </div>
          )}
        </HomeFeatureBand>
      </main>

      <Footer />

      {inviteOpen && <InviteRequestModal onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function HeroSection({ isSignedIn, onRequestAccess }: { isSignedIn: boolean; onRequestAccess: () => void }) {
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
            San Diego Comic-Con · Buying Group
          </span>
        </div>

        {/* Title */}
        <h1
          className="font-bangers text-[clamp(4.5rem,18vw,11rem)] text-white leading-none mb-3"
          style={{ textShadow: '5px 5px 0 #dc2626, 11px 11px 0 rgba(0,0,0,0.55)' }}
        >
          komikone
        </h1>

        <p className="text-red-700 text-sm md:text-base uppercase tracking-[0.3em] mb-10 font-medium">
          Badge Coordination · Est. 2017
        </p>

        {isSignedIn ? (
          <div className="flex gap-4 justify-center flex-wrap">
            <Link
              to="/dashboard"
              className="font-bangers tracking-wide text-2xl bg-red-600 hover:bg-red-700 text-white px-10 py-3 border-2 border-white comic-shadow hover:translate-x-px hover:translate-y-px transition-all"
            >
              Go to Dashboard →
            </Link>
            <a
              href="#how-it-works"
              className="font-bangers tracking-wide text-2xl text-white px-10 py-3 border-2 border-white/40 hover:border-white transition-colors"
            >
              How It Works
            </a>
          </div>
        ) : (
          <InviteEntry onRequestAccess={onRequestAccess}>
            <a
              href="#how-it-works"
              className="inline-block font-bangers tracking-wide text-base text-white/60 hover:text-gray-900 transition-colors mt-2"
            >
              How It Works ↓
            </a>
          </InviteEntry>
        )}
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

// ─── Invite code entry (hero + want in) ───────────────────────────────────────

function InviteEntry({
  onRequestAccess,
  variant = 'dark',
  children,
}: {
  onRequestAccess: () => void;
  variant?: 'dark' | 'light';
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const [inviteCode, setInviteCode] = useState('');

  const goToJoin = () => {
    const code = inviteCode.trim().replace(/^\/join\//i, '').split('/').pop()?.split('?')[0] ?? '';
    if (!code) return;
    navigate(`/join/${code}`);
  };

  const inputCls = variant === 'dark'
    ? 'input-on-light flex-1 bg-white/95 border-2 border-white/40 focus:border-yellow-400 text-gray-900 placeholder:text-gray-500 font-mono text-sm px-4 py-3 outline-none uppercase tracking-wider'
    : 'input-on-light flex-1 bg-gray-50 dark:bg-gray-100 border-2 border-black dark:border-gray-300 focus:border-red-500 dark:focus:border-yellow-400 text-gray-900 dark:text-gray-900 placeholder:text-gray-500 font-mono text-sm px-4 py-3 outline-none uppercase tracking-wider';

  const btnCls = variant === 'dark'
    ? 'font-bangers tracking-wide text-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 border-2 border-white comic-shadow-sm transition-all'
    : 'font-bangers tracking-wide text-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 border-2 border-black dark:border-yellow-400 comic-shadow-sm transition-all';

  const signInCls = variant === 'dark'
    ? 'text-yellow-400/90 hover:text-yellow-300'
    : 'text-red-600 dark:text-yellow-400 hover:underline';

  const requestCls = variant === 'dark'
    ? 'text-gray-400 hover:text-gray-900'
    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-900';

  const mutedCls = variant === 'dark' ? 'text-gray-500' : 'text-gray-500 dark:text-gray-500';
  const muted2Cls = variant === 'dark' ? 'text-gray-600' : 'text-gray-500 dark:text-gray-500';

  return (
    <div className="max-w-md mx-auto space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && goToJoin()}
          placeholder="Invite code"
          className={inputCls}
        />
        <button onClick={goToJoin} disabled={!inviteCode.trim()} className={btnCls}>
          Continue →
        </button>
      </div>
      <p className={`${mutedCls} text-xs`}>
        Already joined?{' '}
        <Link to="/sign-in?redirect=%2Fdashboard" className={`${signInCls} underline underline-offset-2`}>
          Sign in
        </Link>
      </p>
      <p className={`${muted2Cls} text-xs`}>
        Don&apos;t have a code?{' '}
        <button type="button" onClick={onRequestAccess} className={`${requestCls} underline underline-offset-2`}>
          Request access
        </button>
      </p>
      {children}
    </div>
  );
}

// ─── About (comic panels) ─────────────────────────────────────────────────────

function AboutSection() {
  return (
    <section className="border-b-4 border-black dark:border-gray-300">
      <div className={HOME_CONTENT}>
        <div className="border-x-4 border-black dark:border-white grid grid-cols-1 md:grid-cols-3">
          {/* Panel 1 — top-left, 2 cols */}
          <div className="md:col-span-2 border-b-4 md:border-r-4 border-black dark:border-white p-7 bg-amber-50 dark:bg-gray-50 relative overflow-hidden flex flex-col justify-between min-h-[220px]">
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
          <div className="border-b-4 md:border-b-0 md:border-r-4 border-black dark:border-white p-5 bg-white dark:bg-white flex flex-col gap-2 min-h-[140px]">
            <span className="text-2xl">🎯</span>
            <p className="font-bangers text-xl text-gray-900 dark:text-white leading-tight">
              Multiple coordinators buying simultaneously
            </p>
            <p className="text-gray-500 dark:text-gray-400 text-xs">More carts in the water = better odds</p>
          </div>

          {/* Panel 4 — bottom-middle */}
          <div className="md:border-r-4 border-black dark:border-white p-5 bg-white dark:bg-white flex flex-col gap-2 min-h-[140px]">
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

// ─── Feature band (shared background) ─────────────────────────────────────────

function useScrollReveal(ref: RefObject<HTMLElement | null>) {
  const [state, setState] = useState({ progress: 0, parallax: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setState({ progress: 1, parallax: 0 });
      return;
    }

    const update = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const revealStart = vh * 0.92;
      const revealEnd = vh * 0.3;
      const progress = Math.min(1, Math.max(0, (revealStart - rect.top) / (revealStart - revealEnd)));
      const parallax = rect.top < vh && rect.bottom > 0 ? (rect.top - vh * 0.45) * 0.18 : 0;
      setState({ progress, parallax });
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [ref]);

  return state;
}

function HomeFeatureBand({ children }: { children: ReactNode }) {
  const sectionRef = useRef<HTMLElement>(null);
  const { progress, parallax } = useScrollReveal(sectionRef);
  const background = useBackgroundImage();

  const expand = 0.84 + progress * 0.16;
  const bgScale = 1.22 - progress * 0.14;
  const contentLift = (1 - progress) * 32;
  const contentOpacity = 0.55 + progress * 0.45;

  return (
    <section
      ref={sectionRef}
      className="relative border-y-4 border-black dark:border-gray-300 overflow-hidden"
    >
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {background && (
          <div
            className="absolute inset-[-12%] bg-cover bg-center will-change-transform"
            style={{
              backgroundImage: `url(${background})`,
              transform: `translate3d(0, ${parallax}px, 0) scale(${bgScale})`,
            }}
          />
        )}
        <div className="absolute inset-0 bg-white/60" />
      </div>

      <div
        className="relative z-10 will-change-transform"
        style={{
          transform: `scale(${expand}) translateY(${contentLift}px)`,
          transformOrigin: 'center center',
          opacity: contentOpacity,
        }}
      >
        {children}
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
      title: 'Join',
      items: [
        'Use your invite link to create an account and join the group.',
        'Pick your badge days when registration opens.',
        'Add family members on your dashboard — they don\'t need their own account.',
      ],
    },
    {
      num: '02',
      color: 'bg-red-600',
      title: 'Go Live',
      items: [
        'Join the Zoom call on purchase day.',
        'Coordinators claim a row → buy → check off days in real time.',
        'Live board automatically refreshes. No chaos.',
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
        { label: 'Buy me a coffee ☕', href: 'https://buymeacoffee.com/therealtonynguyen' },
      ],
    },
  ];

  return (
    <section id="how-it-works" className="scroll-mt-16">
      <div className={`${HOME_CONTENT} pb-8 pt-8`}>
        <h2 className="font-bangers text-4xl text-red-600 tracking-wide">
          How It Works
        </h2>
        <div className="mt-6 border-4 border-black dark:border-white grid grid-cols-1 md:grid-cols-3 comic-shadow">
          {steps.map((step, i) => (
            <div
              key={step.num}
              className={`p-6 bg-white dark:bg-white relative ${
                i < steps.length - 1
                  ? 'border-b-4 md:border-b-0 md:border-r-4 border-black dark:border-white'
                  : ''
              }`}
            >
              <div
                className={`${step.color} text-white font-bangers text-4xl w-12 h-12 flex items-center justify-center border-2 border-black comic-shadow-sm mb-4`}
              >
                {step.num}
              </div>
              <h3 className="font-bangers text-3xl text-gray-900 tracking-wide mb-3">
                {step.title}
              </h3>
              <ul className="space-y-2">
                {step.items.map((item) => {
                  const key = typeof item === 'string' ? item : item.label;
                  return (
                    <li key={key} className="text-gray-700 text-sm leading-snug flex gap-2">
                      <span className="text-red-500 shrink-0 mt-0.5">▸</span>
                      {typeof item === 'string' ? (
                        item
                      ) : (
                        <a
                          href={item.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-red-600 hover:underline underline-offset-2"
                        >
                          {item.label}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Want In ─────────────────────────────────────────────────────────────────

function WantInSection({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="border-2 border-black dark:border-yellow-400 bg-white dark:bg-white p-6 comic-shadow">
      <h2 className="font-bangers text-3xl text-red-600 dark:text-yellow-400 tracking-wide mb-5 text-center">
        Want In?
      </h2>
      <InviteEntry onRequestAccess={onOpen} variant="light" />
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
    'input-on-light w-full bg-gray-50 dark:bg-gray-100 border-2 border-black dark:border-gray-300 px-3 py-2 text-gray-900 dark:text-gray-900 text-sm focus:outline-none focus:border-red-500 dark:focus:border-yellow-400 placeholder:text-gray-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md border-2 border-black dark:border-yellow-400 bg-white dark:bg-white comic-shadow">
        <div className="flex items-center justify-between border-b-2 border-black dark:border-gray-300 px-5 py-3">
          <h2 className="font-bangers text-2xl text-red-600 dark:text-yellow-400 tracking-wide">
            Request Access
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 dark:hover:text-gray-900 text-xl leading-none">
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
              className="mt-5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-800 underline"
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
                className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-800"
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

function ComicStatBubble({
  value,
  shout,
  caption,
  panelClass,
  tailClass,
  tilt,
}: {
  value: string;
  shout: string;
  caption: string;
  panelClass: string;
  tailClass: string;
  tilt: string;
}) {
  return (
    <div className={`relative ${tilt}`}>
      <div className={`border-4 border-black ${panelClass} px-4 py-6 comic-shadow text-center relative z-10`}>
        <p className="font-bangers text-5xl md:text-6xl text-red-600 leading-none">{value}</p>
        <p className="font-bangers text-xl md:text-2xl text-gray-900 tracking-wide leading-tight mt-2">
          {shout}
        </p>
        <p className="text-gray-700 text-xs mt-2 leading-snug font-medium">{caption}</p>
      </div>
      <span
        className={`absolute -bottom-2 left-8 z-0 block w-5 h-5 border-r-4 border-b-4 border-black rotate-45 ${tailClass}`}
        aria-hidden
      />
    </div>
  );
}

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

  const bubbles = [
    {
      value: String(yearsRunning),
      shout: 'YEARS STRONG!',
      caption: 'Same crew, same mission — badge season after badge season!',
      panelClass: 'bg-amber-50',
      tailClass: 'bg-amber-50',
      tilt: '-rotate-2',
    },
    {
      value: String(totalParticipants),
      shout: 'BADGES COORDINATED!',
      caption: 'Hundreds of badges bought, tracked, and paid off as a team!',
      panelClass: 'bg-yellow-300',
      tailClass: 'bg-yellow-300',
      tilt: 'rotate-2',
    },
    {
      value: `${successRate}%`,
      shout: 'SUCCESS RATE!',
      caption: 'When we go live, the crew gets their badges. BOOM!',
      panelClass: 'bg-white',
      tailClass: 'bg-white',
      tilt: '-rotate-1',
    },
  ];

  return (
    <section className="border-t-4 border-black dark:border-gray-300">
      <div className={`${HOME_CONTENT} py-10`}>
        <h2 className="font-bangers text-2xl text-red-600 mb-6 tracking-wide">
          Track Record
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-6">
          {bubbles.map((bubble) => (
            <ComicStatBubble key={bubble.shout} {...bubble} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t-4 border-black dark:border-gray-300 bg-white dark:bg-white py-8">
      <div className={`${HOME_CONTENT} flex flex-col sm:flex-row items-center justify-between gap-4`}>
        <div className="text-center sm:text-left">
          <p className="font-bangers text-xl text-gray-900 dark:text-white tracking-wide">komikone</p>
          <p className="text-gray-400 dark:text-gray-600 text-xs mt-0.5">
            Built with ☕ for the SDCC crew
          </p>
        </div>
        <a
          href="https://buymeacoffee.com/therealtonynguyen"
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

function ToucanProgressBar() {
  return (
    <div className="mt-4 w-full overflow-hidden">
      <img
        src={TOUCAN_PROGRESS_GIF}
        alt=""
        className="block w-full h-auto"
        draggable={false}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: EventSummary['status'] }) {
  const styles: Record<EventSummary['status'], string> = {
    setup:        'bg-gray-200 text-gray-600 border border-gray-400 dark:bg-gray-100 dark:text-gray-400 dark:border-gray-300',
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

function EventCard({ event }: { event: EventSummary }) {
  const isPurchasing = event.status === 'purchasing';
  const isRegistration = event.status === 'registration';
  const isPayment = event.status === 'payment';

  return (
    <div
      className={`border-2 p-5 comic-shadow ${
        isPurchasing
          ? 'border-red-600 bg-red-50 dark:border-yellow-400 dark:bg-yellow-950/20'
          : 'border-black bg-white dark:border-gray-300 dark:bg-white'
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

      <ToucanProgressBar />

      <div className="flex gap-3 mt-4 flex-wrap items-center">
        {isRegistration && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Registration open — invite link required.
          </p>
        )}
        <Link
          to={`/live/${event.id}`}
          className={`font-bangers tracking-wide text-base px-5 py-1.5 border-2 comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all ${
            isPurchasing
              ? 'bg-red-600 hover:bg-red-700 text-white border-black dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-black'
              : 'bg-zinc-900 hover:bg-zinc-800 text-white border-black'
          }`}
        >
          {isPurchasing ? 'Open Live Board →' : 'View Live Board →'}
        </Link>
        {(isPayment || isPurchasing) && (
          <Link
            to={`/payment/${event.id}`}
            className="font-bangers tracking-wide text-base bg-purple-600 hover:bg-purple-700 text-white px-5 py-1.5 border-2 border-purple-400 comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
          >
            Payment Info →
          </Link>
        )}
      </div>
    </div>
  );
}
