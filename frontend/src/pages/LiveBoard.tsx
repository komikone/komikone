import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { api, type EventDetail, type Participant, type PurchaseQueueEntry, type PurchaseQueueStatus, formatDollars, DAY_KEYS, type DayKey } from '../lib/api';
import { HeaderUserMenu } from '../components/HeaderUserMenu';
import { useTheme } from '../lib/useTheme';
import { MemberId, normalizeMemberIdInput } from '../components/MemberId';

const POLL_MS = 8000;
const DAY_SHORT: Record<string, string> = { preview: 'PV', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };
const DAY_SLOT_W = 26;
const DAY_GAP = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

type RowStatus = 'setup' | 'complete' | 'claiming' | 'partial' | 'none';
type ColKey = 'idx' | 'first' | 'last' | 'actions' | 'return_eligible' | 'badge_type' | 'member_id' | 'requested' | 'purchased' | 'gaps' | 'status' | 'total' | 'who' | 'group';
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

const DEFAULT_MOVABLE: ColKey[] = ['return_eligible', 'member_id', 'requested', 'purchased', 'gaps', 'badge_type', 'group', 'status', 'total', 'who'];

const COL_LABEL: Record<ColKey, string> = {
  idx: '#', first: 'First', last: 'Last', actions: '', return_eligible: 'Return', badge_type: 'Badge',
  member_id: 'Member ID', requested: 'Requested', status: 'Status',
  purchased: 'Purchased', gaps: 'Gaps', total: 'Total', who: 'Who Bought',
  group: 'Group',
};

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  idx: 36, first: 90, last: 96, actions: 28, return_eligible: 52,
  badge_type: 88, member_id: 118,
  requested: 168, purchased: 168, gaps: 168,
  status: 112, total: 74, who: 118, group: 110,
};

const DAY_COLS = new Set<ColKey>(['requested', 'purchased', 'gaps']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasRequestedDays(p: Participant): boolean {
  return !!(p.req_preview || p.req_thu || p.req_fri || p.req_sat || p.req_sun);
}

function rowStatus(p: Participant): RowStatus {
  if (!hasRequestedDays(p)) return 'setup';
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
    case 'member_id':  return p.member_id.toLowerCase();
    case 'badge_type': return p.badge_type;
    case 'requested':  return DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).length;
    case 'status':     return ['setup', 'none', 'partial', 'claiming', 'complete'].indexOf(rowStatus(p));
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
    case 'setup':    return 'border-l-4 border-l-zinc-400';
    default:         return 'border-l-4 border-l-transparent';
  }
}

function wildcardToRegex(s: string): RegExp | null {
  if (!s) return null;
  const escaped = s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(escaped, 'i'); } catch { return null; }
}

// Gap day labels from server match these keys
const DAY_DIFFICULTY: Record<string, number> = {
  Sat: 8, Fri: 4, Thu: 2, Sun: 2, Preview: 2,
};

const DAY_CHIP_COLOR: Record<string, string> = {
  Sat:     'bg-red-600 text-white',
  Fri:     'bg-orange-500 text-white',
  Thu:     'bg-blue-500 text-white',
  Sun:     'bg-blue-500 text-white',
  Preview: 'bg-purple-600 text-white',
};

function priorityScore(p: Participant, me: Participant | null, identityId: number | null): number {
  const isSelf    = p.id === identityId;
  const isGroup   = !isSelf && me?.group_id != null && p.group_id === me.group_id;
  const groupBonus = (isSelf || isGroup) ? 10000 : 0;
  const dayScore   = p.gaps.reduce((s, d) => s + (DAY_DIFFICULTY[d] ?? 2), 0);
  return groupBonus + p.gaps.length * 100 + dayScore;
}

const SIM_STORAGE_PREFIX = 'komikone_sim_';

function simStorageKey(eventId: string | undefined) {
  return `${SIM_STORAGE_PREFIX}${eventId ?? 'global'}`;
}

/** Self, family you registered, or group you own. No admin bypass on the live board. */
function canEditIdentityRow(
  p: Participant,
  me: Participant | null,
  identityId: number | null,
  myClerkId: string | null | undefined,
): boolean {
  if (identityId != null && p.id === identityId) return true;
  const clerkId = myClerkId ?? me?.clerk_user_id ?? null;
  if (!clerkId) return false;
  if (p.clerk_user_id === clerkId) return true;
  if (p.registered_by_clerk_user_id === clerkId) return true;
  if (p.group_id && p.group_owner_clerk_user_id === clerkId) return true;
  return false;
}

/** Claimed by you — required for purchase day toggles; no admin bypass. */
function hasClaimByMe(p: Participant, myDisplayName: string): boolean {
  if (!p.claim_active) return false;
  if (!myDisplayName.trim()) return false;
  return p.purchasing_claimed_by.trim().toLowerCase() === myDisplayName.trim().toLowerCase();
}

/** Lower tier = higher on the board. During purchasing, your active claims float below self/group. */
function rowSortTier(
  p: Participant,
  me: Participant | null,
  identityId: number | null,
  myDisplayName: string,
  purchaseMode: boolean,
): number {
  if (identityId != null && p.id === identityId) return 0;
  if (me?.group_id != null && p.group_id === me.group_id) return 1;
  if (purchaseMode && hasClaimByMe(p, myDisplayName) && !p.all_purchased) return 2;
  return 3;
}

function claimSortKey(p: Participant): number {
  if (!p.purchasing_claimed_at) return Number.MAX_SAFE_INTEGER;
  return new Date(p.purchasing_claimed_at).getTime();
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LiveBoard() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { toggle, isDark } = useTheme();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [buyerQueue, setBuyerQueue] = useState<PurchaseQueueEntry[]>([]);
  const [showBuyerQueue, setShowBuyerQueue] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [identityId, setIdentityId] = useState<number | null>(null);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editParticipant, setEditParticipant] = useState<Participant | null>(null);
  const [flash, setFlash] = useState<Record<number, boolean>>({});
  const [simulation, setSimulation] = useState(() => {
    try { return localStorage.getItem(simStorageKey(eventId)) === '1'; } catch { return false; }
  });
  /** null = still checking; string = block reason before board access */
  const [accessBlock, setAccessBlock] = useState<'member_id' | 'return_eligible' | null | undefined>(undefined);
  const [openLiveEventId, setOpenLiveEventId] = useState<number | null>(null);
  const prevIds = useRef<Set<number>>(new Set());

  const isPlatformAdmin = user?.publicMetadata?.role === 'admin';

  useEffect(() => {
    try {
      localStorage.setItem(simStorageKey(eventId), simulation ? '1' : '0');
    } catch { /* ignore */ }
  }, [simulation, eventId]);

  // Column order (sanitize localStorage — drop unknown keys like a stray empty-header col)
  const [movableCols, setMovableCols] = useState<ColKey[]>(() => {
    try {
      const saved = localStorage.getItem('komikone_livecols');
      if (saved) {
        const allowed = new Set<ColKey>(DEFAULT_MOVABLE);
        const parsed = (JSON.parse(saved) as string[]).filter((c): c is ColKey =>
          allowed.has(c as ColKey),
        );
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

  // ─── Auth redirect ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      navigate('/sign-in?redirect=' + encodeURIComponent(window.location.pathname));
    }
  }, [isLoaded, isSignedIn, navigate]);

  // ─── Data fetching ──────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!eventId) return;
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      const [ev, ps, queue] = await Promise.all([
        api.events.get(Number(eventId), clerkToken),
        api.participants.list(Number(eventId), clerkToken),
        api.purchaseQueue.list(Number(eventId), clerkToken).catch(() => [] as PurchaseQueueEntry[]),
      ]);
      setEvent(ev);
      setBuyerQueue(queue);
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
  }, [eventId, getToken, participants]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(interval);
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve Clerk identity → participant link, and gate Member ID / return eligibility
  useEffect(() => {
    if (!eventId || !isSignedIn) return;
    let cancelled = false;
    setAccessBlock(undefined);
    setOpenLiveEventId(null);

    getToken({ template: 'komikone' }).then(async (clerkToken) => {
      if (!clerkToken || cancelled) return;
      try {
        const [res, yearList, eventDetail, allEvents] = await Promise.all([
          api.participants.getMyIdentity(Number(eventId), clerkToken),
          api.years.list(clerkToken).catch(() => [] as Awaited<ReturnType<typeof api.years.list>>),
          api.events.get(Number(eventId), clerkToken).catch(() => null),
          api.events.list().catch(() => [] as Awaited<ReturnType<typeof api.events.list>>),
        ]);

        if (cancelled) return;

        const conYear = eventDetail?.year;
        const yearObj = conYear != null ? yearList.find((y) => y.con_year === conYear) : undefined;
        let yearMemberId = '';
        let returnEligible = false;
        if (yearObj) {
          const memberRes = await api.years.me(yearObj.id, clerkToken).catch(() => null);
          yearMemberId = memberRes?.member.member_id?.trim() ?? '';
          returnEligible = !!memberRes?.member.return_eligible;
        }

        const linkedMemberId = res.linked && res.participant
          ? (res.participant.member_id?.trim() ?? '')
          : '';
        if (res.linked && res.participant) {
          returnEligible = returnEligible || !!res.participant.return_eligible;
        }

        const hasMemberId = !!(yearMemberId || linkedMemberId);
        if (!hasMemberId) {
          setAccessBlock('member_id');
          return;
        }

        // Return Reg board is only for return-eligible members
        if (eventDetail?.reg_type === 'return' && !returnEligible && !isPlatformAdmin) {
          const openEvt = allEvents.find(
            (e) => e.year === conYear && e.reg_type === 'open',
          );
          setOpenLiveEventId(openEvt?.id ?? null);
          setAccessBlock('return_eligible');
          return;
        }

        setAccessBlock(null);

        if (res.linked && res.participant) {
          setIdentityId(res.participant.id);
        } else {
          setShowLinkModal(true);
        }
      } catch {
        if (!cancelled) setAccessBlock(null);
      }
    });

    return () => { cancelled = true; };
  }, [eventId, isSignedIn, isPlatformAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleClaim = async (p: Participant) => {
    const me = participants.find((x) => x.id === identityId);
    if (!me) { setShowLinkModal(true); return; }
    try {
      const clerkToken = await getToken({ template: 'komikone' });
      if (!clerkToken) return;
      await api.participants.claim(
        Number(eventId), p.id, clerkToken, `${me.first_name} ${me.last_name}`,
        { simulation },
      );
      await fetchAll();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  const handleUnclaim = async (p: Participant) => {
    try {
      const clerkToken = await getToken({ template: 'komikone' });
      if (!clerkToken) return;
      await api.participants.unclaim(Number(eventId), p.id, clerkToken);
      await fetchAll();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  const handlePurchaseToggle = async (p: Participant, day: DayKey, checked: boolean) => {
    const me = participants.find((x) => x.id === identityId);
    const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';
    if (!hasClaimByMe(p, myDisplayName)) {
      alert('Claim this person first before marking purchase days');
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    await api.participants.updatePurchased(Number(eventId), p.id, clerkToken, {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun,
      who_purchased: p.who_purchased || myDisplayName,
      [`pur_${day}`]: checked,
    }).catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    await fetchAll();
  };

  const handleRequestedToggle = async (p: Participant, day: DayKey, checked: boolean) => {
    if (simulation || event?.status === 'purchasing') {
      alert('Requested days are locked during purchasing');
      return;
    }
    const meRow = participants.find((x) => x.id === identityId) ?? null;
    if (!canEditIdentityRow(p, meRow, identityId, user?.id)) {
      alert('You can only change requested days for yourself or your group');
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    await api.participants.updateRequested(Number(eventId), p.id, clerkToken, {
      req_preview: p.req_preview, req_thu: p.req_thu, req_fri: p.req_fri,
      req_sat: p.req_sat, req_sun: p.req_sun,
      [`req_${day}`]: checked,
    }).catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    await fetchAll();
  };

  const handleWhoChange = async (p: Participant, who: string) => {
    const me = participants.find((x) => x.id === identityId);
    const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';
    if (!hasClaimByMe(p, myDisplayName)) {
      alert('Claim this person first before editing who bought');
      setEditingRow(null);
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    await api.participants.updatePurchased(Number(eventId), p.id, clerkToken, {
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

  const boardStatus = simulation ? 'purchasing' : (event?.status ?? '');
  const showPurchaseChrome = boardStatus === 'purchasing';

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
    return re.test(p.first_name) || re.test(p.last_name) || re.test(p.member_id) || re.test(p.purchasing_coordinator);
  });

  const me = participants.find((p) => p.id === identityId) ?? null;
  const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';
  const myClerkId = user?.id ?? me?.clerk_user_id ?? null;

  // Default: you + group pinned; during purchasing your active claims rise next (claim order).
  // Manual drag order applies outside purchase/simulation only — purchase toggles don't reshuffle.
  const displayRows = customRowOrder && !showPurchaseChrome
    ? filtered
    : [...filtered].sort((a, b) => {
        const ta = rowSortTier(a, me, identityId, myDisplayName, showPurchaseChrome);
        const tb = rowSortTier(b, me, identityId, myDisplayName, showPurchaseChrome);
        if (ta !== tb) return ta - tb;

        if (ta === 2) {
          const claimCmp = claimSortKey(a) - claimSortKey(b);
          if (claimCmp !== 0) return claimCmp;
        }

        if (sortCol) {
          const ai = participants.indexOf(a);
          const bi = participants.indexOf(b);
          const av = sortValue(a, sortCol, ai);
          const bv = sortValue(b, sortCol, bi);
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortDir === 'asc' ? cmp : -cmp;
        }

        return a.sort_order - b.sort_order || a.id - b.id;
      });

  const purchased  = participants.filter((p) => p.all_purchased).length;
  const inProgress = participants.filter((p) => hasRequestedDays(p) && !p.all_purchased && p.claim_active).length;
  const remaining  = participants.filter((p) => hasRequestedDays(p) && !p.all_purchased && !p.claim_active).length;
  const withGaps   = participants.filter((p) => p.gaps.length > 0 && p.any_purchased).length;
  const needsSetup = participants.filter((p) => !hasRequestedDays(p)).length;

  const [showNextUp, setShowNextUp] = useState(false);

  const priorityQueue = participants
    .filter((p) => hasRequestedDays(p) && !p.all_purchased && !p.claim_active)
    .sort((a, b) => {
      const diff = priorityScore(b, me, identityId) - priorityScore(a, me, identityId);
      return diff !== 0 ? diff : a.sort_order - b.sort_order;
    })
    .slice(0, 10);

  const allCols = [...FROZEN, ...movableCols];

  const handleLinkIdentity = async (pid: number) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await api.participants.linkIdentity(Number(eventId), pid, clerkToken);
      setIdentityId(pid);
      setShowLinkModal(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to link identity');
    }
  };

  const handleEditSave = async (data: Partial<Participant>) => {
    if (!editParticipant) return;
    const meRow = participants.find((x) => x.id === identityId) ?? null;
    if (!canEditIdentityRow(editParticipant, meRow, identityId, user?.id)) {
      alert('You can only edit your own profile or your group members');
      setEditParticipant(null);
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    await api.participants.updateProfile(Number(eventId), editParticipant.id, clerkToken, data)
      .catch((e) => alert(e instanceof Error ? e.message : 'Failed'));
    setEditParticipant(null);
    await fetchAll();
  };

  const refreshBuyerQueue = async (next: PurchaseQueueEntry[]) => {
    setBuyerQueue(next);
  };

  const handleQueueJoin = async () => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.join(Number(eventId), clerkToken));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to join queue');
    }
  };

  const handleQueueLeave = async (qid: number) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.leave(Number(eventId), qid, clerkToken));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to leave queue');
    }
  };

  const handleQueueStatus = async (qid: number, status: PurchaseQueueStatus) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.setStatus(Number(eventId), qid, clerkToken, status));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update status');
    }
  };

  const handleQueueEta = async (qid: number, eta_minutes: number | null) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.setEta(Number(eventId), qid, clerkToken, eta_minutes));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update ETA');
    }
  };

  const handleQueueMove = async (qid: number, direction: 'up' | 'down') => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.move(Number(eventId), qid, clerkToken, direction));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to reorder');
    }
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

  if (accessBlock === undefined) {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (accessBlock === 'member_id') {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 flex items-center justify-center px-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-8 max-w-md text-center shadow-xl">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Member ID required</h2>
          <p className="text-gray-500 text-sm mb-6">
            Set your Comic-Con Member ID on your profile before joining the Live Board.
            Coordinators use it to match badges during purchase day.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/dashboard/profile"
              className="bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm px-5 py-2.5 rounded-lg transition-colors"
            >
              Set Member ID →
            </Link>
            <Link
              to="/dashboard"
              className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-300 text-sm px-3 py-2.5"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (accessBlock === 'return_eligible') {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 flex items-center justify-center px-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-8 max-w-md text-center shadow-xl">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Return Reg only</h2>
          <p className="text-gray-500 text-sm mb-6">
            This Live Board is for return-eligible members. You&apos;re set up for Open registration instead.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {openLiveEventId != null && (
              <Link
                to={`/live/${openLiveEventId}`}
                className="bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm px-5 py-2.5 rounded-lg transition-colors"
              >
                Go to Open Live Board →
              </Link>
            )}
            <Link
              to="/dashboard"
              className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-300 text-sm px-3 py-2.5"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-screen bg-amber-50 dark:bg-gray-950 text-gray-950 dark:text-white flex flex-col overflow-hidden ${simulation ? 'ring-4 ring-inset ring-fuchsia-500' : ''}`}>

      {/* ── Top bar ── */}
      <div className={`bg-zinc-950 dark:bg-zinc-900 border-b-[5px] px-4 py-2.5 flex items-center gap-3 shrink-0 ${
        simulation ? 'border-fuchsia-500' : 'border-yellow-400 dark:border-yellow-500'
      }`}>
        <Link to="/" className="font-bangers text-yellow-400 text-xl tracking-wide shrink-0 hover:text-yellow-300 transition-colors">komikone</Link>
        <span className="text-zinc-600 dark:text-zinc-500 shrink-0 text-base">·</span>
        <div className="flex-1 min-w-0">
          <div className="font-bangers text-white text-lg tracking-wide leading-tight">{event?.name}</div>
          <div className={`text-[10px] uppercase tracking-widest leading-tight ${
            simulation ? 'text-fuchsia-400' : 'text-yellow-600 dark:text-yellow-500'
          }`}>
            {event?.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} · Live Board
            {simulation && ' · Simulation'}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-zinc-500 dark:text-zinc-400 text-xs hidden sm:block">
            {lastUpdated ? lastUpdated.toLocaleTimeString() : '…'}
          </span>
          <button
            type="button"
            onClick={() => setSimulation((v) => !v)}
            className={`text-xs font-bold px-2.5 py-0.5 rounded border transition-colors ${
              simulation
                ? 'bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_12px_rgba(217,70,239,0.55)]'
                : 'text-zinc-400 dark:text-zinc-300 border-zinc-700 dark:border-zinc-600 hover:text-fuchsia-300 hover:border-fuchsia-500'
            }`}
            title={simulation ? 'Exit simulation mode' : 'Practice claim & purchase without waiting for purchase day'}
          >
            {simulation ? 'Sim ON' : 'Simulate'}
          </button>
          <button
            type="button"
            onClick={toggle}
            className="text-zinc-400 dark:text-zinc-300 hover:text-yellow-400 text-xs border border-zinc-700 dark:border-zinc-600 px-2 py-0.5 rounded transition-colors"
          >
            {isDark ? '☀ Day' : '◑ Night'}
          </button>
          {me && <IdentityAvatar me={me} myDisplayName={myDisplayName} onChangeIdentity={() => setShowLinkModal(true)} />}
          <HeaderUserMenu />
        </div>
      </div>

      {simulation && (
        <div className="bg-fuchsia-600 text-white px-4 py-2 shrink-0 flex items-center gap-3 border-b-2 border-fuchsia-300">
          <span className="text-xs font-black uppercase tracking-[0.2em]">Simulation mode</span>
          <span className="text-xs text-fuchsia-100">
            Practice the full claim → purchase flow. Changes still write to this event&apos;s roster.
          </span>
          <button
            type="button"
            onClick={() => setSimulation(false)}
            className="ml-auto text-xs font-bold underline hover:no-underline shrink-0"
          >
            Exit
          </button>
        </div>
      )}

      {/* ── Stats bar ── */}
      <div className="bg-black dark:bg-zinc-950 border-b-2 border-zinc-800 dark:border-yellow-950 px-4 py-1 flex items-center gap-5 shrink-0">
        <span className="text-green-400 dark:text-green-300 text-xs font-mono">{purchased} <span className="text-zinc-600 dark:text-zinc-500">done</span></span>
        <span className="text-yellow-400 dark:text-yellow-300 text-xs font-mono">{inProgress} <span className="text-zinc-600 dark:text-zinc-500">claiming</span></span>
        <span className="text-gray-700 dark:text-gray-600 text-xs font-mono">{remaining} <span className="text-zinc-600 dark:text-zinc-500">left</span></span>
        {needsSetup > 0 && <span className="text-zinc-400 text-xs font-mono">{needsSetup} <span className="text-zinc-600 dark:text-zinc-500">setup</span></span>}
        {withGaps > 0 && <span className="text-red-400 dark:text-red-700 text-xs font-mono font-bold">{withGaps} gaps</span>}
        <div className="ml-auto flex items-center gap-2">
          {showPurchaseChrome && (
            <button
              type="button"
              onClick={() => setShowBuyerQueue((v) => !v)}
              className={`text-xs font-bold uppercase tracking-wide px-3 py-1 rounded border transition-colors ${
                showBuyerQueue
                  ? 'bg-sky-400 text-black border-sky-200'
                  : 'text-sky-300 border-sky-700 hover:border-sky-400 hover:text-sky-200'
              }`}
            >
              Queue-It line{buyerQueue.length > 0 ? ` · ${buyerQueue.filter((q) => q.status !== 'done' && q.status !== 'skipped').length}` : ''}
            </button>
          )}
          {showPurchaseChrome && priorityQueue.length > 0 && (
            <button
              onClick={() => setShowNextUp((v) => !v)}
              className={`text-sm font-black uppercase tracking-wide px-4 py-1.5 rounded-md border-2 transition-colors ${
                showNextUp
                  ? 'bg-yellow-300 text-black border-yellow-100 shadow-lg shadow-yellow-400/40'
                  : 'whos-next-flash bg-yellow-400 text-black border-yellow-200 hover:bg-yellow-300'
              }`}
            >
              ⚡ Who&apos;s next?
            </button>
          )}
        </div>
      </div>

      {/* ── Who's Next panel (purchasing phase or simulation) ── */}
      {showPurchaseChrome && showNextUp && priorityQueue.length > 0 && (
        <NextUpPanel
          queue={priorityQueue}
          me={me}
          identityId={identityId}
          onClaim={handleClaim}
          onDismiss={() => setShowNextUp(false)}
        />
      )}

      {/* ── Pre-purchase tip banners (hidden while simulating) ── */}
      {!simulation && event?.status === 'setup' && (
        <div className="bg-amber-50 dark:bg-yellow-950/30 border-b-2 border-amber-300 dark:border-yellow-800 px-4 py-2 shrink-0">
          <span className="text-amber-800 dark:text-yellow-300 text-xs font-bold uppercase tracking-wider">Preview · </span>
          <span className="text-amber-700 dark:text-yellow-400/90 text-xs">
            Look around and get familiar with the board. Claiming opens when purchase day starts — or turn on Simulate to practice.
          </span>
        </div>
      )}
      {!simulation && event?.status === 'registration' && (
        <div className="bg-blue-50 dark:bg-blue-950/30 border-b-2 border-blue-300 dark:border-blue-800 px-4 py-2 shrink-0">
          <span className="text-blue-700 dark:text-blue-300 text-xs font-bold uppercase tracking-wider">Registration is open · </span>
          <span className="text-blue-600 dark:text-blue-400 text-xs">
            Purchase day hasn&apos;t started. Verify your requested days, Member ID, and badge type — or turn on Simulate to practice claiming.
          </span>
        </div>
      )}

      {/* Board + optional Queue-It side rail */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          {/* ── Filter bar ── */}
          <div className="border-b-2 border-yellow-200 dark:border-gray-300 bg-amber-50 dark:bg-gray-900 px-4 py-2 flex items-center gap-3 flex-wrap shrink-0">
            <input
              type="search"
              placeholder="Search… (* wildcard)"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1 text-sm text-gray-900 dark:text-gray-50 w-52 focus:outline-none focus:border-yellow-400 dark:focus:border-yellow-400 placeholder:text-gray-400 dark:placeholder:text-gray-500"
            />
            <div className="flex gap-1.5 flex-wrap">
              {([
                ['all',      'All'],
                ['setup',    'Setup'],
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
                      ? 'bg-yellow-400 text-black border-transparent'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
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

          {/* ── Link identity modal ── */}
          {showLinkModal && (
            <LinkIdentityModal
              participants={participants}
              currentIdentityId={identityId}
              userName={user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : ''}
              onLink={handleLinkIdentity}
              onDismiss={() => setShowLinkModal(false)}
              registerUrl={`/register/${eventId}`}
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
                      'bg-gray-50 dark:bg-gray-800 text-yellow-500/70 dark:text-yellow-400/60',
                      'border-b-2 border-yellow-900 dark:border-gray-300',
                      isSorted ? 'text-yellow-400 dark:text-yellow-300' : 'hover:text-gray-900 dark:hover:text-yellow-200 cursor-pointer',
                      isMovable ? 'cursor-grab' : '',
                      isDropTarget ? 'bg-blue-900 text-white' : '',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      {isMovable && <span className="text-gray-500 dark:text-zinc-500 text-[10px] mr-0.5">⠿</span>}
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
              const isSelf = identityId != null && p.id === identityId;
              const isMyGroup = !isSelf && me?.group_id != null && p.group_id === me.group_id;

              const frozenBg = isFlashing
                ? 'bg-blue-100 dark:bg-blue-900/30'
                : isSelf
                  ? 'bg-yellow-50 dark:bg-yellow-950/40'
                  : isMyGroup
                    ? 'bg-amber-50/80 dark:bg-amber-950/25'
                    : evenRow
                      ? 'bg-white dark:bg-gray-900'
                      : 'bg-gray-50 dark:bg-gray-800/60';

              const rowBg = isFlashing
                ? 'bg-blue-100 dark:bg-blue-900/30'
                : isRowDragTarget
                  ? 'bg-blue-100 dark:bg-blue-900/20'
                  : isSelf
                    ? 'bg-yellow-50 dark:bg-yellow-950/40'
                    : isMyGroup
                      ? 'bg-amber-50/80 dark:bg-amber-950/25'
                      : evenRow
                        ? 'bg-white dark:bg-gray-900'
                        : 'bg-gray-50 dark:bg-gray-800/60';

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
                          'px-3 py-1.5 border-b border-gray-100 dark:border-gray-200/70 align-middle',
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
                              className="text-gray-700 dark:text-gray-700 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-xs leading-none select-none"
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
                            eventStatus={boardStatus}
                            naturalIdx={naturalIdx}
                            editingRow={editingRow}
                            setEditingRow={setEditingRow}
                            canEditRequested={!showPurchaseChrome && canEditIdentityRow(p, me, identityId, myClerkId)}
                            canEditProfile={canEditIdentityRow(p, me, identityId, myClerkId)}
                            canTogglePurchase={hasClaimByMe(p, myDisplayName)}
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

        {showPurchaseChrome && showBuyerQueue && (
          <BuyerQueuePanel
            queue={buyerQueue}
            myClerkId={user?.id ?? null}
            identityLinked={identityId != null}
            onJoin={handleQueueJoin}
            onLeave={handleQueueLeave}
            onStatus={handleQueueStatus}
            onEta={handleQueueEta}
            onMove={handleQueueMove}
            onDismiss={() => setShowBuyerQueue(false)}
          />
        )}
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
        className={`transition-opacity text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-800 ${hovered || copied ? 'opacity-100' : 'opacity-0'}`}
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
  col, p, status, eventStatus, editingRow, setEditingRow, canEditRequested, canEditProfile, canTogglePurchase,
  onClaim, onUnclaim, onRequestedToggle, onPurchaseToggle, onWhoChange, onEditParticipant,
}: {
  col: ColKey;
  p: Participant;
  status: RowStatus;
  eventStatus: string;
  naturalIdx: number;
  editingRow: number | null;
  setEditingRow: (id: number | null) => void;
  canEditRequested: boolean;
  canEditProfile: boolean;
  canTogglePurchase: boolean;
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
      if (!canEditProfile) return null;
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
      ) : <span className="text-gray-400 dark:text-gray-600 text-xs flex justify-center">—</span>;

    case 'group':
      return p.group_name ? (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
          style={{ backgroundColor: p.group_color ?? '#6366f1' }}
        >
          {p.group_name}
        </span>
      ) : <span className="text-gray-400 dark:text-gray-600 text-xs">—</span>;

    case 'member_id':
      return (
        <CopyCell value={(p.member_id || '').toUpperCase()}>
          <MemberId value={p.member_id} />
        </CopyCell>
      );

    case 'requested':
      return (
        <div style={{ display: 'flex', gap: DAY_GAP }}>
          {DAY_KEYS.map((day) => {
            const req = p[`req_${day}` as keyof Participant] as boolean;
            const bought = p[`pur_${day}` as keyof Participant] as boolean;
            return (
              <div key={day} style={{ width: DAY_SLOT_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                {bought || !canEditRequested ? (
                  <div
                    title={bought ? 'Purchased — locked' : canEditRequested ? '' : 'You can only change requested days for yourself or your group'}
                    className={`w-4 h-4 rounded-sm border-2 ${
                      bought ? 'cursor-not-allowed opacity-60' : 'cursor-default'
                    } ${
                      req
                        ? 'bg-gray-400 border-gray-500 dark:bg-gray-500 dark:border-gray-400'
                        : 'border-gray-200 dark:border-gray-300'
                    }`}
                  />
                ) : (
                  <button
                    onClick={() => onRequestedToggle(p, day, !req)}
                    className={`w-4 h-4 rounded-sm border-2 transition-colors ${
                      req
                        ? 'bg-gray-400 border-gray-500 dark:bg-gray-500 dark:border-gray-400'
                        : 'bg-transparent border-gray-300 hover:border-gray-400 dark:border-gray-300 dark:hover:border-gray-500'
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
                {!req ? (
                  <div className="w-4 h-4 rounded-sm border border-gray-200 dark:border-gray-300" />
                ) : canTogglePurchase ? (
                  <button
                    onClick={() => onPurchaseToggle(p, day, !bought)}
                    className={`w-4 h-4 rounded-sm border-2 transition-colors ${
                      bought
                        ? 'bg-green-500 border-green-600 dark:bg-green-500 dark:border-green-400'
                        : 'bg-transparent border-gray-300 hover:border-green-400 hover:bg-green-50 dark:border-gray-300 dark:hover:border-green-500'
                    }`}
                  />
                ) : (
                  <div
                    title={p.claim_active ? 'Only the claimer can mark purchases' : 'Claim this person first to mark purchases'}
                    className={`w-4 h-4 rounded-sm border-2 cursor-not-allowed ${
                      bought
                        ? 'bg-green-500/70 border-green-600/70 dark:bg-green-500/60 dark:border-green-400/60'
                        : 'border-gray-200 dark:border-gray-300 opacity-70'
                    }`}
                  />
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
                    : 'border-gray-200 dark:border-gray-300'
                }`} />
                <span className="text-[7px] text-gray-400 dark:text-gray-600 leading-none">{DAY_SHORT[day]}</span>
              </div>
            );
          })}
        </div>
      );

    case 'status':
      if (status === 'setup') {
        return (
          <span
            className="inline-flex items-center gap-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 px-2 py-0.5 rounded-full"
            title="No badge days requested yet"
          >
            Setup
          </span>
        );
      }
      if (status === 'complete') {
        return (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 border border-green-300 dark:border-green-800 px-2 py-0.5 rounded-full">
            ✓ Done
          </span>
        );
      }
      if (eventStatus !== 'purchasing') {
        return <span className="text-gray-400 dark:text-gray-600 text-xs">—</span>;
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
        <span className="font-mono text-xs text-gray-800 dark:text-gray-800">
          {p.purchase_total > 0 ? formatDollars(p.purchase_total) : '—'}
        </span>
      );

    case 'who':
      return editingRow === p.id && canTogglePurchase ? (
        <WhoInput
          initial={p.who_purchased}
          onSave={(val) => onWhoChange(p, val)}
          onCancel={() => setEditingRow(null)}
        />
      ) : canTogglePurchase ? (
        <button
          onClick={() => setEditingRow(p.id)}
          className="text-xs text-left text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-900"
        >
          {p.who_purchased || <span className="italic text-gray-400 dark:text-gray-600">tap to set</span>}
        </button>
      ) : (
        <span className="text-xs text-gray-500 dark:text-gray-500">
          {p.who_purchased || '—'}
        </span>
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
          <div className="absolute right-0 top-9 z-50 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl p-4 min-w-[180px]">
            <div className="text-gray-900 dark:text-white font-semibold text-sm">{myDisplayName}</div>
            {me.member_id && (
              <div className="mt-0.5">
                <MemberId value={me.member_id} className="font-mono text-xs tracking-wide" letterClassName="text-gray-400" digitClassName="text-amber-400" />
              </div>
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
              className="mt-3 text-xs text-gray-400 hover:text-gray-900 dark:hover:text-white underline block"
            >
              Change identity
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function LinkIdentityModal({
  participants, currentIdentityId, userName, onLink, onDismiss, registerUrl,
}: {
  participants: Participant[];
  currentIdentityId: number | null;
  userName: string;
  onLink: (id: number) => Promise<void>;
  onDismiss: () => void;
  registerUrl: string;
}) {
  const [search, setSearch] = useState(userName);
  const [linking, setLinking] = useState<number | null>(null);
  const filtered = participants.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const full = `${p.first_name} ${p.last_name}`.toLowerCase();
    const parts = q.split(/\s+/).filter(Boolean);
    return full.includes(q)
      || p.first_name.toLowerCase().includes(q)
      || p.last_name.toLowerCase().includes(q)
      || p.member_id.toLowerCase().includes(q)
      || (parts.length > 1 && parts.every((part) => full.includes(part)));
  });

  const isReLinking = currentIdentityId !== null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl w-full max-w-sm shadow-2xl">
        <div className="px-5 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-gray-900 dark:text-white font-bold text-lg">
            {isReLinking ? 'Change your identity' : 'Link your account'}
          </h2>
          <p className="text-gray-400 text-sm mt-0.5">
            {isReLinking
              ? 'Pick a different participant to link to your account'
              : 'Select yourself from the list — this links your account to your participant slot'}
          </p>
          <input
            autoFocus
            type="search"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full mt-3 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-gray-900 dark:text-gray-50 text-sm focus:outline-none focus:border-yellow-500 placeholder:text-gray-500"
          />
        </div>
        <div className="overflow-y-auto max-h-72 py-1">
          {filtered.map((p) => (
            <button
              key={p.id}
              disabled={linking !== null}
              onClick={async () => { setLinking(p.id); await onLink(p.id); setLinking(null); }}
              className="w-full text-left px-5 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 flex items-center justify-between"
            >
              <span>
                <span className="text-gray-900 dark:text-white font-medium text-sm">{p.first_name} {p.last_name}</span>
                {p.group_name && (
                  <span className="ml-2 text-xs text-gray-500">{p.group_name}</span>
                )}
              </span>
              {linking === p.id && <span className="text-yellow-400 text-xs">Linking…</span>}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-gray-500 text-sm px-5 py-4 text-center">No match</p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <Link to={registerUrl} className="text-gray-500 hover:text-gray-700 text-sm underline">
            Not on the list? Register here
          </Link>
          <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400 text-xs">
            {isReLinking ? 'Cancel' : 'Skip for now'}
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
        onChange={(e) => setForm((f) => ({
          ...f,
          [key]: key === 'member_id' ? normalizeMemberIdInput(e.target.value) : e.target.value,
        }))}
        className={`w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-gray-50 text-sm focus:outline-none focus:border-blue-500 ${mono ? 'font-mono uppercase tracking-wide' : ''}`}
        autoCapitalize={key === 'member_id' ? 'characters' : undefined}
        spellCheck={key === 'member_id' ? false : undefined}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl w-full max-w-sm shadow-2xl">
        <div className="px-5 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-gray-900 dark:text-white font-bold text-lg">Edit Participant</h2>
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
              className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-gray-50 text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="ADULT">Adult</option>
              <option value="JUNIOR">Junior</option>
            </select>
          </div>
          {field('Notes', 'notes')}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-900 dark:hover:text-white">
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

// ─── BuyerQueuePanel (Queue-It ETA prep order) ────────────────────────────────

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

function formatEta(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  return 'More than an hour';
}

function cookieSlotLabel(
  entry: PurchaseQueueEntry,
  queue: PurchaseQueueEntry[],
): string | null {
  const mine = queue
    .filter((q) => q.clerk_user_id === entry.clerk_user_id)
    .sort((a, b) => a.id - b.id);
  if (mine.length < 2) return null;
  const n = mine.findIndex((q) => q.id === entry.id) + 1;
  return `Cookie ${n}`;
}

function BuyerQueuePanel({
  queue, myClerkId, identityLinked, onJoin, onLeave, onStatus, onEta, onMove, onDismiss,
}: {
  queue: PurchaseQueueEntry[];
  myClerkId: string | null;
  identityLinked: boolean;
  onJoin: () => Promise<void>;
  onLeave: (qid: number) => Promise<void>;
  onStatus: (qid: number, status: PurchaseQueueStatus) => Promise<void>;
  onEta: (qid: number, eta_minutes: number | null) => Promise<void>;
  onMove: (qid: number, direction: 'up' | 'down') => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const myActiveCount = myClerkId
    ? queue.filter((q) => q.clerk_user_id === myClerkId && q.status !== 'done' && q.status !== 'skipped').length
    : 0;
  const active = queue.filter((q) => q.status !== 'done' && q.status !== 'skipped');
  const finished = queue.filter((q) => q.status === 'done' || q.status === 'skipped');

  // Prep order: buying first, then soonest ETA (server already sorts this way).
  const buying = active.find((q) => q.status === 'buying') ?? null;
  const byEta = active.filter((q) => q.status !== 'buying');
  const soonest = buying ?? byEta[0] ?? null;
  const onDeck = soonest
    ? byEta.find((q) => q.id !== soonest.id) ?? null
    : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <aside className="w-[17.5rem] shrink-0 border-l-4 border-sky-400 bg-sky-50 dark:bg-sky-950/50 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-sky-200 dark:border-sky-800 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sky-700 dark:text-sky-300 text-[10px] font-bold uppercase tracking-widest">
            Queue-It line
          </div>
          <button type="button" onClick={onDismiss} className="text-sky-500 hover:text-sky-800 text-xs px-1">✕</button>
        </div>
        <p className="text-sky-900/60 dark:text-sky-200/60 text-[11px] mt-1 leading-snug">
          One slot per cookie / browser. Report ETA; sorts soonest-first.
        </p>
        {identityLinked && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(onJoin)}
            className="mt-2 w-full text-xs font-bold px-3 py-1.5 rounded bg-sky-500 hover:bg-sky-400 text-white disabled:opacity-50"
          >
            {myActiveCount > 0 ? 'Add another place in line' : 'Join line'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {(soonest || onDeck || active.length > 0) && (
          <div className="space-y-2">
            <BuyerSpotlight
              label="Coming through next"
              entry={soonest}
              cookieLabel={soonest ? cookieSlotLabel(soonest, queue) : null}
              empty="Report ETAs from Queue-It screens"
              accent="sky"
            />
            <BuyerSpotlight
              label="On deck — prep them"
              entry={onDeck}
              cookieLabel={onDeck ? cookieSlotLabel(onDeck, queue) : null}
              empty="Next after soonest ETA"
              accent="amber"
            />
          </div>
        )}

        {active.length === 0 && finished.length === 0 && (
          <p className="text-sky-800/60 dark:text-sky-300/50 text-xs py-2">
            {identityLinked
              ? 'Nobody in line yet — join when you\'re on the call, then tap your ETA.'
              : 'Link your identity, then join the line.'}
          </p>
        )}

        {active.length > 0 && (
          <ol className="space-y-1.5">
            {active.map((entry, i) => (
              <BuyerQueueRow
                key={entry.id}
                entry={entry}
                index={i + 1}
                cookieLabel={cookieSlotLabel(entry, queue)}
                isMe={entry.clerk_user_id === myClerkId}
                busy={busy}
                canMoveUp={i > 0 && entry.eta_minutes == null}
                canMoveDown={i < active.length - 1 && entry.eta_minutes == null}
                onStatus={(status) => run(() => onStatus(entry.id, status))}
                onEta={(mins) => run(() => onEta(entry.id, mins))}
                onMove={(dir) => run(() => onMove(entry.id, dir))}
                onLeave={() => run(() => onLeave(entry.id))}
              />
            ))}
          </ol>
        )}

        {finished.length > 0 && (
          <div className="pt-2 border-t border-sky-200 dark:border-sky-800">
            <div className="text-[10px] uppercase tracking-widest text-sky-600/70 mb-1.5">Finished</div>
            <div className="flex flex-col gap-1">
              {finished.map((e) => (
                <span
                  key={e.id}
                  className={`text-[10px] font-medium px-2 py-0.5 rounded ${QUEUE_STATUS_STYLE[e.status]}`}
                >
                  {e.first_name} {e.last_name}
                  {cookieSlotLabel(e, queue) ? ` · ${cookieSlotLabel(e, queue)}` : ''}
                  {' · '}{QUEUE_STATUS_LABEL[e.status]}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function BuyerSpotlight({
  label, entry, cookieLabel, empty, accent,
}: {
  label: string;
  entry: PurchaseQueueEntry | null;
  cookieLabel: string | null;
  empty: string;
  accent: 'sky' | 'amber';
}) {
  const ring = accent === 'sky'
    ? 'border-sky-400 bg-white dark:bg-sky-950/60'
    : 'border-amber-400 bg-white dark:bg-amber-950/40';
  return (
    <div className={`rounded-lg border-2 px-2.5 py-2 ${ring}`}>
      <div className={`text-[9px] font-bold uppercase tracking-widest ${
        accent === 'sky' ? 'text-sky-600' : 'text-amber-600'
      }`}>
        {label}
      </div>
      {entry ? (
        <div className="mt-0.5">
          <div className="font-bangers text-lg text-gray-900 dark:text-white tracking-wide leading-tight">
            {entry.first_name} {entry.last_name}
          </div>
          {cookieLabel && (
            <div className="text-[10px] font-bold text-sky-700 dark:text-sky-300 mt-0.5">{cookieLabel}</div>
          )}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {entry.eta_minutes != null && (
              <span className="text-sm font-bold text-gray-900 dark:text-white font-mono">
                ~{formatEta(entry.eta_minutes)}
              </span>
            )}
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${QUEUE_STATUS_STYLE[entry.status]}`}>
              {QUEUE_STATUS_LABEL[entry.status]}
            </span>
          </div>
          {entry.member_id && (
            <div className="font-mono text-[10px] text-gray-500 tracking-wide mt-0.5">
              {entry.member_id.toUpperCase()}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-gray-400 mt-0.5">{empty}</div>
      )}
    </div>
  );
}

function BuyerQueueRow({
  entry, index, cookieLabel, isMe, busy, canMoveUp, canMoveDown, onStatus, onEta, onMove, onLeave,
}: {
  entry: PurchaseQueueEntry;
  index: number;
  cookieLabel: string | null;
  isMe: boolean;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStatus: (status: PurchaseQueueStatus) => Promise<void>;
  onEta: (eta_minutes: number | null) => Promise<void>;
  onMove: (direction: 'up' | 'down') => Promise<void>;
  onLeave: () => Promise<void>;
}) {
  const next = QUEUE_STATUS_NEXT[entry.status];
  return (
    <li className={`rounded-md border px-2 py-1.5 ${
      isMe
        ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30'
        : 'border-sky-200 dark:border-sky-800 bg-white/80 dark:bg-sky-950/30'
    }`}>
      <div className="flex items-start gap-1.5">
        <span className="text-[10px] font-mono text-sky-600 w-4 shrink-0 pt-0.5">{index}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1 flex-wrap">
            <span className="font-semibold text-xs text-gray-900 dark:text-white leading-tight">
              {entry.first_name} {entry.last_name}
            </span>
            {isMe && <span className="text-[9px] font-bold bg-yellow-400 text-black px-1 py-0.5 rounded">YOU</span>}
          </div>
          {cookieLabel && (
            <div className="text-[10px] font-bold text-sky-700 dark:text-sky-300">{cookieLabel}</div>
          )}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-xs font-bold font-mono text-gray-900 dark:text-white">
              {entry.eta_minutes != null ? `~${formatEta(entry.eta_minutes)}` : '—'}
            </span>
            <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${QUEUE_STATUS_STYLE[entry.status]}`}>
              {QUEUE_STATUS_LABEL[entry.status]}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          {entry.eta_minutes == null && (
            <>
              <button
                type="button"
                disabled={busy || !canMoveUp}
                onClick={() => onMove('up')}
                className="text-[10px] px-1 rounded text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900 disabled:opacity-30"
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={busy || !canMoveDown}
                onClick={() => onMove('down')}
                className="text-[10px] px-1 rounded text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900 disabled:opacity-30"
                title="Move down"
              >
                ↓
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {next && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus(next)}
            className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-500 hover:bg-sky-400 text-white disabled:opacity-50"
          >
            → {QUEUE_STATUS_LABEL[next]}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onLeave()}
          className="text-[9px] px-1.5 py-0.5 text-gray-400 hover:text-red-500 disabled:opacity-50"
          title="Remove this cookie slot"
        >
          remove
        </button>
        {entry.status !== 'skipped' && entry.status !== 'done' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus('skipped')}
            className="text-[9px] px-1.5 py-0.5 text-gray-400 hover:text-red-500 disabled:opacity-50"
            title="Skip"
          >
            skip
          </button>
        )}
      </div>
      {entry.status !== 'done' && entry.status !== 'skipped' && (
        <div className="mt-1.5 grid grid-cols-3 gap-1">
          {ETA_PRESETS.map((p) => (
            <button
              key={p.minutes}
              type="button"
              disabled={busy}
              onClick={() => onEta(p.minutes)}
              className={`text-[9px] font-bold px-1 py-0.5 rounded border transition-colors disabled:opacity-50 ${
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
          {entry.eta_minutes != null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onEta(null)}
              className="text-[9px] px-1 py-0.5 text-gray-400 hover:text-red-500 disabled:opacity-50 col-span-3 text-left"
            >
              clear ETA
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// ─── NextUpPanel ─────────────────────────────────────────────────────────────

function priorityReason(p: Participant, me: Participant | null, identityId: number | null): string {
  if (p.id === identityId) return "It's you!";
  if (me?.group_id != null && p.group_id === me.group_id) return `Same group · ${p.group_name ?? ''}`;
  const hardest = p.gaps.reduce<string | null>((best, d) => {
    if (!best) return d;
    return (DAY_DIFFICULTY[d] ?? 2) > (DAY_DIFFICULTY[best] ?? 2) ? d : best;
  }, null);
  if (hardest === 'Sat') return 'Needs Saturday — hardest to get';
  if (hardest === 'Fri') return 'Needs Friday — high demand';
  if (p.gaps.length >= 3) return `${p.gaps.length} days still needed`;
  return `${p.gaps.length} gap${p.gaps.length !== 1 ? 's' : ''} remaining`;
}

function NextUpPanel({
  queue, me, identityId, onClaim, onDismiss,
}: {
  queue: Participant[];
  me: Participant | null;
  identityId: number | null;
  onClaim: (p: Participant) => Promise<void>;
  onDismiss: () => void;
}) {
  const [slots] = useState(() => queue.slice(0, 3));
  const [claimed, setClaimed] = useState<Set<number>>(new Set());

  if (slots.length === 0) return null;

  const handleClaim = async (p: Participant) => {
    await onClaim(p);
    setClaimed((prev) => new Set(prev).add(p.id));
  };

  return (
    <div className="bg-white dark:bg-gray-900 border-b-4 border-yellow-400 px-4 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-yellow-400 text-[10px] font-bold uppercase tracking-widest">
          Buy for next — up to 3
        </span>
        <button onClick={onDismiss} className="text-zinc-500 hover:text-gray-700 text-xs px-1">✕</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {slots.map((p) => (
          <NextUpCard key={p.id} p={p} me={me} identityId={identityId} claimed={claimed.has(p.id)} onClaim={handleClaim} />
        ))}
      </div>
    </div>
  );
}

function NextUpCard({
  p, me, identityId, claimed, onClaim,
}: {
  p: Participant;
  me: Participant | null;
  identityId: number | null;
  claimed: boolean;
  onClaim: (p: Participant) => Promise<void>;
}) {
  const [claiming, setClaiming] = useState(false);
  const isSelf = p.id === identityId;
  const isGroup = !isSelf && me?.group_id != null && p.group_id === me.group_id;
  const reason = priorityReason(p, me, identityId);

  return (
    <div className={`border rounded-lg px-3 py-2.5 flex flex-col gap-2 transition-colors ${claimed ? 'bg-green-950/40 border-green-700' : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600'}`}>
      <div className="flex items-start gap-2">
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center border ${claimed ? 'bg-green-600 border-green-400' : 'bg-yellow-400 border-yellow-300'}`}>
          <span className="font-bangers text-black text-sm leading-none">
            {p.first_name[0]}{p.last_name[0]}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bangers text-gray-900 dark:text-white text-base tracking-wide leading-tight">
              {p.first_name} {p.last_name}
            </span>
            {(isSelf || isGroup) && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${isSelf ? 'bg-yellow-400 text-black' : 'bg-blue-600 text-white'}`}>
                {isSelf ? 'YOU' : p.group_name ?? 'Group'}
              </span>
            )}
          </div>
          <div className="text-gray-600 text-[10px] mt-0.5 leading-tight">{reason}</div>
        </div>
      </div>
      <div className="flex gap-1 flex-wrap">
        {p.gaps.map((day) => (
          <span
            key={day}
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border border-black/20 ${DAY_CHIP_COLOR[day] ?? 'bg-zinc-600 text-white'}`}
          >
            {day}
          </span>
        ))}
      </div>
      {claimed ? (
        <div className="mt-auto text-xs font-bold py-1.5 rounded bg-green-700 text-green-200 text-center w-full">
          ✓ Claimed
        </div>
      ) : (
        <button
          onClick={async () => { setClaiming(true); await onClaim(p); setClaiming(false); }}
          disabled={claiming}
          className="mt-auto text-xs font-bold py-1.5 rounded bg-yellow-400 hover:bg-yellow-300 text-black border border-yellow-200 disabled:opacity-50 transition-colors w-full"
        >
          {claiming ? 'Claiming…' : 'Claim'}
        </button>
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
        className="bg-white dark:bg-gray-800 border border-gray-400 dark:border-gray-600 rounded px-1.5 py-0.5 text-xs text-gray-900 dark:text-gray-50 w-24 focus:outline-none"
      />
      <button onClick={() => onSave(val)} className="text-xs text-green-600 hover:text-green-800 dark:text-green-400">✓</button>
      <button onClick={onCancel} className="text-xs text-gray-400 hover:text-red-600">✕</button>
    </div>
  );
}
