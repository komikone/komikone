import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { api, type EventDetail, type Participant, formatDollars, DAY_KEYS, type DayKey } from '../lib/api';
import { useTheme } from '../lib/useTheme';

const POLL_MS = 8000;
const DAY_SHORT: Record<string, string> = { preview: 'PV', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };
const DAY_SLOT_W = 26;
const DAY_GAP = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

type RowStatus = 'complete' | 'claiming' | 'partial' | 'none';
type ColKey = 'idx' | 'first' | 'last' | 'actions' | 'return_eligible' | 'badge_type' | 'member_id' | 'requested' | 'purchased' | 'gaps' | 'status' | 'sponsor' | 'total' | 'who' | 'group';
type SortDir = 'asc' | 'desc';

// ─── Column config ────────────────────────────────────────────────────────────

const FROZEN: ColKey[] = ['actions', 'idx', 'first', 'last'];
const FROZEN_PX: Record<string, number> = { actions: 28, idx: 36, first: 90, last: 96 };
const FROZEN_LEFT: Record<string, number> = {
  actions: 0,
  idx: FROZEN_PX.actions,
  first: FROZEN_PX.actions + FROZEN_PX.idx,
  last: FROZEN_PX.actions + FROZEN_PX.idx + FROZEN_PX.first,
};

const DEFAULT_MOVABLE: ColKey[] = ['return_eligible', 'member_id', 'requested', 'purchased', 'gaps', 'badge_type', 'group', 'sponsor', 'status', 'total', 'who'];

const COL_LABEL: Record<ColKey, string> = {
  idx: '#', first: 'First', last: 'Last', actions: '', return_eligible: 'Return', badge_type: 'Badge',
  member_id: 'Member ID', requested: 'Requested', status: 'Status',
  purchased: 'Purchased', gaps: 'Gaps', total: 'Total', who: 'Who Bought',
  sponsor: 'Sponsor', group: 'Group',
};

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  idx: 36, first: 90, last: 96, actions: 28, return_eligible: 52,
  badge_type: 88, member_id: 118,
  requested: 168, purchased: 168, gaps: 168,
  sponsor: 112, status: 112, total: 74, who: 118, group: 110,
};

const DAY_COLS = new Set<ColKey>(['requested', 'purchased', 'gaps']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowStatus(p: Participant): RowStatus {
  if (p.all_purchased) return 'complete';
  if (p.claim_active) return 'claiming';
  if (p.any_purchased) return 'partial';
  return 'none';
}

function sortValue(p: Participant, col: ColKey, naturalIdx: number): string | number {
  switch (col) {
    case 'idx':        return naturalIdx;
    case 'first':      return p.first_name.toLowerCase();
    case 'last':       return p.last_name.toLowerCase();
    case 'sponsor':    return p.sponsor.toLowerCase();
    case 'member_id':  return p.member_id.toLowerCase();
    case 'badge_type': return p.badge_type;
    case 'requested':  return DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).length;
    case 'status':     return ['none', 'partial', 'claiming', 'complete'].indexOf(rowStatus(p));
    case 'purchased':  return DAY_KEYS.filter((d) => p[`pur_${d}` as keyof Participant]).length;
    case 'gaps':            return p.gaps.length;
    case 'total':           return p.purchase_total;
    case 'who':             return p.who_purchased.toLowerCase();
    case 'return_eligible': return p.return_eligible ? 1 : 0;
    default:                return 0;
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

function wildcardToRegex(s: string): RegExp | null {
  if (!s) return null;
  const escaped = s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(escaped, 'i'); } catch { return null; }
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
  const [identityId, setIdentityId] = useState<number | null>(() => {
    const stored = localStorage.getItem(`komikone_id_${eventId}`);
    return stored ? Number(stored) : null;
  });
  const [showWhoModal, setShowWhoModal] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editParticipant, setEditParticipant] = useState<Participant | null>(null);
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

  // Column widths (resizable, movable cols only)
  const [colWidths, setColWidths] = useState<Partial<Record<ColKey, number>>>({});
  const resizing = useRef<{ col: ColKey; startX: number; startW: number } | null>(null);
  const isResizingClick = useRef(false);

  // Row drag-to-reorder
  const [customRowOrder, setCustomRowOrder] = useState<number[] | null>(null);
  const [rowDragTarget, setRowDragTarget] = useState<number | null>(null);
  const rowDragSrc = useRef<number | null>(null);

  // Column drag-to-reorder
  const colDragSrc = useRef<ColKey | null>(null);
  const colDragOver = useRef<ColKey | null>(null);
  const [colDragTarget, setColDragTarget] = useState<ColKey | null>(null);

  // ─── Resize global listeners ────────────────────────────────────────────────

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const delta = e.clientX - resizing.current.startX;
      const newW = Math.max(50, resizing.current.startW + delta);
      setColWidths((prev) => ({ ...prev, [resizing.current!.col]: newW }));
    };
    const onMouseUp = () => {
      resizing.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

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
      setCustomRowOrder((prev) => {
        if (!prev) return null;
        const pIdSet = new Set(ps.map((p) => p.id));
        const cleaned = prev.filter((id) => pIdSet.has(id));
        const newIds = ps.map((p) => p.id).filter((id) => !prev.includes(id));
        if (newIds.length === 0 && cleaned.length === prev.length) return prev;
        return [...cleaned, ...newIds];
      });
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

  // Show identity modal on first load if not identified
  useEffect(() => {
    if (identityId === null && participants.length > 0) setShowWhoModal(true);
  }, [participants.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleClaim = async (p: Participant) => {
    const me = participants.find((x) => x.id === identityId);
    if (!me) { setShowWhoModal(true); return; }
    try {
      await api.participants.claim(Number(eventId), p.id, token, `${me.first_name} ${me.last_name}`);
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
    const me = participants.find((x) => x.id === identityId);
    const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';
    await api.participants.updatePurchased(Number(eventId), p.id, token, {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun,
      who_purchased: p.who_purchased || myDisplayName,
      [`pur_${day}`]: checked,
    }).catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    await fetchAll();
  };

  const handleRequestedToggle = async (p: Participant, day: DayKey, checked: boolean) => {
    await api.participants.updateRequested(Number(eventId), p.id, token, {
      req_preview: p.req_preview, req_thu: p.req_thu, req_fri: p.req_fri,
      req_sat: p.req_sat, req_sun: p.req_sun,
      [`req_${day}`]: checked,
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

  const onColDragStart = (col: ColKey) => { colDragSrc.current = col; };
  const onColDragOver = (e: React.DragEvent, col: ColKey) => {
    e.preventDefault();
    if (colDragSrc.current && colDragSrc.current !== col) {
      colDragOver.current = col;
      setColDragTarget(col);
    }
  };
  const onColDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const src = colDragSrc.current;
    const tgt = colDragOver.current;
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
    colDragSrc.current = null;
    colDragOver.current = null;
    setColDragTarget(null);
  };
  const onColDragEnd = () => { colDragSrc.current = null; colDragOver.current = null; setColDragTarget(null); };

  // ─── Row reorder ─────────────────────────────────────────────────────────────

  const onRowDragStart = (e: React.DragEvent, pid: number) => {
    e.stopPropagation();
    rowDragSrc.current = pid;
    e.dataTransfer.effectAllowed = 'move';
  };
  const onRowDragOver = (e: React.DragEvent, pid: number) => {
    if (rowDragSrc.current === null || rowDragSrc.current === pid) return;
    e.preventDefault();
    setRowDragTarget(pid);
  };
  const onRowDrop = (e: React.DragEvent, targetPid: number) => {
    e.preventDefault();
    const srcPid = rowDragSrc.current;
    if (srcPid === null || srcPid === targetPid) { rowDragSrc.current = null; setRowDragTarget(null); return; }
    const currentOrder = customRowOrder ?? participants.map((p) => p.id);
    const next = [...currentOrder];
    const si = next.indexOf(srcPid);
    const ti = next.indexOf(targetPid);
    if (si !== -1 && ti !== -1) {
      next.splice(si, 1);
      next.splice(ti, 0, srcPid);
      setCustomRowOrder(next);
      setSortCol(null);
    }
    rowDragSrc.current = null;
    setRowDragTarget(null);
  };
  const onRowDragEnd = () => { rowDragSrc.current = null; setRowDragTarget(null); };

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

  const getColWidth = (col: ColKey): number => colWidths[col] ?? DEFAULT_WIDTHS[col];

  const orderedParticipants = customRowOrder
    ? (customRowOrder.map((id) => participants.find((p) => p.id === id)).filter(Boolean) as Participant[])
    : participants;

  const filtered = orderedParticipants.filter((p) => {
    if (filterStatus !== 'all' && rowStatus(p) !== filterStatus) return false;
    if (!filterText) return true;
    const q = filterText.includes('*') ? filterText : `*${filterText}*`;
    const re = wildcardToRegex(q);
    if (!re) return false;
    return re.test(p.first_name) || re.test(p.last_name) || re.test(p.member_id) || re.test(p.sponsor) || re.test(p.purchasing_coordinator);
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

  const me = participants.find((p) => p.id === identityId) ?? null;
  const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';

  const priorityQueue = participants
    .filter((p) => !p.all_purchased && !p.claim_active)
    .sort((a, b) => {
      // 1. Self first
      const aMe = a.id === identityId ? 1 : 0;
      const bMe = b.id === identityId ? 1 : 0;
      if (bMe !== aMe) return bMe - aMe;
      // 2. Same group
      const aGroup = me?.group_id && a.group_id === me.group_id ? 1 : 0;
      const bGroup = me?.group_id && b.group_id === me.group_id ? 1 : 0;
      if (bGroup !== aGroup) return bGroup - aGroup;
      // 3. More days requested = higher priority
      const aDays = DAY_KEYS.filter((d) => a[`req_${d}` as keyof Participant]).length;
      const bDays = DAY_KEYS.filter((d) => b[`req_${d}` as keyof Participant]).length;
      if (bDays !== aDays) return bDays - aDays;
      // 4. Registration order
      return a.sort_order - b.sort_order;
    })
    .slice(0, 3);

  const allCols = [...FROZEN, ...movableCols];

  const handleSetIdentity = (pid: number) => {
    localStorage.setItem(`komikone_id_${eventId}`, String(pid));
    setIdentityId(pid);
    setShowWhoModal(false);
  };

  const handleEditSave = async (data: Partial<Participant>) => {
    if (!editParticipant) return;
    await api.participants.updateProfile(Number(eventId), editParticipant.id, token, data)
      .catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    setEditParticipant(null);
    await fetchAll();
  };

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

  return (
    <div className="h-screen bg-amber-50 dark:bg-gray-950 text-gray-950 dark:text-white flex flex-col overflow-hidden">

      {/* ── Top bar ── */}
      <div className="bg-zinc-950 border-b-[5px] border-yellow-400 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="font-bangers text-yellow-400 text-xl tracking-wide shrink-0">komikone</span>
        <span className="text-zinc-600 shrink-0 text-base">·</span>
        <div className="flex-1 min-w-0">
          <div className="font-bangers text-white text-lg tracking-wide leading-tight">{event?.name}</div>
          <div className="text-yellow-600 text-[10px] uppercase tracking-widest leading-tight">
            {event?.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} · Live Board
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-zinc-500 text-xs hidden sm:block">
            {lastUpdated ? lastUpdated.toLocaleTimeString() : '…'}
          </span>
          <button onClick={toggle} className="text-zinc-400 hover:text-yellow-400 text-xs border border-zinc-700 px-2 py-0.5 rounded transition-colors">
            {isDark ? '☀ Day' : '◑ Night'}
          </button>
          {me ? (
            <IdentityAvatar me={me} myDisplayName={myDisplayName} onChangeIdentity={() => setShowWhoModal(true)} />
          ) : (
            <button
              onClick={() => setShowWhoModal(true)}
              className="text-xs font-bold px-3 py-1 rounded bg-yellow-400 hover:bg-yellow-300 text-black border-2 border-yellow-300"
            >
              Who are you? →
            </button>
          )}
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div className="bg-black border-b-2 border-zinc-800 px-4 py-1 flex items-center gap-5 shrink-0">
        <span className="text-green-400 text-xs font-mono">{purchased} <span className="text-zinc-600">done</span></span>
        <span className="text-yellow-400 text-xs font-mono">{inProgress} <span className="text-zinc-600">claiming</span></span>
        <span className="text-zinc-300 text-xs font-mono">{remaining} <span className="text-zinc-600">left</span></span>
        {withGaps > 0 && <span className="text-red-400 text-xs font-mono font-bold">{withGaps} gaps</span>}
      </div>

      {/* ── Priority queue bar ── */}
      {priorityQueue.length > 0 && me && (
        <div className="bg-blue-600 dark:bg-blue-950/40 border-b-2 border-black dark:border-blue-800 px-4 py-2 shrink-0">
          <span className="text-white dark:text-blue-300 text-xs font-bold">Buy next: </span>
          {priorityQueue.map((p, i) => (
            <span key={p.id} className="text-xs">
              {i > 0 && <span className="text-blue-300 dark:text-gray-600">, </span>}
              <button onClick={() => handleClaim(p)} className="text-yellow-300 dark:text-white underline hover:text-white dark:hover:text-blue-300">
                {p.first_name} {p.last_name}
                {p.id === identityId && <span className="text-blue-200 dark:text-blue-400 ml-1">(you)</span>}
                {me.group_id && p.group_id === me.group_id && p.id !== identityId && (
                  <span className="text-blue-200 dark:text-blue-400 ml-1">· {p.group_name}</span>
                )}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Filter bar ── */}
      <div className="border-b-2 border-yellow-200 dark:border-zinc-800 bg-amber-50 dark:bg-zinc-950 px-4 py-2 flex items-center gap-3 flex-wrap shrink-0">
        <input
          type="search"
          placeholder="Search… (* wildcard)"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1 text-sm text-gray-900 dark:text-white w-52 focus:outline-none focus:border-blue-400 dark:focus:border-yellow-400"
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
        <div className="ml-auto flex gap-3">
          {customRowOrder && (
            <button
              onClick={() => setCustomRowOrder(null)}
              className="text-xs text-gray-400 hover:text-orange-500 dark:hover:text-orange-400"
            >
              Reset row order ✕
            </button>
          )}
          {sortCol && (
            <button
              onClick={() => { setSortCol(null); setSortDir('asc'); }}
              className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400"
            >
              Clear sort ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Who are you modal ── */}
      {showWhoModal && (
        <WhoAreYouModal
          participants={participants}
          onSelect={handleSetIdentity}
          onDismiss={() => setShowWhoModal(false)}
          registerUrl={`/register/${eventId}?token=${token}`}
        />
      )}

      {/* ── Edit participant modal ── */}
      {editParticipant && (
        <EditParticipantModal
          participant={editParticipant}
          onSave={handleEditSave}
          onClose={() => setEditParticipant(null)}
        />
      )}

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        <table className="text-sm w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>

          <thead>
            <tr>
              {allCols.map((col) => {
                const isFrozen = (FROZEN as ColKey[]).includes(col);
                const isMovable = !isFrozen;
                const isSorted = sortCol === col;
                const isDropTarget = colDragTarget === col;
                const isDayCol = DAY_COLS.has(col);
                const w = isFrozen ? FROZEN_PX[col] : getColWidth(col);

                return (
                  <th
                    key={col}
                    onClick={() => {
                      if (isResizingClick.current) { isResizingClick.current = false; return; }
                      handleSort(col);
                    }}
                    draggable={isMovable}
                    onDragStart={isMovable ? () => onColDragStart(col) : undefined}
                    onDragOver={isMovable ? (e) => onColDragOver(e, col) : undefined}
                    onDrop={isMovable ? onColDrop : undefined}
                    onDragEnd={isMovable ? onColDragEnd : undefined}
                    style={isFrozen
                      ? { position: 'sticky', top: 0, left: FROZEN_LEFT[col], zIndex: 20, width: w, minWidth: w }
                      : { position: 'sticky', top: 0, zIndex: 15, width: w, minWidth: w }
                    }
                    className={[
                      'px-3 py-2 text-left text-xs uppercase tracking-wide select-none align-top',
                      'bg-zinc-950 text-yellow-500/70',
                      'border-b-2 border-yellow-900',
                      isSorted ? 'text-yellow-400' : 'hover:text-white cursor-pointer',
                      isMovable ? 'cursor-grab' : '',
                      isDropTarget ? 'bg-blue-900 text-white' : '',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      {isMovable && <span className="text-gray-600 text-[10px] mr-0.5">⠿</span>}
                      {COL_LABEL[col]}
                      {isSorted && <span className="text-yellow-400 ml-0.5">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                    </span>
                    {isDayCol && (
                      <div style={{ display: 'flex', gap: DAY_GAP, marginTop: 3 }}>
                        {DAY_KEYS.map((d) => (
                          <div
                            key={d}
                            style={{ width: DAY_SLOT_W, textAlign: 'center' }}
                            className="text-[9px] text-gray-500 font-normal tracking-normal normal-case"
                          >
                            {DAY_SHORT[d]}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Resize handle — movable cols only */}
                    {isMovable && (
                      <div
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/50 z-10"
                        style={{ position: 'absolute' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          isResizingClick.current = true;
                          resizing.current = { col, startX: e.clientX, startW: getColWidth(col) };
                        }}
                      />
                    )}
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
              const isRowDragTarget = rowDragTarget === p.id;
              const evenRow = dispIdx % 2 === 0;

              const frozenBg = isFlashing
                ? 'bg-blue-100 dark:bg-blue-900/30'
                : evenRow
                  ? 'bg-white dark:bg-gray-950'
                  : 'bg-gray-50 dark:bg-gray-900/40';

              const rowBg = isFlashing
                ? 'bg-blue-100 dark:bg-blue-900/30'
                : isRowDragTarget
                  ? 'bg-blue-100 dark:bg-blue-900/20'
                  : evenRow
                    ? 'bg-white dark:bg-gray-950'
                    : 'bg-gray-50 dark:bg-gray-900/40';

              return (
                <tr
                  key={p.id}
                  className={`group transition-colors ${rowBg}`}
                  onDragOver={(e) => onRowDragOver(e, p.id)}
                  onDrop={(e) => onRowDrop(e, p.id)}
                >
                  {allCols.map((col) => {
                    const isFrozen = (FROZEN as ColKey[]).includes(col);
                    const w = isFrozen ? FROZEN_PX[col] : getColWidth(col);
                    return (
                      <td
                        key={col}
                        style={isFrozen
                          ? { position: 'sticky', left: FROZEN_LEFT[col], zIndex: 10, width: w, minWidth: w }
                          : { width: w, minWidth: w }
                        }
                        className={[
                          'px-3 py-1.5 border-b border-gray-100 dark:border-gray-800/60 align-middle',
                          isFrozen ? frozenBg : '',
                          col === 'idx' ? statusAccentCls(status) : '',
                          isRowDragTarget ? 'border-t-2 border-t-blue-400' : '',
                        ].join(' ')}
                      >
                        {col === 'idx' ? (
                          <div className="flex items-center gap-1">
                            <span
                              draggable
                              onDragStart={(e) => onRowDragStart(e, p.id)}
                              onDragEnd={onRowDragEnd}
                              className="text-gray-300 dark:text-gray-700 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-xs leading-none select-none"
                            >
                              ⠿
                            </span>
                            <span className="text-gray-400 dark:text-gray-500 text-xs">{dispIdx + 1}</span>
                          </div>
                        ) : (
                          <CellContent
                            col={col}
                            p={p}
                            status={status}
                            naturalIdx={naturalIdx}
                            editingRow={editingRow}
                            setEditingRow={setEditingRow}
                            onClaim={handleClaim}
                            onUnclaim={handleUnclaim}
                            onRequestedToggle={handleRequestedToggle}
                            onPurchaseToggle={handlePurchaseToggle}
                            onWhoChange={handleWhoChange}
                            onEditParticipant={setEditParticipant}
                          />
                        )}
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

function CopyCell({ value, children }: { value: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span
      className="inline-flex items-center gap-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children ?? <span>{value}</span>}
      <button
        onClick={handleCopy}
        className={`transition-opacity text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 ${hovered || copied ? 'opacity-100' : 'opacity-0'}`}
        title="Copy"
      >
        {copied ? (
          <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>
    </span>
  );
}

function CellContent({
  col, p, status, editingRow, setEditingRow,
  onClaim, onUnclaim, onRequestedToggle, onPurchaseToggle, onWhoChange, onEditParticipant,
}: {
  col: ColKey;
  p: Participant;
  status: RowStatus;
  naturalIdx: number;
  editingRow: number | null;
  setEditingRow: (id: number | null) => void;
  onClaim: (p: Participant) => void;
  onUnclaim: (p: Participant) => void;
  onRequestedToggle: (p: Participant, day: DayKey, checked: boolean) => void;
  onPurchaseToggle: (p: Participant, day: DayKey, checked: boolean) => void;
  onWhoChange: (p: Participant, who: string) => void;
  onEditParticipant: (p: Participant) => void;
}) {
  switch (col) {

    case 'badge_type': {
      const BADGE_STYLE: Record<string, string> = {
        ADULT:    'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
        JUNIOR:   'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/60 dark:text-blue-300 dark:border-blue-700',
        MILITARY: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/60 dark:text-green-300 dark:border-green-700',
        SENIOR:   'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/60 dark:text-amber-300 dark:border-amber-700',
      };
      const cls = BADGE_STYLE[p.badge_type] ?? BADGE_STYLE.ADULT;
      return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cls}`}>{p.badge_type}</span>;
    }

    case 'first':
      return <span className="font-semibold">{p.first_name}</span>;

    case 'actions':
      return (
        <div className="flex items-center justify-center">
          <button
            onClick={() => onEditParticipant(p)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-400"
            title="Edit participant"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>
      );

    case 'last':
      return (
        <CopyCell value={p.last_name}>
          <span className="font-semibold">{p.last_name}</span>
        </CopyCell>
      );

    case 'return_eligible':
      return p.return_eligible ? (
        <div className="flex items-center justify-center" title="Return Eligible">
          <svg className="w-4 h-4 text-green-500 dark:text-green-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 14l-4-4 1.414-1.414L11 13.172l5.586-5.586L18 9l-7 7z"/>
          </svg>
        </div>
      ) : <span className="text-gray-300 dark:text-gray-700 text-xs flex justify-center">—</span>;

    case 'sponsor':
      return p.sponsor ? (
        <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900/60 dark:text-purple-300 dark:border-purple-700">
          {p.sponsor}
        </span>
      ) : <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>;

    case 'group':
      return p.group_name ? (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
          style={{ backgroundColor: p.group_color ?? '#6366f1' }}
        >
          {p.group_name}
        </span>
      ) : <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>;

    case 'member_id': {
      const s = (p.member_id || '').toUpperCase();
      if (!s) return <span className="text-gray-300 dark:text-gray-700 text-xs font-mono">—</span>;
      const parts = s.split(/(\d+)/);
      return (
        <CopyCell value={s}>
          <span className="font-mono text-xs tracking-wide">
            {parts.map((part, i) =>
              /^\d+$/.test(part)
                ? <span key={i} className="text-red-600 dark:text-red-400">{part}</span>
                : <span key={i} className="text-gray-700 dark:text-gray-300">{part}</span>
            )}
          </span>
        </CopyCell>
      );
    }

    case 'requested':
      return (
        <div style={{ display: 'flex', gap: DAY_GAP }}>
          {DAY_KEYS.map((day) => {
            const req = p[`req_${day}` as keyof Participant] as boolean;
            const bought = p[`pur_${day}` as keyof Participant] as boolean;
            return (
              <div key={day} style={{ width: DAY_SLOT_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                {bought ? (
                  <div title="Purchased — locked" className={`w-4 h-4 rounded-sm border-2 cursor-not-allowed opacity-60 ${
                    req
                      ? 'bg-gray-400 border-gray-500 dark:bg-gray-500 dark:border-gray-400'
                      : 'border-gray-200 dark:border-gray-700'
                  }`} />
                ) : (
                  <button
                    onClick={() => onRequestedToggle(p, day, !req)}
                    className={`w-4 h-4 rounded-sm border-2 transition-colors ${
                      req
                        ? 'bg-gray-400 border-gray-500 dark:bg-gray-500 dark:border-gray-400'
                        : 'bg-transparent border-gray-300 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500'
                    }`}
                  />
                )}
                <span className="text-[7px] text-gray-400 dark:text-gray-600 leading-none">{DAY_SHORT[day]}</span>
              </div>
            );
          })}
        </div>
      );

    case 'purchased':
      return (
        <div style={{ display: 'flex', gap: DAY_GAP }}>
          {DAY_KEYS.map((day) => {
            const req = p[`req_${day}` as keyof Participant] as boolean;
            const bought = p[`pur_${day}` as keyof Participant] as boolean;
            return (
              <div key={day} style={{ width: DAY_SLOT_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                {req ? (
                  <button
                    onClick={() => onPurchaseToggle(p, day, !bought)}
                    className={`w-4 h-4 rounded-sm border-2 transition-colors ${
                      bought
                        ? 'bg-green-500 border-green-600 dark:bg-green-500 dark:border-green-400'
                        : 'bg-transparent border-gray-300 hover:border-green-400 hover:bg-green-50 dark:border-gray-600 dark:hover:border-green-500'
                    }`}
                  />
                ) : (
                  <div className="w-4 h-4 rounded-sm border border-gray-200 dark:border-gray-700" />
                )}
                <span className="text-[7px] text-gray-400 dark:text-gray-600 leading-none">{DAY_SHORT[day]}</span>
              </div>
            );
          })}
        </div>
      );

    case 'gaps':
      return (
        <div style={{ display: 'flex', gap: DAY_GAP }}>
          {DAY_KEYS.map((day) => {
            const isGap = p.gaps.some((g) => g.toLowerCase() === day);
            return (
              <div key={day} style={{ width: DAY_SLOT_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div className={`w-4 h-4 rounded-sm border-2 ${
                  isGap
                    ? 'bg-red-500 border-red-600 dark:bg-red-500 dark:border-red-400'
                    : 'border-gray-200 dark:border-gray-700'
                }`} />
                <span className="text-[7px] text-gray-400 dark:text-gray-600 leading-none">{DAY_SHORT[day]}</span>
              </div>
            );
          })}
        </div>
      );

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

function IdentityAvatar({
  me, myDisplayName, onChangeIdentity,
}: {
  me: Participant;
  myDisplayName: string;
  onChangeIdentity: () => void;
}) {
  const [open, setOpen] = useState(false);
  const initials = `${me.first_name[0] ?? ''}${me.last_name[0] ?? ''}`.toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-7 h-7 rounded-full bg-yellow-400 dark:bg-yellow-500 text-black font-bold text-[11px] flex items-center justify-center border-2 border-black dark:border-yellow-300 hover:bg-yellow-300 dark:hover:bg-yellow-400 transition-colors"
        title={myDisplayName}
      >
        {initials}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-4 min-w-[180px]">
            <div className="text-white font-semibold text-sm">{myDisplayName}</div>
            {me.member_id && (
              <div className="text-gray-400 text-xs font-mono mt-0.5">{me.member_id}</div>
            )}
            {me.group_name && (
              <div className="mt-1.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
                  style={{ backgroundColor: me.group_color ?? '#6366f1' }}
                >
                  {me.group_name}
                </span>
              </div>
            )}
            <button
              onClick={() => { setOpen(false); onChangeIdentity(); }}
              className="mt-3 text-xs text-gray-400 hover:text-white underline block"
            >
              Change identity
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function WhoAreYouModal({
  participants, onSelect, onDismiss, registerUrl,
}: {
  participants: Participant[];
  onSelect: (id: number) => void;
  onDismiss: () => void;
  registerUrl: string;
}) {
  const [search, setSearch] = useState('');
  const filtered = participants.filter((p) => {
    const q = search.toLowerCase();
    return !q || p.first_name.toLowerCase().includes(q) || p.last_name.toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm shadow-2xl">
        <div className="px-5 pt-5 pb-3 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg">Who are you?</h2>
          <p className="text-gray-400 text-sm mt-0.5">Select yourself from the participant list</p>
          <input
            autoFocus
            type="search"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full mt-3 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 placeholder-gray-500"
          />
        </div>
        <div className="overflow-y-auto max-h-72 py-1">
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className="w-full text-left px-5 py-2.5 hover:bg-gray-800 transition-colors"
            >
              <span className="text-white font-medium text-sm">{p.first_name} {p.last_name}</span>
              {p.sponsor && (
                <span className="ml-2 text-xs text-gray-500">via {p.sponsor}</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-gray-500 text-sm px-5 py-4 text-center">No match</p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
          <Link
            to={registerUrl}
            className="text-gray-500 hover:text-gray-300 text-sm underline"
          >
            I'm not on the list — click here to register
          </Link>
          <button
            onClick={onDismiss}
            className="text-gray-600 hover:text-gray-400 text-xs"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function EditParticipantModal({
  participant, onSave, onClose,
}: {
  participant: Participant;
  onSave: (data: Partial<Participant>) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    first_name: participant.first_name,
    last_name: participant.last_name,
    member_id: participant.member_id,
    badge_type: participant.badge_type as 'ADULT' | 'JUNIOR',
    sponsor: participant.sponsor,
    notes: participant.notes,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  const field = (label: string, key: keyof typeof form, mono = false) => (
    <div>
      <label className="text-gray-400 text-xs">{label}</label>
      <input
        value={form[key] as string}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className={`w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm shadow-2xl">
        <div className="px-5 pt-5 pb-3 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg">Edit Participant</h2>
          <p className="text-gray-500 text-xs mt-0.5">{participant.first_name} {participant.last_name}</p>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {field('First Name', 'first_name')}
            {field('Last Name', 'last_name')}
          </div>
          {field('Member ID', 'member_id', true)}
          <div>
            <label className="text-gray-400 text-xs">Badge Type</label>
            <select
              value={form.badge_type}
              onChange={(e) => setForm((f) => ({ ...f, badge_type: e.target.value as 'ADULT' | 'JUNIOR' }))}
              className="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="ADULT">Adult</option>
              <option value="JUNIOR">Junior</option>
            </select>
          </div>
          {field('Sponsor', 'sponsor')}
          {field('Notes', 'notes')}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
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
