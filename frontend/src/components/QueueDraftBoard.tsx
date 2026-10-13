import { useRef, useState } from 'react';
import type { Participant, PurchaseQueueEntry, PurchaseQueueStatus, SaleDay } from '../lib/api';
import { SALE_DAYS, SALE_DAY_FULL, SALE_DAY_LABEL } from '../lib/purchaseBoard';
import {
  QUEUE_MOVE_SHOW_MS,
  activeQueue,
  etaRemainingMs,
  formatDueClock,
  formatEtaRemaining,
  isQueueActive,
} from '../lib/queueBoard';

const QUEUE_STATUS_LABEL: Record<PurchaseQueueStatus, string> = {
  waiting: 'Waiting',
  on_deck: 'On deck',
  in_queueit: 'In Queue-It',
  buying: 'Buying',
  done: 'Done',
  skipped: 'Skipped',
};

const QUEUE_STATUS_NEXT: Partial<Record<PurchaseQueueStatus, PurchaseQueueStatus>> = {
  waiting: 'in_queueit',
  on_deck: 'in_queueit',
  in_queueit: 'buying',
  buying: 'done',
};

const QUEUE_STATUS_STYLE: Record<PurchaseQueueStatus, string> = {
  waiting: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  on_deck: 'bg-amber-400 text-black',
  in_queueit: 'bg-sky-500 text-white',
  buying: 'bg-orange-500 text-white',
  done: 'bg-green-600 text-white',
  skipped: 'bg-zinc-400 text-zinc-800',
};

/** Common Queue-It screen estimates people shout on the call. */
const ETA_PRESETS: { minutes: number; label: string; span?: number }[] = [
  { minutes: 5, label: '5m' },
  { minutes: 10, label: '10m' },
  { minutes: 15, label: '15m' },
  { minutes: 25, label: '25m' },
  { minutes: 30, label: '30m' },
  { minutes: 45, label: '45m' },
  { minutes: 60, label: 'More than an hour', span: 3 },
];

type QueueActions = {
  onLeave: (qid: number) => Promise<void>;
  onStatus: (qid: number, status: PurchaseQueueStatus) => Promise<void>;
  onEta: (qid: number, eta_minutes: number | null) => Promise<void>;
  onMove: (qid: number, direction: 'up' | 'down') => Promise<void>;
  onRename: (qid: number, label: string) => Promise<void>;
  /** Admin-only: wipe the whole line, e.g. places left over from practice. */
  onClearAll: () => Promise<void>;
};

/**
 * The Queue-It line drawn as a draft board: one list, your places highlighted in it, and
 * each place expanding in place for its ETA and status controls. Order
 * comes from when each place is due through, so picks move as people report — the ▲/▼
 * markers make that visible instead of places seeming to vanish.
 */
export function BuyerQueuePanel({
  queue, moves, now, stale, myClerkId, isAdmin, identityLinked, buyFor,
  onOpenWhosNext, onJoin, onDismiss, ...actions
}: {
  queue: PurchaseQueueEntry[];
  moves: Record<number, { delta: number; at: number }>;
  now: number;
  stale: boolean;
  myClerkId: string | null;
  isAdmin: boolean;
  identityLinked: boolean;
  /** Who each of your places is buying for off your buy list, shown while it's on the clock. */
  buyFor: (placeId: number) => Participant[];
  onOpenWhosNext: () => void;
  onJoin: (label?: string) => Promise<void>;
  onDismiss: () => void;
} & QueueActions) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Your place ids just before joining; the one that shows up afterwards opens itself. */
  const [joinedFrom, setJoinedFrom] = useState<number[] | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const scrolledToRef = useRef<number | null>(null);

  const active = activeQueue(queue);
  const finished = queue.filter((q) => !isQueueActive(q));
  const mine = active.filter((q) => q.clerk_user_id === myClerkId);
  const onDeckId = active.find((q) => q.status !== 'buying')?.id ?? null;
  const newId = joinedFrom ? mine.find((q) => !joinedFrom.includes(q.id))?.id ?? null : null;
  const openId = newId ?? expanded;

  const scrollNewIntoView = (el: HTMLLIElement | null) => {
    if (!el || newId == null || scrolledToRef.current === newId) return;
    scrolledToRef.current = newId;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const rankOf = (id: number) => active.findIndex((q) => q.id === id) + 1;
  const moveOf = (id: number) => {
    const m = moves[id];
    return m && now - m.at < QUEUE_MOVE_SHOW_MS ? m.delta : 0;
  };
  const canManage = (q: PurchaseQueueEntry) => isAdmin || q.clerk_user_id === myClerkId;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const join = () => {
    const suggested = `Place ${mine.length + 1}`;
    const name = window.prompt(
      'Name this browser so you can tell your places apart (e.g. "iPhone Safari", "Laptop Chrome").',
      suggested,
    );
    if (name === null) return;
    setExpanded(null);
    setJoinedFrom(mine.map((q) => q.id));
    void run(() => onJoin(name.trim() || undefined));
  };

  const rename = (q: PurchaseQueueEntry) => {
    const name = window.prompt('Rename this place in line', q.label);
    if (name === null || !name.trim() || name.trim() === q.label) return;
    void run(() => actions.onRename(q.id, name.trim()));
  };

  const remove = (q: PurchaseQueueEntry) => {
    if (!window.confirm(`Remove "${q.label}" (${q.first_name}) from the line? This can't be undone — rejoining puts it at the back.`)) return;
    void run(() => actions.onLeave(q.id));
  };

  const skip = (q: PurchaseQueueEntry) => {
    if (!window.confirm(`Skip "${q.label}" (${q.first_name})? It moves to Finished, and can be restored from there.`)) return;
    void run(() => actions.onStatus(q.id, 'skipped'));
  };

  const controls = (q: PurchaseQueueEntry, size: 'sm' | 'md') => (
    <EntryControls
      entry={q}
      size={size}
      busy={busy}
      canManage={canManage(q)}
      canMoveUp={q.eta_at == null && rankOf(q.id) > 1}
      canMoveDown={q.eta_at == null && rankOf(q.id) < active.length}
      onStatus={(s) => run(() => actions.onStatus(q.id, s))}
      onEta={(m) => run(() => actions.onEta(q.id, m))}
      onMove={(d) => run(() => actions.onMove(q.id, d))}
      onSkip={() => skip(q)}
      onRemove={() => remove(q)}
    />
  );

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] rounded-t-2xl shadow-2xl border-t-4 sm:static sm:z-auto sm:max-h-none sm:rounded-none sm:shadow-none sm:border-t-0 sm:border-l-4 sm:w-80 shrink-0 border-sky-400 bg-sky-50 dark:bg-sky-950 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-sky-200 dark:border-sky-800 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sky-700 dark:text-sky-300 text-[11px] font-black uppercase tracking-widest">
            Queue-It draft board · {active.length}
          </div>
          <span className="flex items-center gap-1">
            {isAdmin && queue.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(actions.onClearAll)}
                className="text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 px-1"
                title="Admin: remove every place, e.g. leftovers from practice"
              >
                Clear line
              </button>
            )}
            <button type="button" onClick={onDismiss} className="text-sky-500 hover:text-sky-800 text-sm px-1.5" aria-label="Close">✕</button>
          </span>
        </div>
        <p className="text-sky-900/60 dark:text-sky-200/60 text-[11px] mt-1 leading-snug">
          Each browser waiting in Queue-It is a pick. New places join at the back, then move
          up or down as ETAs get reported. Tap a place to set its ETA.
        </p>
        {stale && (
          <p className="mt-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
            Couldn&apos;t refresh — showing the last known line. Retrying.
          </p>
        )}
        {identityLinked && (
          <button
            type="button"
            disabled={busy}
            onClick={join}
            className="mt-2 w-full text-xs font-bold px-3 py-2 rounded bg-sky-500 hover:bg-sky-400 text-white disabled:opacity-50"
          >
            {mine.length > 0 ? '+ Add another browser' : 'Join the line'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {active.length === 0 ? (
          <p className="text-sky-800/60 dark:text-sky-300/50 text-xs py-2">
            {identityLinked
              ? 'Nobody in line yet — join when you\'re on the call, then tap what Queue-It says.'
              : 'Link your identity, then join the line.'}
          </p>
        ) : (
          <section>
            <SectionLabel>Draft order</SectionLabel>
            <ol className="space-y-1">
              {active.map((q, i) => {
                const isMe = q.clerk_user_id === myClerkId;
                const onClock = q.status === 'buying';
                const onDeck = q.id === onDeckId;
                const open = openId === q.id;
                return (
                  <li
                    key={q.id}
                    ref={q.id === newId ? scrollNewIntoView : undefined}
                    className={`rounded-md px-2 py-1.5 ${open ? 'border-2 shadow-md' : 'border'} ${
                      onClock
                        ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30'
                        : onDeck
                          ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'
                          : isMe
                            ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/20'
                            : 'border-sky-200 dark:border-sky-800 bg-white/80 dark:bg-sky-950/30'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => { setJoinedFrom(null); setExpanded(open ? null : q.id); }}
                      aria-expanded={open}
                      className="w-full flex items-center gap-2 text-left"
                    >
                      <span className="font-mono text-sm font-black w-6 text-sky-700 dark:text-sky-300 shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-1">
                          <span className="font-semibold text-xs text-gray-900 dark:text-white truncate">
                            {q.first_name} {q.last_name}
                          </span>
                          {isMe && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 rounded">YOU</span>}
                        </span>
                        <span className="block text-[10px] text-gray-500 truncate">{q.label}</span>
                      </span>
                      <span className="flex flex-col items-end shrink-0 gap-0.5">
                        <EtaText entry={q} now={now} compact />
                        <span className="flex items-center gap-1">
                          <MoveBadge delta={moveOf(q.id)} />
                          {onClock || onDeck
                            ? <RoleBadge onClock={onClock} onDeck={onDeck} />
                            : <StatusChip status={q.status} />}
                        </span>
                      </span>
                    </button>
                    {isMe && onClock && (
                      <div className="mt-1.5 rounded bg-orange-50 dark:bg-orange-950/40 border border-orange-300 dark:border-orange-800 px-2 py-1.5">
                        <div className="text-[10px] font-black uppercase tracking-widest text-orange-700 dark:text-orange-300">
                          Buy for
                        </div>
                        <button
                          type="button"
                          onClick={onOpenWhosNext}
                          className="text-left text-xs font-semibold text-gray-900 dark:text-white hover:underline"
                        >
                          {buyFor(q.id).length > 0
                            ? `${buyFor(q.id).map((p) => `${p.first_name} ${p.last_name}`).join(', ')} →`
                            : 'Nobody planned yet. Open your buy list →'}
                        </button>
                      </div>
                    )}
                    {open && (
                      <div className="mt-2 pt-2 border-t border-sky-200/70 dark:border-sky-800/70">
                        <div className="flex items-center justify-between gap-2">
                          {canManage(q) ? (
                            <button
                              type="button"
                              onClick={() => rename(q)}
                              className="text-xs font-bold text-gray-900 dark:text-white truncate hover:underline"
                              title="Rename"
                            >
                              {q.label} <span className="text-gray-400">✎</span>
                            </button>
                          ) : (
                            <span className="text-xs font-bold text-gray-900 dark:text-white truncate">{q.label}</span>
                          )}
                          <span className="text-[10px] text-gray-500 shrink-0">
                            Pick #{i + 1} of {active.length}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          <StatusChip status={q.status} />
                          <EtaText entry={q} now={now} />
                        </div>
                        {controls(q, isMe ? 'md' : 'sm')}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {finished.length > 0 && (
          <section className="pt-2 border-t border-sky-200 dark:border-sky-800">
            <button
              type="button"
              onClick={() => setShowFinished((v) => !v)}
              className="text-[10px] uppercase tracking-widest text-sky-600/80 font-bold"
            >
              {showFinished ? '▾' : '▸'} Finished · {finished.length}
            </button>
            {showFinished && (
              <div className="mt-1.5 flex flex-col gap-1">
                {finished.map((q) => (
                  <div key={q.id} className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded flex-1 min-w-0 truncate ${QUEUE_STATUS_STYLE[q.status]}`}>
                      {q.first_name} {q.last_name} · {q.label} · {QUEUE_STATUS_LABEL[q.status]}
                    </span>
                    {q.status === 'skipped' && canManage(q) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => actions.onStatus(q.id, 'waiting'))}
                        className="text-[10px] font-bold text-sky-700 dark:text-sky-300 hover:underline disabled:opacity-50 shrink-0"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

function EntryControls({
  entry, size, busy, canManage, canMoveUp, canMoveDown, onStatus, onEta, onMove, onSkip, onRemove,
}: {
  entry: PurchaseQueueEntry;
  size: 'sm' | 'md';
  busy: boolean;
  canManage: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStatus: (s: PurchaseQueueStatus) => void;
  onEta: (minutes: number | null) => void;
  onMove: (d: 'up' | 'down') => void;
  onSkip: () => void;
  onRemove: () => void;
}) {
  const next = QUEUE_STATUS_NEXT[entry.status];
  const pad = size === 'md' ? 'py-1.5 text-[11px]' : 'py-1 text-[10px]';
  return (
    <div className="mt-2 space-y-1.5">
      <div>
        <div className="text-[9px] uppercase tracking-widest text-gray-500 mb-0.5">What does Queue-It say?</div>
        <div className="grid grid-cols-3 gap-1">
          {ETA_PRESETS.map((p) => (
            <button
              key={p.minutes}
              type="button"
              disabled={busy}
              onClick={() => onEta(p.minutes)}
              className={`${pad} font-bold px-1 rounded border transition-colors disabled:opacity-50 ${
                p.span === 3 ? 'col-span-3' : ''
              } ${
                entry.eta_minutes === p.minutes
                  ? 'bg-sky-500 text-white border-sky-400'
                  : 'bg-white dark:bg-sky-950/50 text-sky-800 dark:text-sky-200 border-sky-200 dark:border-sky-700 hover:border-sky-400'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {next && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus(next)}
            className={`${pad} font-bold px-2 rounded bg-sky-500 hover:bg-sky-400 text-white disabled:opacity-50`}
          >
            → {QUEUE_STATUS_LABEL[next]}
          </button>
        )}
        {entry.eta_at != null && (
          <button type="button" disabled={busy} onClick={() => onEta(null)} className={`${pad} px-1.5 text-gray-500 hover:text-red-500`}>
            clear ETA
          </button>
        )}
        {entry.eta_at == null && (
          <>
            <button type="button" disabled={busy || !canMoveUp} onClick={() => onMove('up')} className={`${pad} px-1.5 text-sky-700 dark:text-sky-300 disabled:opacity-30`} title="Move up">↑</button>
            <button type="button" disabled={busy || !canMoveDown} onClick={() => onMove('down')} className={`${pad} px-1.5 text-sky-700 dark:text-sky-300 disabled:opacity-30`} title="Move down">↓</button>
          </>
        )}
        {canManage && (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" disabled={busy} onClick={onSkip} className={`${pad} px-1.5 text-gray-500 hover:text-amber-600`}>skip</button>
            <button type="button" disabled={busy} onClick={onRemove} className={`${pad} px-1.5 text-gray-500 hover:text-red-600`}>remove</button>
          </span>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-black uppercase tracking-widest text-sky-700 dark:text-sky-300 mb-1">{children}</div>;
}

function StatusChip({ status }: { status: PurchaseQueueStatus }) {
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${QUEUE_STATUS_STYLE[status]}`}>
      {QUEUE_STATUS_LABEL[status]}
    </span>
  );
}

function RoleBadge({ onClock, onDeck }: { onClock: boolean; onDeck: boolean }) {
  if (onClock) return <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-orange-500 text-white">ON THE CLOCK</span>;
  if (onDeck) return <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-400 text-black">ON DECK</span>;
  return null;
}

function MoveBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span
      className={`text-[10px] font-black font-mono ${up ? 'text-green-600' : 'text-red-500'}`}
      title={up ? `Moved up ${delta}` : `Moved down ${-delta}`}
    >
      {up ? '▲' : '▼'}{Math.abs(delta)}
    </span>
  );
}

function EtaText({ entry, now, compact }: { entry: PurchaseQueueEntry; now: number; compact?: boolean }) {
  const remaining = etaRemainingMs(entry, now);
  const clock = formatDueClock(entry);
  if (remaining == null) {
    return <span className="text-[10px] text-gray-400">{compact ? '—' : 'No ETA yet'}</span>;
  }
  return (
    <span className="text-xs font-bold font-mono text-gray-900 dark:text-white">
      {formatEtaRemaining(remaining)}
      {!compact && clock && <span className="font-normal text-gray-500"> · due {clock}</span>}
    </span>
  );
}

/**
 * Anyone on the call can flag a day the moment Comic-Con shows it as gone, so the whole
 * board stops treating it as something left to buy. Red across the top once any day is
 * out, so nobody keeps trying for it.
 */
export function SoldOutBar({
  soldOut, canEdit, onToggle,
}: {
  soldOut: SaleDay[];
  canEdit: boolean;
  onToggle: (day: SaleDay, soldOut: boolean) => void;
}) {
  const any = soldOut.length > 0;
  if (!any && !canEdit) return null;
  return (
    <div className={`px-4 py-1.5 shrink-0 flex items-center gap-2 flex-wrap border-b-2 ${
      any ? 'bg-red-600 border-red-800 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
    }`}>
      {any ? (
        <span className="text-xs font-black uppercase tracking-widest">
          {soldOut.map((d) => SALE_DAY_FULL[d]).join(' · ')} sold out — don&apos;t try for {soldOut.length === 1 ? 'it' : 'them'}
        </span>
      ) : (
        <span className="text-[11px] font-bold uppercase tracking-wider">Sold out?</span>
      )}
      {canEdit && (
        <div className="ml-auto flex items-center gap-1">
          {!any && <span className="hidden sm:inline text-[11px] mr-1">Tap a day when Comic-Con shows it&apos;s gone:</span>}
          {SALE_DAYS.map((d) => {
            const out = soldOut.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => onToggle(d, !out)}
                title={out ? `Mark ${SALE_DAY_FULL[d]} available again` : `Mark ${SALE_DAY_FULL[d]} sold out`}
                className={`text-[11px] font-bold px-2 py-0.5 rounded border transition-colors ${
                  out
                    ? 'bg-white text-red-700 border-white line-through'
                    : any
                      ? 'border-red-300 text-white hover:bg-red-500'
                      : 'border-zinc-600 text-zinc-300 hover:border-red-400 hover:text-red-300'
                }`}
              >
                {SALE_DAY_LABEL[d]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
