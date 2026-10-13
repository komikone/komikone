import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { EventDetail, Participant, PurchaseQueueEntry, SaleDay } from '../lib/api';
import { planBuyList, type PlaceSlot } from '../lib/buyPlan';
import { CheckoutModal } from './CheckoutModal';
import {
  BLOCKER_LABEL,
  DAY_CHIP_COLOR,
  MAX_ACTIVE_CLAIMS,
  canAddToBuyList,
  holdsClaimSlot,
  isClaimLive,
  isClaimedBy,
  nothingLeftToBuy,
  purchaseBlockers,
} from '../lib/purchaseBoard';
import { etaRemainingMs, formatEtaRemaining } from '../lib/queueBoard';

type RowState =
  | { kind: 'done' }
  | { kind: 'mine' }
  | { kind: 'taken'; by: string }
  | { kind: 'blocked'; why: string }
  | { kind: 'ready' };

function rowState(p: Participant, event: EventDetail | null, myDisplayName: string, now: number): RowState {
  if (nothingLeftToBuy(p)) return { kind: 'done' };
  if (isClaimedBy(p, myDisplayName, now)) return { kind: 'mine' };
  if (isClaimLive(p, now)) return { kind: 'taken', by: p.purchasing_claimed_by.trim() };
  const blockers = purchaseBlockers(p, event);
  if (blockers.length > 0) return { kind: 'blocked', why: blockers.map((b) => BLOCKER_LABEL[b]).join(', ') };
  return { kind: 'ready' };
}

const fullName = (p: Participant) => `${p.first_name} ${p.last_name}`.trim();
const firstNames = (ps: Participant[]) => ps.map((p) => p.first_name).join(', ');

/**
 * Who To Buy For as a draft board: your own ranked list of who to buy for, split across your
 * places in the Queue-It line. Each place buys the next 3 off your list, soonest place
 * first, and claims them in one tap once it's through. Dragging someone up or down moves
 * them between places. The list is yours alone and saved on the server.
 */
export function BuyListPanel({
  event, participants, list, identityId, myDisplayName, quickAdd, suggested, reasonFor,
  places, pickNumber, purchasing, now, onChange, onClaimMany, onRelease, onPlaceThrough, onOpenQueue, onDismiss,
  onTogglePurchased, onCompletePlace,
}: {
  event: EventDetail | null;
  participants: Participant[];
  /** Participant ids in your order. */
  list: number[];
  identityId: number | null;
  myDisplayName: string;
  /** You, your family and your group: the people most lists start with. */
  quickAdd: Participant[];
  /** Buyable people not on your list, best first. */
  suggested: Participant[];
  reasonFor: (p: Participant) => string;
  /** Your places still in the Queue-It line, soonest first. */
  places: PurchaseQueueEntry[];
  /** Draft pick number of a place in the whole line. */
  pickNumber: (placeId: number) => number;
  purchasing: boolean;
  now: number;
  onChange: (ids: number[]) => void;
  onClaimMany: (ps: Participant[], place: PurchaseQueueEntry) => Promise<void>;
  onRelease: (p: Participant) => Promise<void>;
  onPlaceThrough: (place: PurchaseQueueEntry) => Promise<void>;
  onOpenQueue: () => void;
  onDismiss: () => void;
  onTogglePurchased: (p: Participant, day: SaleDay, checked: boolean) => Promise<void>;
  /** Marks the place done; `finished` have nothing left to buy. */
  onCompletePlace: (place: PurchaseQueueEntry, finished: Participant[]) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkoutPlaceId, setCheckoutPlaceId] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: number; order: number[]; start: number[] } | null>(null);
  const rowEls = useRef(new Map<number, HTMLLIElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = new Map(participants.map((p) => [p.id, p]));
  const savedIds = list.filter((id) => byId.has(id));
  const onList = new Set(savedIds);
  const myClaims = participants.filter((p) => holdsClaimSlot(p, myDisplayName, now));
  const myPlaceIds = new Set(places.map((q) => q.id));
  const bought = participants.filter((p) =>
    p.any_purchased && p.purchasing_claimed_queue_id != null && myPlaceIds.has(p.purchasing_claimed_queue_id)
    && !holdsClaimSlot(p, myDisplayName, now));
  // Pinned to a place, so they stay out of the draggable order but are kept when it's saved.
  const claimedIds = new Set([...myClaims, ...bought].map((p) => p.id));
  const claimedOnList = savedIds.filter((id) => claimedIds.has(id));
  const states = new Map(participants.map((p) => [p.id, rowState(p, event, myDisplayName, now)]));

  const plan = planBuyList({
    list: (drag?.order ?? savedIds.filter((id) => !claimedIds.has(id))).map((id) => byId.get(id)!),
    myClaims,
    bought,
    places,
    isReady: (p) => states.get(p.id)?.kind === 'ready',
  });
  const displayIds = [...plan.slots.flatMap((s) => s.upcoming), ...plan.rest].map((p) => p.id);
  const numberOf = new Map(displayIds.map((id, i) => [id, i + 1]));
  const openSpots = plan.slots.reduce((n, s) => n + s.open, 0);
  const overflowReady = plan.rest.filter((p) => states.get(p.id)?.kind === 'ready').length;
  const checkoutSlot = plan.slots.find((s) => s.place != null && s.place.id === checkoutPlaceId);
  // Someone finishing mustn't make the checkout cards jump while the buyer is ticking days.
  const listOrder = (p: Participant) => {
    const i = savedIds.indexOf(p.id);
    return i < 0 ? savedIds.length + p.id : i;
  };

  const q = search.trim().toLowerCase();
  const matches = q
    ? participants
        .filter((p) => !onList.has(p.id) && canAddToBuyList(p, event))
        .filter((p) => fullName(p).toLowerCase().includes(q) || p.member_id.toLowerCase().includes(q))
        .slice(0, 8)
    : [];
  const quickAddable = quickAdd.filter((p) => !onList.has(p.id) && canAddToBuyList(p, event));
  const quickAddIds = new Set(quickAddable.map((p) => p.id));
  const buyableNow = new Set(suggested.map((p) => p.id));
  // Empty spots fill from your group, then people you manage, then everyone by hardest days.
  const spotIdeas = [
    ...quickAddable.filter((p) => buyableNow.has(p.id)),
    ...suggested.filter((p) => !onList.has(p.id) && !quickAddIds.has(p.id)),
  ];
  const inSpots = new Set(spotIdeas.slice(0, openSpots).map((p) => p.id));
  const quickAddLeft = quickAddable.filter((p) => !inSpots.has(p.id));
  const suggestions = spotIdeas.slice(openSpots).filter((p) => !quickAddIds.has(p.id));
  // Only as many as your places can buy, in the order the empty spots suggest them.
  const startWith = [
    ...quickAddable.filter((p) => buyableNow.has(p.id)),
    ...quickAddable.filter((p) => !buyableNow.has(p.id)),
  ].slice(0, openSpots > 0 ? openSpots : MAX_ACTIVE_CLAIMS);
  const startNames = startWith.map((p) => (p.id === identityId ? 'you' : p.first_name));
  const startLabel = startNames.length === 1
    ? (startWith[0].id === identityId ? 'yourself' : fullName(startWith[0]))
    : `${startNames.slice(0, -1).join(', ')} & ${startNames[startNames.length - 1]}`;

  const save = (order: number[]) => onChange([...claimedOnList, ...order]);
  const add = (p: Participant) => { onChange([...savedIds, p.id]); setSearch(''); };
  const remove = (id: number) => onChange(savedIds.filter((x) => x !== id));
  const move = (id: number, delta: -1 | 1) => {
    const ids = [...displayIds];
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    save(ids);
  };

  // Pointer events rather than HTML drag-and-drop, which phones don't support. Listening on
  // the window keeps the drag alive when a row moves into another place's card and its
  // handle remounts. Rows are ranked by where they sit on screen, since people who can't be
  // bought yet drop below the places rather than staying where the list put them.
  const startDrag = (e: PointerEvent<HTMLButtonElement>, id: number) => {
    e.preventDefault();
    setDrag({ id, order: displayIds, start: displayIds });
  };
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const box = (id: number) => rowEls.current.get(id)?.getBoundingClientRect();
      const others = drag.order
        .filter((id) => id !== drag.id)
        .sort((a, b) => (box(a)?.top ?? 0) - (box(b)?.top ?? 0));
      const index = others.filter((id) => {
        const r = box(id);
        return r != null && r.top + r.height / 2 < e.clientY;
      }).length;
      const order = [...others.slice(0, index), drag.id, ...others.slice(index)];
      if (order.some((id, i) => id !== drag.order[i])) setDrag({ ...drag, order });
    };
    const onUp = () => {
      if (drag.order.some((id, i) => id !== drag.start[i])) onChange([...claimedOnList, ...drag.order]);
      setDrag(null);
    };
    const onCancel = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [drag, onChange, claimedOnList]);
  const keyMove = (e: KeyboardEvent, id: number) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); move(id, -1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(id, 1); }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const addButton = (p: Participant) => (
    <button
      type="button"
      onClick={() => add(p)}
      className="shrink-0 text-[11px] font-black px-2.5 py-1 rounded border border-yellow-400 bg-white dark:bg-gray-800 text-yellow-800 dark:text-yellow-300 hover:bg-yellow-400 hover:text-black"
      aria-label={`Add ${fullName(p)} to your list`}
    >
      + Add
    </button>
  );

  const listRow = (p: Participant) => {
    const st = states.get(p.id)!;
    const dragging = drag?.id === p.id;
    const muted = st.kind === 'done' || st.kind === 'taken';
    return (
      <li
        key={p.id}
        ref={(el) => { if (el) rowEls.current.set(p.id, el); else rowEls.current.delete(p.id); }}
        className={`rounded-md border px-1.5 py-1.5 flex items-center gap-1.5 transition-shadow ${
          dragging ? 'shadow-lg ring-2 ring-yellow-400 relative z-10' : ''
        } ${
          st.kind === 'ready'
            ? 'border-yellow-300 dark:border-yellow-700/60 bg-white dark:bg-gray-800/80'
            : 'border-yellow-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/40'
        } ${muted && !dragging ? 'opacity-60' : ''}`}
      >
        <button
          type="button"
          onPointerDown={(e) => startDrag(e, p.id)}
          onKeyDown={(e) => keyMove(e, p.id)}
          className="shrink-0 w-6 h-8 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 cursor-grab active:cursor-grabbing touch-none select-none"
          aria-label={`Reorder ${p.first_name}: drag, or use the up and down arrow keys`}
        >
          ⠿
        </button>
        <span className="font-mono text-sm font-black w-4 text-yellow-700 dark:text-yellow-400 shrink-0">{numberOf.get(p.id)}</span>
        <span className="flex-1 min-w-0">
          <PersonName p={p} isMe={p.id === identityId} strike={st.kind === 'done'} />
          <RowStatus st={st} gaps={p.gaps} />
        </span>
        <button type="button" onClick={() => remove(p.id)} className="shrink-0 w-6 h-8 text-xs text-gray-400 hover:text-red-600" aria-label={`Remove ${p.first_name} from your list`}>✕</button>
      </li>
    );
  };

  const firstIdeaOf = plan.slots.map((_, k) => plan.slots.slice(0, k).reduce((n, s) => n + s.open, 0));
  const emptySpot = (key: string, ideaIndex: number) => {
    const idea = spotIdeas[ideaIndex];
    return (
      <li key={key} className="rounded-md border-2 border-dashed border-yellow-300 dark:border-gray-600 px-2 py-1.5 flex items-center gap-2 min-h-[2.75rem]">
        {idea ? (
          <>
            <span className="flex-1 min-w-0">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-gray-400">Empty spot · suggestion</span>
              <span className="block text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{fullName(idea)}</span>
              <span className="block text-[10px] text-gray-500 truncate">{reasonFor(idea)}</span>
            </span>
            {addButton(idea)}
          </>
        ) : (
          <button
            type="button"
            onClick={() => searchRef.current?.focus()}
            className="flex-1 text-left text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          >
            Empty spot · search below to add someone
          </button>
        )}
      </li>
    );
  };

  const placeCard = (slot: PlaceSlot, k: number) => {
    const place = slot.place;
    const onClock = place?.status === 'buying';
    return (
      <li
        key={place?.id ?? 'planned'}
        className={`rounded-lg border-2 p-1.5 ${
          onClock
            ? 'border-orange-400 bg-orange-50/70 dark:bg-orange-950/20'
            : place
              ? 'border-sky-300 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/20'
              : 'border-dashed border-gray-300 dark:border-gray-700'
        }`}
      >
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] font-black text-gray-900 dark:text-white truncate">
              {place ? place.label : 'Your first place in line'}
            </span>
            <span className="block text-[10px] text-gray-500">
              {place
                ? `Pick #${pickNumber(place.id)} · buys ${MAX_ACTIVE_CLAIMS}`
                : `Each browser in the Queue-It line buys ${MAX_ACTIVE_CLAIMS}`}
            </span>
          </span>
          <PlaceBadge place={place} now={now} />
        </div>
        <ol className="space-y-1">
          {slot.claimed.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md border border-green-400 bg-green-50 dark:bg-green-950/30 px-2 py-1.5">
              <span className="text-green-700 dark:text-green-400 text-xs font-black w-4 shrink-0">✓</span>
              <span className="flex-1 min-w-0">
                <PersonName p={p} isMe={p.id === identityId} />
                <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">You&apos;re buying</span>
              </span>
              <ReleaseButton busy={busy} onClick={() => void run(() => onRelease(p))} />
            </li>
          ))}
          {slot.bought.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md border border-green-500 bg-green-100/70 dark:bg-green-900/30 px-2 py-1.5">
              <span className="text-green-700 dark:text-green-400 text-xs font-black w-4 shrink-0">✓</span>
              <span className="flex-1 min-w-0">
                <PersonName p={p} isMe={p.id === identityId} />
                <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">Bought</span>
              </span>
            </li>
          ))}
          {slot.upcoming.map(listRow)}
          {Array.from({ length: slot.open }, (_, i) => emptySpot(`empty-${k}-${i}`, firstIdeaOf[k] + i))}
        </ol>
        {purchasing && placeAction()}
      </li>
    );

    function placeAction() {
      if (!place) {
        return (
          <button
            type="button"
            onClick={onOpenQueue}
            className="mt-1.5 w-full text-xs font-bold px-3 py-2 rounded bg-sky-500 hover:bg-sky-400 text-white"
          >
            Get In Line to claim
          </button>
        );
      }
      if (onClock) {
        const inCheckout = slot.claimed.length + slot.bought.length;
        return (
          <div className="mt-1.5 space-y-1.5">
            {slot.upcoming.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => {
                  await onClaimMany(slot.upcoming, place);
                  setCheckoutPlaceId(place.id);
                })}
                className="w-full text-sm font-black px-3 py-2 rounded-md bg-yellow-400 hover:bg-yellow-300 text-black border-2 border-yellow-200 shadow disabled:opacity-60"
              >
                {busy ? 'Claiming…' : `Claim ${slot.upcoming.length} for ${place.label}: ${firstNames(slot.upcoming)}`}
              </button>
            )}
            {inCheckout > 0 && (
              <button
                type="button"
                onClick={() => setCheckoutPlaceId(place.id)}
                className="w-full text-sm font-black px-3 py-2 rounded-md bg-orange-500 hover:bg-orange-400 text-white shadow"
              >
                Open checkout · {inCheckout} {inCheckout === 1 ? 'person' : 'people'}
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="mt-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => onPlaceThrough(place))}
            className="w-full text-xs font-bold px-3 py-2 rounded border-2 border-orange-400 text-orange-700 dark:text-orange-300 bg-white dark:bg-gray-900 hover:bg-orange-50 dark:hover:bg-orange-950/40 disabled:opacity-60"
          >
            {place.label} is through Queue-It
          </button>
          <p className="text-[10px] text-gray-500 mt-1 px-1">Claim unlocks once this browser is through.</p>
        </div>
      );
    }
  };

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] rounded-t-2xl shadow-2xl border-t-4 sm:static sm:z-auto sm:max-h-none sm:rounded-none sm:shadow-none sm:border-t-0 sm:border-l-4 sm:w-80 shrink-0 border-yellow-400 bg-amber-50 dark:bg-gray-900 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-yellow-200 dark:border-gray-700 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-yellow-700 dark:text-yellow-400 text-[11px] font-black uppercase tracking-widest">
            ⚡ Who To Buy For · your buy list
          </div>
          <button type="button" onClick={onDismiss} className="text-yellow-700/70 hover:text-yellow-900 dark:text-yellow-500 text-sm px-1.5" aria-label="Close">✕</button>
        </div>
        <p className="text-gray-600 dark:text-gray-400 text-[11px] mt-1 leading-snug">
          Put the people you want to buy for in order. Each of your places in line buys the
          next {MAX_ACTIVE_CLAIMS}. Drag ⠿ to move someone to a different place. Only you see your list.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {plan.unplaced.length > 0 && (
          <section>
            <SectionLabel>Also buying</SectionLabel>
            <ul className="space-y-1">
              {plan.unplaced.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border border-green-400 bg-green-50 dark:bg-green-950/30 px-2 py-1.5">
                  <span className="flex-1 min-w-0 text-xs font-semibold text-gray-900 dark:text-white truncate">{fullName(p)}</span>
                  <ReleaseButton busy={busy} onClick={() => void run(() => onRelease(p))} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionLabel>Your list{savedIds.length > 0 ? ` · ${savedIds.length}` : ''}</SectionLabel>
          {savedIds.length === 0 && startWith.length > 0 && (
            <button
              type="button"
              onClick={() => onChange(startWith.map((p) => p.id))}
              className="mb-1.5 w-full text-xs font-bold px-3 py-2 rounded bg-yellow-400 hover:bg-yellow-300 text-black"
            >
              Start with {startLabel}
            </button>
          )}
          <ol className="space-y-2">{plan.slots.map(placeCard)}</ol>
          {plan.rest.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1 px-1">
                {overflowReady > 0 ? 'Next up · no place for them yet' : 'Rest of your list'}
              </div>
              <ol className="space-y-1">{plan.rest.map(listRow)}</ol>
              {overflowReady > 0 && (
                <button
                  type="button"
                  onClick={onOpenQueue}
                  className="mt-1.5 w-full text-[11px] font-bold px-3 py-1.5 rounded border border-sky-400 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40"
                >
                  + Add another browser to the line to buy {Math.min(overflowReady, MAX_ACTIVE_CLAIMS)} more
                </button>
              )}
            </div>
          )}
        </section>

        <section>
          <SectionLabel>Add to your list</SectionLabel>
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or Member ID"
            className="w-full bg-white dark:bg-gray-800 border border-yellow-300 dark:border-gray-600 rounded px-2.5 py-1.5 text-base sm:text-xs text-gray-900 dark:text-white focus:outline-none focus:border-yellow-500 placeholder:text-gray-400"
          />
          <ul className="mt-1 space-y-1">
            {(q ? matches : quickAddLeft).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-yellow-100/60 dark:hover:bg-gray-800">
                <span className="min-w-0 truncate text-xs text-gray-900 dark:text-white">
                  {fullName(p)}
                  {p.group_name && <span className="text-gray-500"> · {p.group_name}</span>}
                  {purchaseBlockers(p, event).length > 0 && (
                    <span className="block text-[10px] text-orange-600 dark:text-orange-400">
                      {purchaseBlockers(p, event).map((b) => BLOCKER_LABEL[b]).join(' · ')}: fix before buying
                    </span>
                  )}
                </span>
                {addButton(p)}
              </li>
            ))}
            {q && matches.length === 0 && <li className="text-xs text-gray-500 px-2 py-1">Nobody else matches.</li>}
          </ul>
        </section>

        {!q && suggestions.length > 0 && (
          <section className="pt-2 border-t border-yellow-200 dark:border-gray-700">
            <SectionLabel>More suggestions · hardest days first</SectionLabel>
            <ul className="space-y-1">
              {suggestions.slice(0, 5).map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/40 px-2 py-1.5">
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-xs text-gray-900 dark:text-white truncate">{fullName(p)}</span>
                    <span className="block text-[10px] text-gray-500 truncate">{reasonFor(p)}</span>
                  </span>
                  {addButton(p)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {checkoutSlot?.place && (
        <CheckoutModal
          place={checkoutSlot.place}
          people={[...checkoutSlot.claimed, ...checkoutSlot.bought].sort((a, b) => listOrder(a) - listOrder(b))}
          event={event}
          identityId={identityId}
          onTogglePurchased={onTogglePurchased}
          onRelease={onRelease}
          onComplete={async (finished) => {
            await onCompletePlace(checkoutSlot.place!, finished);
            setCheckoutPlaceId(null);
          }}
          onClose={() => setCheckoutPlaceId(null)}
        />
      )}
    </aside>
  );
}

function PersonName({ p, isMe, strike }: { p: Participant; isMe: boolean; strike?: boolean }) {
  return (
    <span className="flex items-center gap-1 min-w-0">
      <span className={`font-semibold text-xs text-gray-900 dark:text-white truncate ${strike ? 'line-through' : ''}`}>
        {fullName(p)}
      </span>
      {isMe && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 rounded shrink-0">YOU</span>}
    </span>
  );
}

function PlaceBadge({ place, now }: { place: PurchaseQueueEntry | null; now: number }) {
  if (!place) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300 shrink-0">Not in line</span>;
  if (place.status === 'buying') return <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-orange-500 text-white shrink-0">ON THE CLOCK</span>;
  const eta = etaRemainingMs(place, now);
  return (
    <span className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200 shrink-0">
      {eta == null ? 'Waiting' : formatEtaRemaining(eta)}
    </span>
  );
}

function ReleaseButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="shrink-0 text-[10px] font-bold text-gray-500 hover:text-red-600 underline disabled:opacity-50"
    >
      Release
    </button>
  );
}

function RowStatus({ st, gaps }: { st: RowState; gaps: string[] }) {
  if (st.kind === 'done') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">✓ Done</span>;
  if (st.kind === 'mine') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">You&apos;re buying</span>;
  if (st.kind === 'taken') return <span className="block text-[10px] text-gray-500 truncate">{st.by} is buying</span>;
  if (st.kind === 'blocked') return <span className="block text-[10px] text-amber-700 dark:text-amber-400 truncate">Can&apos;t buy yet: {st.why.toLowerCase()}</span>;
  return (
    <span className="flex items-center gap-1 flex-wrap mt-0.5">
      {gaps.map((d) => (
        <span key={d} className={`text-[9px] font-bold px-1 rounded ${DAY_CHIP_COLOR[d] ?? 'bg-zinc-600 text-white'}`}>{d}</span>
      ))}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-black uppercase tracking-widest text-yellow-700/80 dark:text-yellow-500/80 mb-1">{children}</div>;
}
