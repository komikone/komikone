import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventSummary } from '../lib/api';

export default function Home() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  useEffect(() => {
    api.events.list().then(setEvents).catch(() => {});
  }, []);

  const active = events.filter((e) => e.status !== 'complete');
  const past = events.filter((e) => e.status === 'complete');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="relative bg-black border-b-4 border-yellow-400 overflow-hidden">
        <div className="halftone-bg absolute inset-0" />
        <div className="relative px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="font-bangers text-5xl text-yellow-400 leading-none">komikone</h1>
            <p className="text-gray-400 text-xs mt-1 uppercase tracking-widest">
              San Diego Comic-Con · Badge Coordinator
            </p>
          </div>
          <Link
            to="/admin"
            className="text-xs text-gray-500 hover:text-yellow-400 transition-colors uppercase tracking-widest"
          >
            Admin
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Active events */}
        {active.length > 0 && (
          <section>
            <h2 className="font-bangers text-2xl text-yellow-400 mb-4 tracking-wide">Active Events</h2>
            <div className="space-y-4">
              {active.map((e) => (
                <EventCard key={e.id} event={e} token={token} />
              ))}
            </div>
          </section>
        )}

        {/* Instructions */}
        <section>
          <h2 className="font-bangers text-2xl text-yellow-400 mb-4 tracking-wide">How It Works</h2>
          <BuyingInstructions />
        </section>

        {/* Past events */}
        {past.length > 0 && (
          <section>
            <h2 className="font-bangers text-xl text-gray-600 mb-3 tracking-wide">Past Events</h2>
            <div className="space-y-1">
              {past.map((e) => (
                <div key={e.id} className="text-gray-600 text-sm">
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

function StatusBadge({ status }: { status: EventSummary['status'] }) {
  const styles: Record<EventSummary['status'], string> = {
    setup:        'bg-gray-800 text-gray-400 border border-gray-600',
    registration: 'bg-blue-600 text-white border border-blue-400',
    purchasing:   'bg-yellow-400 text-black border-2 border-black animate-pulse',
    payment:      'bg-purple-600 text-white border border-purple-400',
    complete:     'bg-green-800 text-green-300 border border-green-600',
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
          ? 'border-yellow-400 bg-yellow-950/20'
          : 'border-gray-600 bg-gray-900'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bangers text-2xl text-white tracking-wide leading-tight">{event.name}</h3>
          <p className="text-xs text-gray-500 mt-0.5 uppercase tracking-widest">
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
              className="font-bangers tracking-wide text-base bg-blue-600 hover:bg-blue-500 text-white px-5 py-1.5 border-2 border-blue-400 comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
            >
              Register →
            </Link>
          )}
          {isPurchasing && (
            <Link
              to={`/live/${event.id}?token=${token}`}
              className="font-bangers tracking-wide text-base bg-yellow-400 hover:bg-yellow-300 text-black px-5 py-1.5 border-2 border-black comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
            >
              Open Live Board →
            </Link>
          )}
          {(isPayment || isPurchasing) && (
            <Link
              to={`/payment/${event.id}?token=${token}`}
              className="font-bangers tracking-wide text-base bg-purple-600 hover:bg-purple-500 text-white px-5 py-1.5 border-2 border-purple-400 comic-shadow-sm hover:translate-x-px hover:translate-y-px transition-all"
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
        <div key={title} className="border-2 border-gray-700 bg-gray-900 p-4 comic-shadow">
          <h3 className="font-bangers text-lg text-yellow-400 tracking-wide mb-2">{title}</h3>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item} className="text-gray-400 text-sm leading-snug flex gap-2">
                <span className="text-yellow-600 mt-0.5 shrink-0">▸</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
