import { useState } from 'react';
import { formatDollars, type EventDetail, type Participant, type PurchaseQueueEntry, type SaleDay } from '../lib/api';
import {
  SALE_DAYS,
  SALE_DAY_FULL,
  computePurchaseTotal,
  isSoldOut,
  nothingLeftToBuy,
} from '../lib/purchaseBoard';

const fullName = (p: Participant) => `${p.first_name} ${p.last_name}`.trim();

/**
 * Everything a buyer types into Comic-Con's checkout for one place in line, and where they
 * record what they actually got. Completing marks the place done; whoever it didn't buy
 * for goes back up for grabs.
 */
export function CheckoutModal({
  place, people, event, identityId, onTogglePurchased, onRelease, onComplete, onClose,
  allowUnrequested = false,
}: {
  place: PurchaseQueueEntry;
  /** Claimed through this place, plus anyone it already finished. */
  people: Participant[];
  event: EventDetail | null;
  identityId: number | null;
  onTogglePurchased: (p: Participant, day: SaleDay, checked: boolean) => Promise<void>;
  onRelease: (p: Participant) => Promise<void>;
  /** `finished` have nothing left to buy and come off your list. */
  onComplete: (finished: Participant[]) => Promise<void>;
  onClose: () => void;
  /** Admin can record a substitute day that was never requested. */
  allowUnrequested?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const unfinished = people.filter((p) => !nothingLeftToBuy(p));
  const total = people.reduce((n, p) => n + computePurchaseTotal(p, event), 0);

  const complete = () => {
    if (unfinished.length > 0) {
      const names = unfinished.map((p) => p.first_name).join(', ');
      const ok = confirm(
        `${names} ${unfinished.length === 1 ? 'still has' : 'still have'} days not marked bought. `
        + `Complete ${place.label} anyway? They go back on the board and stay on your list for your next place.`,
      );
      if (!ok) return;
    }
    void run(() => onComplete(people.filter((p) => nothingLeftToBuy(p))));
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-t-2xl sm:rounded-xl w-full sm:max-w-md max-h-[92vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Checkout for ${place.label}`}
      >
        <div className="px-4 pt-4 pb-3 border-b border-gray-200 dark:border-gray-700 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-orange-600 dark:text-orange-400">Checkout · {place.label}</div>
            <h2 className="text-gray-900 dark:text-white font-bold text-lg leading-tight">
              You&apos;re buying for {people.length} {people.length === 1 ? 'person' : 'people'}
            </h2>
            <p className="text-gray-500 text-xs mt-0.5">Tap a last name or Member ID to copy it. Tick each day as Comic-Con confirms it.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-900 dark:hover:text-white text-lg px-1" aria-label="Close">✕</button>
        </div>

        <ol className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {people.map((p) => (
            <PersonCheckout
              key={p.id}
              p={p}
              event={event}
              isMe={p.id === identityId}
              busy={busy}
              onToggle={(day, checked) => void run(() => onTogglePurchased(p, day, checked))}
              onRelease={p.any_purchased ? undefined : () => void run(() => onRelease(p))}
              allowUnrequested={allowUnrequested}
            />
          ))}
          {people.length === 0 && (
            <li className="text-sm text-gray-500 text-center py-6">Nobody is claimed for this place.</li>
          )}
        </ol>

        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
          {total > 0 && (
            <div className="flex justify-between text-xs text-gray-500">
              <span>Recorded so far, incl. handling</span>
              <span className="font-mono font-bold text-gray-900 dark:text-white">{formatDollars(total)}</span>
            </div>
          )}
          <div className="text-center text-sm font-bold text-gray-900 dark:text-white truncate">{place.label}</div>
          <button
            type="button"
            disabled={busy || people.length === 0}
            onClick={complete}
            className={`w-full text-sm font-black px-3 py-2.5 rounded-md disabled:opacity-50 ${
              unfinished.length === 0 && people.length > 0
                ? 'bg-green-600 hover:bg-green-500 text-white'
                : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-900 dark:text-white'
            }`}
          >
            {busy
              ? 'Saving…'
              : unfinished.length === 0 && people.length > 0
                ? 'All set · Complete Checkout'
                : 'Complete Checkout'}
          </button>
          <p className="text-[10px] text-gray-500 text-center">
            Completing marks this browser done in Get In Line and takes everyone finished off your list.
          </p>
        </div>
      </div>
    </div>
  );
}

function CopyField({ label, value, mono = false, ariaLabel }: {
  label: string;
  value: string;
  mono?: boolean;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!value}
      className="min-w-0 rounded-md bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 px-2.5 py-1.5 text-left"
      aria-label={ariaLabel}
    >
      <span className="flex items-center justify-between gap-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
        <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400">{copied ? 'Copied ✓' : 'Copy'}</span>
      </span>
      <span className={`block truncate font-bold text-gray-900 dark:text-white ${mono ? 'font-mono tracking-wider' : ''}`}>
        {value || '—'}
      </span>
    </button>
  );
}

function PersonCheckout({ p, event, isMe, busy, onToggle, onRelease, allowUnrequested = false }: {
  p: Participant;
  event: EventDetail | null;
  isMe: boolean;
  busy: boolean;
  onToggle: (day: SaleDay, checked: boolean) => void;
  onRelease?: () => void;
  allowUnrequested?: boolean;
}) {
  const days = allowUnrequested ? SALE_DAYS : SALE_DAYS.filter((d) => p[`req_${d}`] || p[`pur_${d}`]);
  const done = nothingLeftToBuy(p);

  return (
    <li className={`rounded-lg border-2 p-3 ${done ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : 'border-gray-200 dark:border-gray-700'}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-gray-900 dark:text-white">{fullName(p)}</span>
            {isMe && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 rounded">YOU</span>}
            {done && <span className="text-[10px] font-black text-green-700 dark:text-green-400">✓ DONE</span>}
          </div>
          <div className="text-[11px] text-gray-500">{p.badge_type === 'ADULT' ? 'Adult' : 'Junior / Senior / Military'}</div>
        </div>
        {onRelease && (
          <button type="button" disabled={busy} onClick={onRelease} className="text-[10px] font-bold text-gray-500 hover:text-red-600 underline disabled:opacity-50">
            Release
          </button>
        )}
      </div>

      {/* Comic-Con's checkout asks for each badge holder's last name and Member ID. */}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <CopyField label="Last name" value={p.last_name.trim().toUpperCase()} mono ariaLabel={`Copy last name for ${p.first_name}`} />
        <CopyField label="Member ID" value={(p.member_id || '').trim().toUpperCase()} mono ariaLabel={`Copy Member ID for ${p.first_name}`} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1">
        {days.map((d) => {
          const bought = !!p[`pur_${d}`];
          const requested = !!p[`req_${d}`];
          const soldOut = !bought && requested && isSoldOut(event, d);
          const locked = !allowUnrequested && !requested;
          return (
            <label
              key={d}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                soldOut || locked ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60'
              }`}
            >
              <input
                type="checkbox"
                checked={bought}
                disabled={busy || soldOut || locked}
                onChange={(e) => onToggle(d, e.target.checked)}
                className="w-5 h-5 rounded accent-green-600"
              />
              <span className={`flex-1 ${bought ? 'text-green-700 dark:text-green-400 font-semibold' : 'text-gray-800 dark:text-gray-200'}`}>
                {SALE_DAY_FULL[d]}
                {!requested && <span className="ml-1 text-[10px] font-bold text-amber-600 dark:text-amber-400">NOT REQUESTED</span>}
              </span>
              {soldOut && <span className="text-[10px] font-bold text-red-600 dark:text-red-400">SOLD OUT</span>}
              {bought && <span className="text-[10px] font-bold text-green-700 dark:text-green-400">BOUGHT</span>}
            </label>
          );
        })}
      </div>
    </li>
  );
}
