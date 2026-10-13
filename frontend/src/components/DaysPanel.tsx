import { useState } from 'react';
import type { EventDetail, Participant, SaleDay } from '../lib/api';
import { SALE_DAYS, SALE_DAY_FULL, isSoldOut, soldOutOnly } from '../lib/purchaseBoard';

/**
 * Which badge days Comic-Con still has. Whoever sees a day's sold-out screen first marks it
 * here for everyone. Sold-out days stop being suggested, and anyone left wanting only
 * sold-out days drops off every buy list until a day comes back.
 */
export function DaysPanel({ event, participants, canEdit, onToggle, onDismiss }: {
  event: EventDetail | null;
  participants: Participant[];
  canEdit: boolean;
  onToggle: (day: SaleDay, soldOut: boolean) => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState<SaleDay | null>(null);
  const stranded = participants.filter(soldOutOnly);

  const toggle = async (day: SaleDay, soldOut: boolean) => {
    setBusy(day);
    try { await onToggle(day, soldOut); } finally { setBusy(null); }
  };

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] rounded-t-2xl shadow-2xl border-t-4 sm:static sm:z-auto sm:max-h-none sm:rounded-none sm:shadow-none sm:border-t-0 sm:border-l-4 sm:w-80 shrink-0 border-rose-400 bg-rose-50 dark:bg-gray-900 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-rose-200 dark:border-gray-700 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-rose-700 dark:text-rose-300 text-[11px] font-black uppercase tracking-widest">Days · what&apos;s still available</div>
          <button type="button" onClick={onDismiss} className="text-rose-700/70 hover:text-rose-900 dark:text-rose-400 text-sm px-1.5" aria-label="Close">✕</button>
        </div>
        <p className="text-gray-600 dark:text-gray-400 text-[11px] mt-1 leading-snug">
          {canEdit
            ? 'When Comic-Con shows a day is gone, mark it sold out for everyone. Nobody gets told to buy it after that.'
            : 'Days marked sold out by whoever saw it first. Nobody gets told to buy them.'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <ul className="space-y-1.5">
          {SALE_DAYS.map((day) => {
            const out = isSoldOut(event, day);
            const wanted = participants.filter((p) => p[`req_${day}`]);
            const bought = wanted.filter((p) => p[`pur_${day}`]).length;
            const left = wanted.length - bought;
            return (
              <li
                key={day}
                className={`rounded-lg border-2 px-2.5 py-2 ${
                  out
                    ? 'border-red-400 bg-red-50 dark:bg-red-950/30 dark:border-red-800'
                    : 'border-green-300 bg-white dark:bg-gray-800/70 dark:border-green-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-black text-gray-900 dark:text-white ${out ? 'line-through decoration-red-500' : ''}`}>
                      {SALE_DAY_FULL[day]}
                    </span>
                    <span className="block text-[11px] text-gray-500">
                      {out
                        ? `${left} wanted it and missed out · ${bought} bought`
                        : `${left} still need it · ${bought} bought`}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    out ? 'bg-red-600 text-white' : 'bg-green-600 text-white'
                  }`}>
                    {out ? 'Sold out' : 'Available'}
                  </span>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void toggle(day, !out)}
                    className={`mt-1.5 w-full text-xs font-bold px-3 py-1.5 rounded border disabled:opacity-50 ${
                      out
                        ? 'border-green-500 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30'
                        : 'border-red-400 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
                    }`}
                  >
                    {busy === day ? 'Saving…' : out ? `${SALE_DAY_FULL[day]} is back · mark available` : `Mark ${SALE_DAY_FULL[day]} sold out`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {stranded.length > 0 && (
          <section className="pt-2 border-t border-rose-200 dark:border-gray-700">
            <div className="text-[10px] font-black uppercase tracking-widest text-rose-700/80 dark:text-rose-400/80 mb-1">
              Nothing left to buy · {stranded.length}
            </div>
            <p className="text-[11px] text-gray-500 mb-1.5 leading-snug">
              Every day they wanted is sold out, so they&apos;re off every buy list. They come back if a day does.
            </p>
            <ul className="space-y-0.5">
              {stranded.map((p) => (
                <li key={p.id} className="text-xs text-gray-700 dark:text-gray-300 flex justify-between gap-2">
                  <span className="truncate">{p.first_name} {p.last_name}</span>
                  <span className="shrink-0 text-gray-500">{p.sold_out_gaps?.join(', ')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
