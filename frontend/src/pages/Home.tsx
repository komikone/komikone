import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventSummary } from '../lib/api';

const STATUS_LABEL: Record<EventSummary['status'], string> = {
  setup: 'Setting up',
  registration: 'Registration open',
  purchasing: 'Purchase day — LIVE',
  payment: 'Payment collection',
  complete: 'Complete',
};

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
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">KomikOne</h1>
          <p className="text-gray-400 text-sm">San Diego Comic-Con Badge Coordinator</p>
        </div>
        <Link to="/admin" className="text-sm text-gray-400 hover:text-white transition-colors">
          Admin
        </Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Active events */}
        {active.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-200 mb-4">Active Events</h2>
            <div className="space-y-3">
              {active.map((e) => (
                <EventCard key={e.id} event={e} token={token} />
              ))}
            </div>
          </section>
        )}

        {/* Instructions */}
        <section className="prose prose-invert max-w-none">
          <h2 className="text-lg font-semibold text-gray-200 mb-4">How It Works</h2>
          <BuyingInstructions />
        </section>

        {/* Past events */}
        {past.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-400 mb-3">Past Events</h2>
            <div className="space-y-2">
              {past.map((e) => (
                <div key={e.id} className="text-gray-500 text-sm">
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

function EventCard({ event, token }: { event: EventSummary; token: string }) {
  const isPurchasing = event.status === 'purchasing';
  const isRegistration = event.status === 'registration';
  const isPayment = event.status === 'payment';

  return (
    <div
      className={`border rounded-lg p-5 ${
        isPurchasing
          ? 'border-yellow-500 bg-yellow-950/30'
          : 'border-gray-700 bg-gray-900'
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-bold text-white text-lg">{event.name}</h3>
          <p className="text-sm text-gray-400 mt-0.5">
            {event.reg_type === 'return' ? 'Return Registration' : 'Open Registration'}
          </p>
        </div>
        <span
          className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            isPurchasing
              ? 'bg-yellow-500 text-yellow-950 animate-pulse'
              : isRegistration
              ? 'bg-blue-600 text-white'
              : isPayment
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700 text-gray-300'
          }`}
        >
          {STATUS_LABEL[event.status]}
        </span>
      </div>

      {token && (
        <div className="flex gap-3 mt-4 flex-wrap">
          {isRegistration && (
            <Link
              to={`/register/${event.id}?token=${token}`}
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
            >
              Register →
            </Link>
          )}
          {isPurchasing && (
            <Link
              to={`/live/${event.id}?token=${token}`}
              className="bg-yellow-500 hover:bg-yellow-400 text-yellow-950 text-sm font-bold px-4 py-2 rounded transition-colors"
            >
              Open Live Board →
            </Link>
          )}
          {(isPayment || isPurchasing) && (
            <Link
              to={`/payment/${event.id}?token=${token}`}
              className="bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
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
  return (
    <div className="space-y-6 text-gray-300 text-sm leading-relaxed">
      <div>
        <h3 className="text-white font-semibold mb-2">Before Purchase Day</h3>
        <ul className="list-disc list-inside space-y-1 text-gray-400">
          <li>Fill out the registration form with your name, Member ID, and desired days.</li>
          <li>Tony will confirm your return eligibility and assign you a purchasing coordinator.</li>
          <li>If you're bringing a friend, list them as a separate participant with yourself as sponsor.</li>
        </ul>
      </div>

      <div>
        <h3 className="text-white font-semibold mb-2">On Purchase Day</h3>
        <ul className="list-disc list-inside space-y-1 text-gray-400">
          <li>Join the Zoom call — Tony will share the link beforehand.</li>
          <li>
            Coordinators: when you're ready to buy for someone, click <strong className="text-yellow-400">Purchasing</strong>{' '}
            on their row to claim it (prevents double-buying).
          </li>
          <li>After you complete a purchase, check the days you bought and enter your name.</li>
          <li>The "Gaps" column shows days that still need to be purchased for each person.</li>
          <li>The board auto-refreshes every 8 seconds — no need to manually reload.</li>
        </ul>
      </div>

      <div>
        <h3 className="text-white font-semibold mb-2">After Purchase Day</h3>
        <ul className="list-disc list-inside space-y-1 text-gray-400">
          <li>Go to the Payment page to see exactly what you owe and to whom.</li>
          <li>Pay your coordinator via Venmo, Zelle, or PayPal as listed.</li>
          <li>Mark yourself as paid once you've sent the money.</li>
          <li>Coordinators: enter your payment handles on the Payment page so people can find you.</li>
        </ul>
      </div>

      <div>
        <h3 className="text-white font-semibold mb-2">Badge Type Notes</h3>
        <ul className="list-disc list-inside space-y-1 text-gray-400">
          <li>
            <strong className="text-gray-200">ADULT</strong> — standard badge price.
          </li>
          <li>
            <strong className="text-gray-200">JUNIOR / MILITARY / SENIOR</strong> — discounted price
            (select JUNIOR badge type when registering).
          </li>
          <li>Preview Night is separate from the Thursday badge and must be purchased independently.</li>
        </ul>
      </div>
    </div>
  );
}
