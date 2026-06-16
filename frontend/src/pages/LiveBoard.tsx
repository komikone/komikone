import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type EventDetail, type Participant, formatDollars, DAY_KEYS, type DayKey } from '../lib/api';
import { useTheme } from '../lib/useTheme';

const POLL_MS = 8000;

// ─── Types ────────────────────────────────────────────────────────────────────

type RowStatus = 'complete' | 'claiming' | 'partial' | 'none';
type ColKey = 'idx' | 'first' | 'last' | 'sponsor' | 'member_id' | 'requested' | 'status' | 'purchased' | 'gaps' | 'total' | 'who';
type SortDir = 'asc' | 'desc';

// ─── Column config ────────────────────────────────────────────────────────────

const FROZEN: ColKey[] = ['idx', 'first', 'last'];
const FROZEN_PX: Record<string, number> = { idx: 36, first: 90, last: 96 };
const FROZEN_LEFT: Record<string, number> = {
  idx: 0,
  first: FROZEN_PX.idx,
  last: FROZEN_PX.idx + FROZEN_PX.first,
};
const DEFAULT_MOVABLE: ColKey[] = ['sponsor', 'member_id', 'requested', 'status', 'purchased', 'gaps', 'total', 'who'];
const COL_LABEL: Record<ColKey, string> = {
  idx: '#', first: 'First', last: 'Last', sponsor: 'Sponsor',
  member_id: 'Member ID', requested: 'Requested', status: 'Status',
  purchased: 'Purchased', gaps: 'Gaps', total: 'Total', who: 'Who Bought',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowStatus(p: Participant): RowStatus {
  if (p.all_purchased) return 'complete';
  if (p.claim_active) return 'claiming';
  if (p.any_purchased) return 'partial';
  return 'none';
}

function sortValue(p: Participant, col: ColKey, naturalIdx: number): string | number {
  switch (col) {
    case 'idx':       return naturalIdx;
    case 'first':     return p.first_name.toLowerCase();
    case 'last':      return p.last_name.toLowerCase();
    case 'sponsor':   return p.sponsor.toLowerCase();
    case 'member_id': return p.member_id.toLowerCase();
    case 'requested': return DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).length;
    case 'status':    return ['none', 'partial', 'claiming', 'complete'].indexOf(rowStatus(p));
    case 'purchased': return DAY_KEYS.filter((d) => p[`pur_${d}` as keyof Participant]).length;
    case 'gaps':      return p.gaps.length;
    case 'total':     return p.purchase_total;
    case 'who':       return p.who_purchased.toLowerCase();
    default:          return 0;
  }
}

function statusAccentCls(status: RowStatus): string {
  switch (status) {
    case 'complete': return 'border-l-4 border-l-green-500';
    case 'claiming': return 'border-l-4 border-l-orange-500 dark:border-l-yellow-400';
    case 'partial':  return 'border-l-4 border-l-blue-500';
    default:         return 'border-l-4 border-l-transparent';
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LiveBoard() {
  const { eventId } = useParams<{ eventId: string }>();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { toggle, isDark } = useTheme();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [myName, setMyName] = useState(() => localStorage.getItem('komikone_myname') ?? '');
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [flash, setFlash] = useState<Record<number, boolean>>({});
  const prevIds = useRef<Set<number>>(new Set());

  // Column order
  const [movableCols, setMovableCols] = useState<ColKey[]>(() => {
    try {
      const saved = localStorage.getItem('komikone_livecols');
      if (saved) {
        const parsed = JSON.parse(saved) as ColKey[];
        const missing = DEFAULT_MOVABLE.filter((c) => !parsed.includes(c));
        return [...parsed, ...missing];
      }
    } catch {}
    return DEFAULT_MOVABLE;
  });

  // Sort
  const [sortCol, setSortCol] = useState<ColKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Filter
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState<RowStatus | 'all'>('all');

  // Column drag-to-reorder
  const dragSrc = useRef<ColKey | null>(null);
  const dragOver = useRef<ColKey | null>(null);
  const [dragTarget, setDragTarget] = useState<ColKey | null>(null);

  // ─── Data fetching ──────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!eventId) return;
    try {
      const [ev, ps] = await Promise.all([
        api.events.get(Number(eventId), token),
        api.participants.list(Number(eventId), token),
      ]);
      setEvent(ev);
      const newFlash: Record<number, boolean> = {};
      for (const p of ps) {
        if (prevIds.current.has(p.id)) {
          const old = participants.find((x) => x.id === p.id);
          if (old && old.updated_at !== p.updated_at) newFlash[p.id] = true;
        }
      }
      if (Object.keys(newFlash).length > 0) {
        setFlash(newFlash);
        setTimeout(() => setFlash({}), 1200);
      }
      prevIds.current = new Set(ps.map((p) => p.id));
      setParticipants(ps);
      setLastUpdated(new Date());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [eventId, token, participants]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(interval);
  }, [eventId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleClaim = async (p: Participant) => {
    let name = myName.trim();
    if (!name) {
      const entered = prompt('Enter your name:');
      if (!entered) return;
      name = entered;
      localStorage.setItem('komikone_myname', name);
      setMyName(name);
    }
    try {
      await api.participants.claim(Number(eventId), p.id, token, name);
      await fetchAll();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  const handleUnclaim = async (p: Participant) => {
    try {
      await api.participants.unclaim(Number(eventId), p.id, token);
      await fetchAll();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  const handlePurchaseToggle = async (p: Participant, day: DayKey, checked: boolean) => {
    await api.participants.updatePurchased(Number(eventId), p.id, token, {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun,
      who_purchased: p.who_purchased || myName,
      [`pur_${day}`]: checked,
    }).catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    await fetchAll();
  };

  const handleWhoChange = async (p: Participant, who: string) => {
    await api.participants.updatePurchased(Number(eventId), p.id, token, {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun, who_purchased: who,
    }).catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    await fetchAll();
    setEditingRow(null);
  };

  // ─── Column reorder ──────────────────────────────────────────────────────────

  const onColDragStart = (col: ColKey) => { dragSrc.current = col; };
  const onColDragOver = (e: React.DragEvent, col: ColKey) => {
    e.preventDefault();
    if (dragSrc.current && dragSrc.current !== col) {
      dragOver.current = col;
      setDragTarget(col);
    }
  };
  const onColDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragSrc.current;
    const tgt = dragOver.current;
    if (src && tgt && src !== tgt) {
      const next = [...movableCols];
      const si = next.indexOf(src);
      const ti = next.indexOf(tgt);
      if (si !== -1 && ti !== -1) {
        next.splice(si, 1);
        next.splice(ti, 0, src);
        setMovableCols(next);
        localStorage.setItem('komikone_livecols', JSON.stringify(next));
      }
    }
    dragSrc.current = null;
    dragOver.current = null;
    setDragTarget(null);
  };
  const onColDragEnd = () => { dragSrc.current = null; dragOver.current = null; setDragTarget(null); };

  // ─── Sort ────────────────────────────────────────────────────────────────────

  const handleSort = (col: ColKey) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortCol(null); setSortDir('asc'); }
    } else {
      setSortCol(col); setSortDir('asc');
    }
  };

  // ─── Derived data ────────────────────────────────────────────────────────────

  const filtered = participants.filter((p) => {
    if (filterStatus !== 'all' && rowStatus(p) !== filterStatus) return false;
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      p.first_name.toLowerCase().includes(q) ||
      p.last_name.toLowerCase().includes(q) ||
      p.member_id.toLowerCase().includes(q) ||
      p.sponsor.toLowerCase().includes(q) ||
      p.purchasing_coordinator.toLowerCase().includes(q)
    );
  });

  const displayRows = sortCol
    ? [...filtered].sort((a, b) => {
        const ai = participants.indexOf(a);
        const bi = participants.indexOf(b);
        const av = sortValue(a, sortCol, ai);
        const bv = sortValue(b, sortCol, bi);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;

  const purchased  = participants.filter((p) => p.all_purchased).length;
  const inProgress = participants.filter((p) => !p.all_purchased && p.claim_active).length;
  const remaining  = participants.filter((p) => !p.all_purchased && !p.claim_active).length;
  const withGaps   = participants.filter((p) => p.gaps.length > 0 && p.any_purchased).length;
  const myCandidates = participants.filter((p) => !p.all_purchased && !p.claim_active).slice(0, 3);

  const allCols = [...FROZEN, ...movableCols];

  // ─── Loading / error ─────────────────────────────────────────────────────────

  if (!event && !error) {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-red-600 dark:text-red-400">{error}</div>
      </div>
    );
  }

  const frozenBg = 'bg-amber-50 dark:bg-gray-950';

  return (
    <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-950 dark:text-white flex flex-col">

      {/* ── Top bar ── */}
      <div className="bg-red-600 border-b-4 border-black dark:bg-black dark:border-yellow-400 px-4 py-2 flex items-center gap-4 flex-wrap shrink-0">
        <span className="font-bangers text-white dark:text-yellow-400 text-xl tracking-wide shrink-0">komikone</span>
        <span className="text-red-300 dark:text-gray-700 shrink-0">|</span>
        <div className="flex-1 min-w-0">
          <span className="font-bangers text-white text-lg tracking-wide">{event?.name}</span>
          <span className="ml-2 text-red-200 dark:text-gray-500 text-xs uppercase tracking-widest">
            {event?.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} · Live Board
          </span>
        </div>
        <div className="flex gap-4 text-sm font-mono">
          <span className="text-green-200 dark:text-green-400">{purchased} done</span>
          <span className="text-yellow-200 dark:text-yellow-400">{inProgress} claiming</span>
          <span className="text-white dark:text-gray-300">{remaining} left</span>
          {withGaps > 0 && <span className="text-red-200 dark:text-red-400 font-bold">{withGaps} gaps</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-red-100 dark:text-gray-400 text-xs">You:</span>
          <input
            type="text"
            value={myName}
            onChange={(e) => { setMyName(e.target.value); localStorage.setItem('komikone_myname', e.target.value); }}
            placeholder="Your name"
            className="bg-white dark:bg-gray-800 border border-red-200 dark:border-gray-600 rounded px-2 py-1 text-xs text-gray-900 dark:text-white w-28 focus:outline-none focus:border-yellow-400"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-red-200 dark:text-gray-500 text-xs">
            {lastUpdated ? `${lastUpdated.toLocaleTimeString()}` : '…'}
          </span>
          <button onClick={toggle} className="text-red-100 dark:text-gray-400 hover:text-white dark:hover:text-yellow-400 text-xs border border-red-300 dark:border-gray-700 px-2 py-0.5 rounded transition-colors">
            {isDark ? '☀ Day' : '◑ Night'}
          </button>
        </div>
      </div>

      {/* ── Candidates bar ── */}
      {myCandidates.length > 0 && myName && (
        <div className="bg-blue-600 dark:bg-blue-950/40 border-b-2 border-black dark:border-blue-800 px-4 py-2 shrink-0">
          <span className="text-white dark:text-blue-300 text-xs font-bold">Next to buy for: </span>
          {myCandidates.map((p, i) => (
            <span key={p.id} className="text-xs">
              {i > 0 && <span className="text-blue-300 dark:text-gray-600">, </span>}
              <button onClick={() => handleClaim(p)} className="text-yellow-300 dark:text-white underline hover:text-white dark:hover:text-blue-300">
                {p.first_name} {p.last_name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Filter bar ── */}
      <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3 flex-wrap shrink-0">
        <input
          type="search"
          placeholder="Search name, ID, sponsor, coordinator…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1 text-sm text-gray-900 dark:text-white w-56 focus:outline-none focus:border-blue-400 dark:focus:border-yellow-400"
        />
        <div className="flex gap-1.5 flex-wrap">
          {([
            ['all',      'All'],
            ['none',     'Remaining'],
            ['claiming', 'Claiming'],
            ['partial',  'Partial'],
            ['complete', 'Complete'],
          ] as [RowStatus | 'all', string][]).map(([s, label]) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                filterStatus === s
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 border-transparent'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {(filterText || filterStatus !== 'all') && (
          <span className="text-xs text-gray-400 dark:text-gray-600">{displayRows.length} of {participants.length}</span>
        )}
        {sortCol && (
          <button onClick={() => { setSortCol(null); setSortDir('asc'); }} className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 ml-auto">
            Clear sort ✕
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        <table className="text-sm w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>

          <thead>
            <tr>
              {allCols.map((col) => {
                const isFrozen = (FROZEN as ColKey[]).includes(col);
                const isMovable = !isFrozen;
                const isSorted = sortCol === col;
                const isDropTarget = dragTarget === col;
                return (
                  <th
                    key={col}
                    onClick={() => handleSort(col)}
                    draggable={isMovable}
                    onDragStart={isMovable ? () => onColDragStart(col) : undefined}
                    onDragOver={isMovable ? (e) => onColDragOver(e, col) : undefined}
                    onDrop={isMovable ? onColDrop : undefined}
                    onDragEnd={isMovable ? onColDragEnd : undefined}
                    style={isFrozen ? { position: 'sticky', left: FROZEN_LEFT[col], zIndex: 20, width: FROZEN_PX[col], minWidth: FROZEN_PX[col] } : undefined}
                    className={[
                      'px-3 py-2 text-left text-xs uppercase tracking-wide select-none whitespace-nowrap',
                      'sticky top-0',
                      'bg-black dark:bg-gray-900 text-gray-400',
                      'border-b-2 border-gray-700',
                      isSorted ? 'text-yellow-400' : 'hover:text-white cursor-pointer',
                      isMovable ? 'cursor-grab' : '',
                      isDropTarget ? 'bg-blue-900 text-white' : '',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-1">
                      {isMovable && <span className="text-gray-600 text-[10px] mr-0.5">⠿</span>}
                      {COL_LABEL[col]}
                      {isSorted && <span className="text-yellow-400 ml-0.5">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {displayRows.map((p, dispIdx) => {
              const status = rowStatus(p);
              const naturalIdx = participants.indexOf(p);
              const isFlashing = flash[p.id];
              const isComplete = status === 'complete';

              return (
                <tr
                  key={p.id}
                  className={[
                    'group transition-colors',
                    isFlashing ? 'bg-blue-100 dark:bg-blue-900/30' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  {allCols.map((col) => {
                    const isFrozen = (FROZEN as ColKey[]).includes(col);
                    return (
                      <td
                        key={col}
                        style={isFrozen ? { position: 'sticky', left: FROZEN_LEFT[col], zIndex: 10 } : undefined}
                        className={[
                          'px-3 py-2 border-b border-gray-100 dark:border-gray-800/60 align-middle',
                          isFrozen ? frozenBg : '',
                          col === 'idx' ? statusAccentCls(status) : '',
                          isComplete && (col === 'first' || col === 'last')
                            ? 'text-gray-400 dark:text-gray-600 line-through'
                            : '',
                        ].join(' ')}
                      >
                        <CellContent
                          col={col}
                          p={p}
                          status={status}
                          dispIdx={dispIdx}
                          naturalIdx={naturalIdx}
                          editingRow={editingRow}
                          setEditingRow={setEditingRow}
                          onClaim={handleClaim}
                          onUnclaim={handleUnclaim}
                          onPurchaseToggle={handlePurchaseToggle}
                          onWhoChange={handleWhoChange}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {displayRows.length === 0 && (
              <tr>
                <td colSpan={allCols.length} className="px-4 py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                  No participants match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Cell renderer ────────────────────────────────────────────────────────────

function CellContent({
  col, p, status, dispIdx, editingRow, setEditingRow,
  onClaim, onUnclaim, onPurchaseToggle, onWhoChange,
}: {
  col: ColKey;
  p: Participant;
  status: RowStatus;
  dispIdx: number;
  naturalIdx: number;
  editingRow: number | null;
  setEditingRow: (id: number | null) => void;
  onClaim: (p: Participant) => void;
  onUnclaim: (p: Participant) => void;
  onPurchaseToggle: (p: Participant, day: DayKey, checked: boolean) => void;
  onWhoChange: (p: Participant, who: string) => void;
}) {
  switch (col) {

    case 'idx':
      return <span className="text-gray-400 dark:text-gray-500 text-xs">{dispIdx + 1}</span>;

    case 'first':
      return (
        <div>
          <div className="font-semibold">{p.first_name}</div>
          {p.badge_type === 'JUNIOR' && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-900/60 dark:text-blue-300 dark:border-blue-700">JR</span>
          )}
        </div>
      );

    case 'last':
      return (
        <div>
          <div className="font-semibold">{p.last_name}</div>
          {p.return_eligible && (
            <span className="text-[10px] font-semibold text-green-700 dark:font-normal dark:text-green-400">✓ Return</span>
          )}
        </div>
      );

    case 'sponsor':
      return p.sponsor ? (
        <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900/60 dark:text-purple-300 dark:border-purple-700">
          {p.sponsor}
        </span>
      ) : <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>;

    case 'member_id':
      return <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{p.member_id || '—'}</span>;

    case 'requested':
      return <DayPips days={{ preview: p.req_preview, thu: p.req_thu, fri: p.req_fri, sat: p.req_sat, sun: p.req_sun }} />;

    case 'status':
      if (status === 'complete') {
        return (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 border border-green-300 dark:border-green-800 px-2 py-0.5 rounded-full">
            ✓ Done
          </span>
        );
      }
      if (p.claim_active) {
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="text-xs font-bold text-orange-600 dark:text-yellow-400">{p.purchasing_claimed_by}</span>
            <button onClick={() => onUnclaim(p)} className="text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400 underline">Release</button>
          </div>
        );
      }
      return (
        <button
          onClick={() => onClaim(p)}
          className="text-xs font-bold px-3 py-1 rounded transition-colors bg-red-600 hover:bg-red-700 text-white border-2 border-black dark:bg-yellow-500 dark:hover:bg-yellow-400 dark:text-yellow-950 dark:border-transparent"
        >
          Claim
        </button>
      );

    case 'purchased':
      return (
        <div className="flex gap-1 items-center">
          {DAY_KEYS.map((day) => {
            const requested = p[`req_${day}` as keyof Participant] as boolean;
            const bought = p[`pur_${day}` as keyof Participant] as boolean;
            if (!requested) return <span key={day} className="w-6" />;
            return (
              <label key={day} className="flex flex-col items-center cursor-pointer">
                <span className="text-[10px] text-gray-500 leading-none mb-0.5">
                  {day === 'preview' ? 'PV' : day.charAt(0).toUpperCase() + day.slice(1, 3)}
                </span>
                <input
                  type="checkbox"
                  checked={bought}
                  onChange={(e) => onPurchaseToggle(p, day, e.target.checked)}
                  className="w-4 h-4 rounded accent-green-600 dark:accent-green-500 cursor-pointer"
                />
              </label>
            );
          })}
        </div>
      );

    case 'gaps':
      if (p.gaps.length > 0)
        return <span className="text-xs font-bold text-red-700 dark:text-red-400">{p.gaps.join(', ')}</span>;
      if (p.any_purchased)
        return <span className="text-xs text-green-600 dark:text-green-500">—</span>;
      return <span className="text-xs text-gray-300 dark:text-gray-700">—</span>;

    case 'total':
      return (
        <span className="font-mono text-xs text-gray-800 dark:text-gray-200">
          {p.purchase_total > 0 ? formatDollars(p.purchase_total) : '—'}
        </span>
      );

    case 'who':
      return editingRow === p.id ? (
        <WhoInput
          initial={p.who_purchased}
          onSave={(val) => onWhoChange(p, val)}
          onCancel={() => setEditingRow(null)}
        />
      ) : (
        <button
          onClick={() => setEditingRow(p.id)}
          className="text-xs text-left text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          {p.who_purchased || <span className="italic text-gray-300 dark:text-gray-600">tap to set</span>}
        </button>
      );

    default:
      return null;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DayPips({ days }: { days: Record<string, boolean> }) {
  const labels: [string, string][] = [
    ['preview', 'PV'], ['thu', 'Th'], ['fri', 'Fr'], ['sat', 'Sa'], ['sun', 'Su'],
  ];
  return (
    <div className="flex gap-0.5 justify-center">
      {labels.map(([key, label]) =>
        days[key] ? (
          <span key={key} className="bg-gray-700 dark:bg-gray-400 text-white text-[10px] rounded px-1 leading-4">
            {label}
          </span>
        ) : (
          <span key={key} className="w-5" />
        )
      )}
    </div>
  );
}

function WhoInput({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  return (
    <div className="flex gap-1">
      <input
        autoFocus
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(val); if (e.key === 'Escape') onCancel(); }}
        className="bg-white dark:bg-gray-800 border border-gray-400 dark:border-gray-600 rounded px-1.5 py-0.5 text-xs text-gray-900 dark:text-white w-24 focus:outline-none"
      />
      <button onClick={() => onSave(val)} className="text-xs text-green-600 hover:text-green-800 dark:text-green-400">✓</button>
      <button onClick={onCancel} className="text-xs text-gray-400 hover:text-red-600">✕</button>
    </div>
  );
}
