import { useState, type ReactNode } from 'react';
import type { EventDetail, Participant } from '../lib/api';
import {
  BLOCKER_LABEL,
  DAY_CHIP_COLOR,
  MAX_ACTIVE_CLAIMS,
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

/**
 * Who's next as a draft board: your own ranked list of who to buy for, then everyone else.
 * The list is yours alone and saved on the server, so it follows you from laptop to phone.
 */
export function BuyListPanel({
  event, participants, list, identityId, myDisplayName, quickAdd, suggested, reasonFor,
  purchasing, claimSlotsLeft, now, onChange, onClaim, onRelease, onDismiss,
}: {
  event: EventDetail | null;
  participants: Participant[];
  /** Participant ids in your order. */
  list: number[];
  identityId: number | null;
  myDisplayName: string;
  /** You, your family and your group: the people most lists start with. */
  quickAdd: Participant[];
  /** Claimable people not on your list, best first. */
  suggested: Participant[];
  reasonFor: (p: Participant) => string;
  purchasing: boolean;
  claimSlotsLeft: number;
  now: number;
  onChange: (ids: number[]) => void;
  onClaim: (p: Participant) => Promise<void>;
  onRelease: (p: Participant) => Promise<void>;
  onDismiss: () => void;
}) {
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const byId = new Map(participants.map((p) => [p.id, p]));
  const ranked = list.map((id) => byId.get(id)).filter((p): p is Participant => !!p);
  const onList = new Set(ranked.map((p) => p.id));
  const states = new Map(ranked.map((p) => [p.id, rowState(p, event, myDisplayName, now)]));
  const nextUpId = ranked.find((p) => states.get(p.id)?.kind === 'ready')?.id ?? null;

  const q = search.trim().toLowerCase();
  const matches = q
    ? participants
        .filter((p) => !onList.has(p.id))
        .filter((p) => fullName(p).toLowerCase().includes(q) || p.member_id.toLowerCase().includes(q))
        .slice(0, 8)
    : [];
  const quickAddLeft = quickAdd.filter((p) => !onList.has(p.id));

  const add = (p: Participant) => { onChange([...list.filter((id) => byId.has(id)), p.id]); setSearch(''); };
  const remove = (id: number) => onChange(list.filter((x) => x !== id));
  const move = (index: number, delta: -1 | 1) => {
    const ids = ranked.map((p) => p.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    onChange(ids);
  };
  const act = async (p: Participant, fn: (p: Participant) => Promise<void>) => {
    setBusyId(p.id);
    try { await fn(p); } finally { setBusyId(null); }
  };

  const claimButton = (p: Participant, emphasis: boolean) => (
    <button
      type="button"
      disabled={busyId === p.id || claimSlotsLeft <= 0}
      onClick={() => void act(p, onClaim)}
      title={claimSlotsLeft <= 0 ? `Limit ${MAX_ACTIVE_CLAIMS} claims — release someone first` : undefined}
      className={`shrink-0 text-[11px] font-black px-2.5 py-1 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        emphasis
          ? 'bg-yellow-400 hover:bg-yellow-300 text-black border-yellow-200'
          : 'bg-white dark:bg-gray-800 hover:bg-yellow-100 dark:hover:bg-gray-700 text-gray-900 dark:text-white border-yellow-400'
      }`}
    >
      {busyId === p.id ? '…' : claimSlotsLeft <= 0 ? 'Full' : 'Claim'}
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
          Rank who you want to buy for, like a draft. Who&apos;s next works down your list, skipping
          anyone already taken or done, then suggests everyone else. Only you see your list.
        </p>
        {purchasing && (
          <p className={`mt-1.5 text-[11px] font-bold ${claimSlotsLeft > 0 ? 'text-gray-700 dark:text-gray-300' : 'text-orange-600 dark:text-orange-400'}`}>
            {claimSlotsLeft}/{MAX_ACTIVE_CLAIMS} claim slots left
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        <section>
          <SectionLabel>Your order{ranked.length > 0 ? ` · ${ranked.length}` : ''}</SectionLabel>
          {ranked.length === 0 ? (
            <div className="text-xs text-gray-500 dark:text-gray-400 py-1 space-y-2">
              <p>Nobody yet. Add yourself, family and friends in the order you&apos;d buy for them.</p>
              {quickAddLeft.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange(quickAddLeft.map((p) => p.id))}
                  className="w-full text-xs font-bold px-3 py-2 rounded bg-yellow-400 hover:bg-yellow-300 text-black"
                >
                  Start with {quickAddLeft.length === 1 ? fullName(quickAddLeft[0]) : `me + ${quickAddLeft.length - 1} from my group`}
                </button>
              )}
            </div>
          ) : (
            <ol className="space-y-1">
              {ranked.map((p, i) => {
                const st = states.get(p.id)!;
                const isNext = p.id === nextUpId;
                const muted = st.kind === 'done' || st.kind === 'taken';
                return (
                  <li
                    key={p.id}
                    className={`rounded-md border px-2 py-1.5 ${
                      isNext && purchasing
                        ? 'border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 shadow-sm'
                        : st.kind === 'mine'
                          ? 'border-green-400 bg-green-50 dark:bg-green-950/30'
                          : 'border-yellow-200 dark:border-gray-700 bg-white/80 dark:bg-gray-800/60'
                    } ${muted ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-black w-5 text-yellow-700 dark:text-yellow-400 shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-1 min-w-0">
                          <span className={`font-semibold text-xs text-gray-900 dark:text-white truncate ${st.kind === 'done' ? 'line-through' : ''}`}>
                            {fullName(p)}
                          </span>
                          {p.id === identityId && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 rounded shrink-0">YOU</span>}
                        </span>
                        <RowStatus st={st} gaps={p.gaps} isNext={isNext && purchasing} />
                      </span>
                      {purchasing && st.kind === 'ready' && claimButton(p, isNext)}
                      {st.kind === 'mine' && (
                        <button
                          type="button"
                          disabled={busyId === p.id}
                          onClick={() => void act(p, onRelease)}
                          className="shrink-0 text-[10px] font-bold text-gray-500 hover:text-red-600 underline disabled:opacity-50"
                        >
                          Release
                        </button>
                      )}
                      <span className="flex shrink-0">
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="w-7 h-7 sm:w-5 sm:h-6 rounded text-xs text-gray-500 hover:text-gray-900 hover:bg-yellow-100 dark:hover:bg-gray-700 dark:hover:text-white disabled:opacity-25 disabled:hover:bg-transparent" aria-label={`Move ${p.first_name} up`}>▲</button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === ranked.length - 1} className="w-7 h-7 sm:w-5 sm:h-6 rounded text-xs text-gray-500 hover:text-gray-900 hover:bg-yellow-100 dark:hover:bg-gray-700 dark:hover:text-white disabled:opacity-25 disabled:hover:bg-transparent" aria-label={`Move ${p.first_name} down`}>▼</button>
                      </span>
                      <button type="button" onClick={() => remove(p.id)} className="shrink-0 w-6 h-7 sm:h-6 text-xs text-gray-400 hover:text-red-600" aria-label={`Remove ${p.first_name} from your list`}>✕</button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section>
          <SectionLabel>Add to your list</SectionLabel>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or Member ID"
            className="w-full bg-white dark:bg-gray-800 border border-yellow-300 dark:border-gray-600 rounded px-2.5 py-1.5 text-base sm:text-xs text-gray-900 dark:text-white focus:outline-none focus:border-yellow-500 placeholder:text-gray-400"
          />
          <ul className="mt-1 space-y-0.5">
            {(q ? matches : quickAddLeft).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => add(p)}
                  className="w-full flex items-center justify-between gap-2 text-left text-xs px-2 py-1 rounded hover:bg-yellow-100 dark:hover:bg-gray-800"
                >
                  <span className="truncate text-gray-900 dark:text-white">
                    {fullName(p)}
                    {p.group_name && <span className="text-gray-500"> · {p.group_name}</span>}
                  </span>
                  <span className="text-yellow-700 dark:text-yellow-400 font-bold shrink-0">+ Add</span>
                </button>
              </li>
            ))}
            {q && matches.length === 0 && <li className="text-xs text-gray-500 px-2 py-1">Nobody else matches.</li>}
          </ul>
        </section>

        {purchasing && suggested.length > 0 && (
          <section className="pt-2 border-t border-yellow-200 dark:border-gray-700">
            <SectionLabel>{ranked.length > 0 ? 'After your list' : 'Suggested'} · hardest days first</SectionLabel>
            <ul className="space-y-1">
              {suggested.slice(0, 5).map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/40 px-2 py-1.5">
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-xs text-gray-900 dark:text-white truncate">{fullName(p)}</span>
                    <span className="block text-[10px] text-gray-500 truncate">{reasonFor(p)}</span>
                  </span>
                  {claimButton(p, ranked.length === 0 && p.id === suggested[0].id)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

function RowStatus({ st, gaps, isNext }: { st: RowState; gaps: string[]; isNext: boolean }) {
  if (st.kind === 'done') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">✓ Done</span>;
  if (st.kind === 'mine') return <span className="block text-[10px] text-green-700 dark:text-green-400 font-bold">You&apos;re buying</span>;
  if (st.kind === 'taken') return <span className="block text-[10px] text-gray-500 truncate">{st.by} is buying</span>;
  if (st.kind === 'blocked') return <span className="block text-[10px] text-amber-700 dark:text-amber-400 truncate">Can&apos;t buy yet: {st.why.toLowerCase()}</span>;
  return (
    <span className="flex items-center gap-1 flex-wrap mt-0.5">
      {isNext && <span className="text-[9px] font-black uppercase tracking-wider text-yellow-700 dark:text-yellow-400 mr-0.5">Next</span>}
      {gaps.map((d) => (
        <span key={d} className={`text-[9px] font-bold px-1 rounded ${DAY_CHIP_COLOR[d] ?? 'bg-zinc-600 text-white'}`}>{d}</span>
      ))}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-black uppercase tracking-widest text-yellow-700/80 dark:text-yellow-500/80 mb-1">{children}</div>;
}
