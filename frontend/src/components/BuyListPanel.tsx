import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { EventDetail, Participant } from '../lib/api';
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
 * Who's next as a draft board: your own ranked list of who to buy for. Your next three
 * buyable people are your picks, and one tap claims them all. Empty spots show as dashed
 * boxes with a suggestion so a short list still fills up. The list is yours alone and
 * saved on the server, so it follows you from laptop to phone.
 */
export function BuyListPanel({
  event, participants, list, identityId, myDisplayName, quickAdd, suggested, reasonFor,
  purchasing, now, onChange, onClaimMany, onRelease, onDismiss,
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
  purchasing: boolean;
  now: number;
  onChange: (ids: number[]) => void;
  onClaimMany: (ps: Participant[]) => Promise<void>;
  onRelease: (p: Participant) => Promise<void>;
  onDismiss: () => void;
}) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ id: number; order: number[] } | null>(null);
  const rowEls = useRef(new Map<number, HTMLLIElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = new Map(participants.map((p) => [p.id, p]));
  const savedIds = list.filter((id) => byId.has(id));
  const orderIds = drag?.order ?? savedIds;
  const ranked = orderIds.map((id) => byId.get(id)!);
  const onList = new Set(savedIds);
  const states = new Map(ranked.map((p) => [p.id, rowState(p, event, myDisplayName, now)]));

  const myClaims = participants.filter((p) => holdsClaimSlot(p, myDisplayName, now));
  const slotsLeft = Math.max(0, MAX_ACTIVE_CLAIMS - myClaims.length);
  const picks = ranked.filter((p) => states.get(p.id)?.kind === 'ready').slice(0, slotsLeft);
  const pickIds = new Set(picks.map((p) => p.id));
  const emptySpots = Math.max(0, slotsLeft - picks.length);
  const claimsOffList = myClaims.filter((p) => !onList.has(p.id));

  const q = search.trim().toLowerCase();
  const matches = q
    ? participants
        .filter((p) => !onList.has(p.id) && canAddToBuyList(p, event))
        .filter((p) => fullName(p).toLowerCase().includes(q) || p.member_id.toLowerCase().includes(q))
        .slice(0, 8)
    : [];
  const quickAddLeft = quickAdd.filter((p) => !onList.has(p.id) && canAddToBuyList(p, event));
  const quickAddIds = new Set(quickAddLeft.map((p) => p.id));
  const suggestions = suggested.filter((p) => !onList.has(p.id) && !quickAddIds.has(p.id));

  const add = (p: Participant) => { onChange([...savedIds, p.id]); setSearch(''); };
  const remove = (id: number) => onChange(savedIds.filter((x) => x !== id));
  const move = (index: number, delta: -1 | 1) => {
    const ids = [...savedIds];
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    onChange(ids);
  };

  // Pointer events rather than HTML drag-and-drop, which phones don't support.
  const startDrag = (e: PointerEvent<HTMLButtonElement>, id: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, order: savedIds });
  };
  const moveDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const others = drag.order.filter((id) => id !== drag.id);
    const index = others.filter((id) => {
      const r = rowEls.current.get(id)?.getBoundingClientRect();
      return r != null && r.top + r.height / 2 < e.clientY;
    }).length;
    const order = [...others.slice(0, index), drag.id, ...others.slice(index)];
    if (order.some((id, i) => id !== drag.order[i])) setDrag({ ...drag, order });
  };
  const endDrag = () => {
    if (drag && drag.order.some((id, i) => id !== savedIds[i])) onChange(drag.order);
    setDrag(null);
  };
  const keyMove = (e: KeyboardEvent, index: number) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); move(index, -1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(index, 1); }
  };

  const claimPicks = async () => {
    setBusy(true);
    try { await onClaimMany(picks); } finally { setBusy(false); }
  };
  const release = async (p: Participant) => {
    setBusy(true);
    try { await onRelease(p); } finally { setBusy(false); }
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

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] rounded-t-2xl shadow-2xl border-t-4 sm:static sm:z-auto sm:max-h-none sm:rounded-none sm:shadow-none sm:border-t-0 sm:border-l-4 sm:w-80 shrink-0 border-yellow-400 bg-amber-50 dark:bg-gray-900 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-yellow-200 dark:border-gray-700 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-yellow-700 dark:text-yellow-400 text-[11px] font-black uppercase tracking-widest">
            ⚡ Who&apos;s next · your buy list
          </div>
          <button type="button" onClick={onDismiss} className="text-yellow-700/70 hover:text-yellow-900 dark:text-yellow-500 text-sm px-1.5" aria-label="Close">✕</button>
        </div>
        <p className="text-gray-600 dark:text-gray-400 text-[11px] mt-1 leading-snug">
          Put the people you want to buy for in order. Drag ⠿ to move someone.
          {purchasing ? ' One tap claims your next ' : ' On purchase day, one tap claims your next '}
          {MAX_ACTIVE_CLAIMS}. Only you see your list.
        </p>
        {purchasing && (
          picks.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void claimPicks()}
              className="mt-2 w-full text-sm font-black px-3 py-2.5 rounded-md bg-yellow-400 hover:bg-yellow-300 text-black border-2 border-yellow-200 shadow disabled:opacity-60"
            >
              {busy ? 'Claiming…' : `Claim my next ${picks.length}: ${firstNames(picks)}`}
            </button>
          ) : slotsLeft === 0 ? (
            <p className="mt-2 text-[11px] font-bold text-orange-700 dark:text-orange-400">
              All {MAX_ACTIVE_CLAIMS} claims in use. Finish buying or release someone to claim more.
            </p>
          ) : (
            <p className="mt-2 text-[11px] font-bold text-gray-600 dark:text-gray-400">
              Nobody on your list can be claimed right now. Add someone below.
            </p>
          )
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {claimsOffList.length > 0 && (
          <section>
            <SectionLabel>Also buying</SectionLabel>
            <ul className="space-y-1">
              {claimsOffList.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border border-green-400 bg-green-50 dark:bg-green-950/30 px-2 py-1.5">
                  <span className="flex-1 min-w-0 text-xs font-semibold text-gray-900 dark:text-white truncate">{fullName(p)}</span>
                  <ReleaseButton busy={busy} onClick={() => void release(p)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionLabel>Your list{savedIds.length > 0 ? ` · ${savedIds.length}` : ''}</SectionLabel>
          {ranked.length === 0 && quickAddLeft.length > 0 && (
            <button
              type="button"
              onClick={() => onChange(quickAddLeft.map((p) => p.id))}
              className="mb-1.5 w-full text-xs font-bold px-3 py-2 rounded bg-yellow-400 hover:bg-yellow-300 text-black"
            >
              Start with {quickAddLeft.length === 1 ? fullName(quickAddLeft[0]) : `me + ${quickAddLeft.length - 1} from my group`}
            </button>
          )}
          <ol className="space-y-1">
            {ranked.map((p, i) => {
              const st = states.get(p.id)!;
              const isPick = pickIds.has(p.id);
              const dragging = drag?.id === p.id;
              const muted = st.kind === 'done' || st.kind === 'taken';
              return (
                <li
                  key={p.id}
                  ref={(el) => { if (el) rowEls.current.set(p.id, el); else rowEls.current.delete(p.id); }}
                  className={`rounded-md border px-1.5 py-1.5 flex items-center gap-1.5 transition-shadow ${
                    dragging ? 'shadow-lg ring-2 ring-yellow-400 relative z-10' : ''
                  } ${
                    isPick
                      ? 'border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30'
                      : st.kind === 'mine'
                        ? 'border-green-400 bg-green-50 dark:bg-green-950/30'
                        : 'border-yellow-200 dark:border-gray-700 bg-white/80 dark:bg-gray-800/60'
                  } ${muted && !dragging ? 'opacity-60' : ''}`}
                >
                  <button
                    type="button"
                    onPointerDown={(e) => startDrag(e, p.id)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => keyMove(e, i)}
                    className="shrink-0 w-6 h-8 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 cursor-grab active:cursor-grabbing touch-none select-none"
                    aria-label={`Reorder ${p.first_name}: drag, or use the up and down arrow keys`}
                  >
                    ⠿
                  </button>
                  <span className="font-mono text-sm font-black w-4 text-yellow-700 dark:text-yellow-400 shrink-0">{i + 1}</span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1 min-w-0">
                      <span className={`font-semibold text-xs text-gray-900 dark:text-white truncate ${st.kind === 'done' ? 'line-through' : ''}`}>
                        {fullName(p)}
                      </span>
                      {p.id === identityId && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 rounded shrink-0">YOU</span>}
                    </span>
                    <RowStatus st={st} gaps={p.gaps} isPick={isPick} />
                  </span>
                  {st.kind === 'mine' && <ReleaseButton busy={busy} onClick={() => void release(p)} />}
                  <button type="button" onClick={() => remove(p.id)} className="shrink-0 w-6 h-8 text-xs text-gray-400 hover:text-red-600" aria-label={`Remove ${p.first_name} from your list`}>✕</button>
                </li>
              );
            })}
            {Array.from({ length: emptySpots }, (_, i) => {
              const idea = suggestions[i];
              return (
                <li key={`empty-${i}`} className="rounded-md border-2 border-dashed border-yellow-300 dark:border-gray-600 px-2 py-1.5 flex items-center gap-2 min-h-[2.75rem]">
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
            })}
          </ol>
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

        {!q && suggestions.length > emptySpots && (
          <section className="pt-2 border-t border-yellow-200 dark:border-gray-700">
            <SectionLabel>More suggestions · hardest days first</SectionLabel>
            <ul className="space-y-1">
              {suggestions.slice(emptySpots, emptySpots + 5).map((p) => (
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
    </aside>
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

function RowStatus({ st, gaps, isPick }: { st: RowState; gaps: string[]; isPick: boolean }) {
  if (st.kind === 'done') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">✓ Done</span>;
  if (st.kind === 'mine') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">You&apos;re buying</span>;
  if (st.kind === 'taken') return <span className="block text-[10px] text-gray-500 truncate">{st.by} is buying</span>;
  if (st.kind === 'blocked') return <span className="block text-[10px] text-amber-700 dark:text-amber-400 truncate">Can&apos;t buy yet: {st.why.toLowerCase()}</span>;
  return (
    <span className="flex items-center gap-1 flex-wrap mt-0.5">
      {isPick && <span className="text-[9px] font-black uppercase tracking-wider text-yellow-700 dark:text-yellow-400 mr-0.5">Next</span>}
      {gaps.map((d) => (
        <span key={d} className={`text-[9px] font-bold px-1 rounded ${DAY_CHIP_COLOR[d] ?? 'bg-zinc-600 text-white'}`}>{d}</span>
      ))}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-black uppercase tracking-widest text-yellow-700/80 dark:text-yellow-500/80 mb-1">{children}</div>;
}
