import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { api, type EventDetail, type Participant, type PurchaseQueueEntry, type PurchaseQueueStatus, type SaleDay, formatDollars, DAY_KEYS, type DayKey } from '../lib/api';
import { DayPicker, type DayFlags } from '../components/DayPicker';
import {
  QUEUE_MOVE_SHOW_MS,
  activeQueue,
  isQueueActive,
  rankById,
  rankMovement,
} from '../lib/queueBoard';
import { BuyerQueuePanel, SoldOutBar } from '../components/QueueDraftBoard';
import { BuyListPanel } from '../components/BuyListPanel';
import { HeaderUserMenu } from '../components/HeaderUserMenu';
import { useTheme } from '../lib/useTheme';
import { MemberId, normalizeMemberIdInput } from '../components/MemberId';
import { ToggleSwitch } from '../components/ToggleSwitch';
import {
  BLOCKER_LABEL,
  CLAIM_TIMEOUT_MINUTES,
  MAX_ACTIVE_CLAIMS,
  type PurchaseBlocker,
  type SimPatches,
  applySimPatches,
  canAddToBuyList,
  claimRemainingMs,
  formatClaimCountdown,
  hasRequestedDays,
  holdsClaimSlot,
  isClaimLive,
  isClaimable,
  isClaimedBy,
  parseClaimTimestamp,
  purchaseBlockers,
  nothingLeftToBuy,
  purchasedByMe,
  SALE_DAY_FULL,
  setSimPatch,
  soldOutDays,
} from '../lib/purchaseBoard';

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
const FROZEN_PX: Record<string, number> = { actions: 52, idx: 36, first: 90, last: 96 };
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
  status: 128, total: 74, who: 118, group: 110,
};

const DAY_COLS = new Set<ColKey>(['requested', 'purchased', 'gaps']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Claimed by you, or bought by you after the claim auto-released on Done. */
function canEditPurchases(p: Participant, myDisplayName: string, now = Date.now()): boolean {
  return isClaimedBy(p, myDisplayName, now) || (p.all_purchased && purchasedByMe(p, myDisplayName));
}

/** Column-width friendly version of BLOCKER_LABEL. */
const BLOCKER_SHORT: Record<PurchaseBlocker, string> = {
  days: 'Needs badge days',
  member_id: 'Needs Member ID',
  return_eligible: 'Not return eligible',
};

function rowStatus(p: Participant, now = Date.now()): RowStatus {
  if (!hasRequestedDays(p)) return 'setup';
  if (nothingLeftToBuy(p)) return 'complete';
  if (isClaimLive(p, now)) return 'claiming';
  if (p.any_purchased) return 'partial';
  return 'none';
}

function sortValue(p: Participant, col: ColKey, naturalIdx: number, now = Date.now()): string | number {
  switch (col) {
    case 'idx':        return naturalIdx;
    case 'first':      return p.first_name.toLowerCase();
    case 'last':       return p.last_name.toLowerCase();
    case 'member_id':  return p.member_id.toLowerCase();
    case 'badge_type': return p.badge_type;
    case 'requested':  return DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).length;
    case 'status':     return ['setup', 'none', 'partial', 'claiming', 'complete'].indexOf(rowStatus(p, now));
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

/** Lower tier = higher on the board. During purchasing, your active claims float below self/group. */
function rowSortTier(
  p: Participant,
  me: Participant | null,
  identityId: number | null,
  myDisplayName: string,
  purchaseMode: boolean,
  now = Date.now(),
): number {
  if (identityId != null && p.id === identityId) return 0;
  if (me?.group_id != null && p.group_id === me.group_id) return 1;
  if (purchaseMode && holdsClaimSlot(p, myDisplayName, now)) return 2;
  return 3;
}

function claimSortKey(p: Participant): number {
  if (!p.purchasing_claimed_at) return Number.MAX_SAFE_INTEGER;
  return parseClaimTimestamp(p.purchasing_claimed_at) ?? Number.MAX_SAFE_INTEGER;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LiveBoard() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { toggle, isDark } = useTheme();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [serverParticipants, setServerParticipants] = useState<Participant[]>([]);
  const [buyerQueue, setBuyerQueue] = useState<PurchaseQueueEntry[]>([]);
  /** Last poll of the line failed, so what's on screen may be out of date. */
  const [queueStale, setQueueStale] = useState(false);
  /** Recent pick-number changes, keyed by queue entry, for the ▲/▼ markers. */
  const [queueMoves, setQueueMoves] = useState<Record<number, { delta: number; at: number }>>({});
  const queueRanksRef = useRef<Map<number, number>>(new Map());
  // On a phone the panel is a bottom sheet over the board, so it starts closed there.
  const [showBuyerQueue, setShowBuyerQueue] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches,
  );

  const applyQueue = useCallback((next: PurchaseQueueEntry[]) => {
    const ranks = rankById(next);
    const moved = rankMovement(queueRanksRef.current, ranks);
    queueRanksRef.current = ranks;
    setBuyerQueue(next);
    if (moved.size === 0) return;
    const at = Date.now();
    setQueueMoves((prev) => {
      const out = { ...prev };
      for (const [id, delta] of moved) out[id] = { delta, at };
      return out;
    });
  }, []);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [identityId, setIdentityId] = useState<number | null>(null);
  /** Your own ranked participant ids for Who's next. */
  const [buyList, setBuyList] = useState<number[]>([]);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editParticipant, setEditParticipant] = useState<Participant | null>(null);
  const [flash, setFlash] = useState<Record<number, boolean>>({});
  const [simulation, setSimulation] = useState(() => {
    try { return localStorage.getItem(simStorageKey(eventId)) === '1'; } catch { return false; }
  });
  /** Practice edits live here only — Simulate never writes to the roster. */
  const [simPatches, setSimPatches] = useState<SimPatches>({});
  /** null = still checking; string = block reason before board access */
  const [accessBlock, setAccessBlock] = useState<'member_id' | 'return_eligible' | null | undefined>(undefined);
  const [openLiveEventId, setOpenLiveEventId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const prevIds = useRef<Set<number>>(new Set());
  const expiredFetchRef = useRef(false);

  const isPlatformAdmin = user?.publicMetadata?.role === 'admin';

  useEffect(() => {
    try {
      localStorage.setItem(simStorageKey(eventId), simulation ? '1' : '0');
    } catch { /* ignore */ }
  }, [simulation, eventId]);

  const participants = simulation
    ? applySimPatches(serverParticipants, simPatches, event, now)
    : serverParticipants;

  const exitSimulation = () => {
    setSimulation(false);
    setSimPatches({});
    setEditingRow(null);
  };

  const hasSimEdits = Object.keys(simPatches).length > 0;

  // Tick once per second while any claim or queue ETA is counting down.
  const hasLiveClaims = participants.some((p) => isClaimLive(p, now));
  const hasQueueEtas = buyerQueue.some((q) => q.eta_at && isQueueActive(q));
  const hasRecentMoves = Object.values(queueMoves).some((m) => now - m.at < QUEUE_MOVE_SHOW_MS);
  const needsTick = hasLiveClaims || hasQueueEtas || hasRecentMoves;
  useEffect(() => {
    if (!needsTick) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [needsTick]);

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
        // Include return-ineligible rows so group members are never silently missing.
        api.participants.list(Number(eventId), clerkToken, { includeIneligible: true }),
        // null rather than [] on failure: an empty list here wiped everyone's places off
        // the screen for a whole poll whenever one request blipped.
        api.purchaseQueue.list(Number(eventId), clerkToken).catch(() => null),
      ]);
      setEvent(ev);
      if (queue) applyQueue(queue);
      setQueueStale(queue == null);
      const newFlash: Record<number, boolean> = {};
      for (const p of ps) {
        if (prevIds.current.has(p.id)) {
          const old = serverParticipants.find((x) => x.id === p.id);
          if (old && old.updated_at !== p.updated_at) newFlash[p.id] = true;
        }
      }
      if (Object.keys(newFlash).length > 0) {
        setFlash(newFlash);
        setTimeout(() => setFlash({}), 1200);
      }
      prevIds.current = new Set(ps.map((p) => p.id));
      setServerParticipants(ps);
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
  }, [eventId, getToken, serverParticipants, applyQueue]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(interval);
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a claim timer hits zero, refresh so server claim_active catches up.
  useEffect(() => {
    const anyExpiring = serverParticipants.some(
      (p) => p.purchasing_claimed_by && claimRemainingMs(p.purchasing_claimed_at, now) === 0 && p.claim_active,
    );
    if (anyExpiring && !expiredFetchRef.current) {
      expiredFetchRef.current = true;
      void fetchAll();
    }
    if (!anyExpiring) expiredFetchRef.current = false;
  }, [now, serverParticipants, fetchAll]);

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

  useEffect(() => {
    if (!eventId || !isSignedIn) return;
    let cancelled = false;
    getToken({ template: 'komikone' }).then(async (clerkToken) => {
      if (!clerkToken) return;
      const res = await api.buyList.get(Number(eventId), clerkToken).catch(() => null);
      if (res && !cancelled) setBuyList(res.participant_ids);
    });
    return () => { cancelled = true; };
  }, [eventId, isSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Actions ────────────────────────────────────────────────────────────────

  const saveBuyList = async (ids: number[]) => {
    const previous = buyList;
    setBuyList(ids);
    try {
      const clerkToken = await getToken({ template: 'komikone' });
      if (!clerkToken) throw new Error('Signed out — sign in again to save your list');
      const res = await api.buyList.save(Number(eventId), clerkToken, ids);
      setBuyList(res.participant_ids);
    } catch (e) {
      setBuyList(previous);
      alert(e instanceof Error ? e.message : 'Could not save your buy list');
    }
  };

  const handleClaim = async (p: Participant) => {
    const me = participants.find((x) => x.id === identityId);
    if (!me) { setShowLinkModal(true); return; }
    const myName = `${me.first_name} ${me.last_name}`;
    const active = participants.filter((x) => holdsClaimSlot(x, myName, now)).length;
    if (active >= MAX_ACTIVE_CLAIMS) {
      alert(`You can only claim ${MAX_ACTIVE_CLAIMS} people at a time (Comic-Con purchase limit). Release someone first.`);
      return;
    }
    const blockers = purchaseBlockers(p, event);
    if (blockers.length > 0) {
      alert(`Can't buy for ${p.first_name} yet — ${blockers.map((b) => BLOCKER_LABEL[b].toLowerCase()).join(', ')}.`);
      return;
    }
    if (simulation) {
      setSimPatches((prev) => setSimPatch(prev, p.id, {
        purchasing_claimed_by: myName,
        purchasing_claimed_at: new Date().toISOString(),
      }));
      return;
    }
    try {
      const clerkToken = await getToken({ template: 'komikone' });
      if (!clerkToken) return;
      await api.participants.claim(Number(eventId), p.id, clerkToken, myName);
      await fetchAll();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  /** One tap claims the top of your buy list; whoever someone else grabbed first is reported, not retried. */
  const handleClaimMany = async (picks: Participant[]) => {
    const me = participants.find((x) => x.id === identityId);
    if (!me) { setShowLinkModal(true); return; }
    const myName = `${me.first_name} ${me.last_name}`;
    const room = MAX_ACTIVE_CLAIMS - participants.filter((x) => holdsClaimSlot(x, myName, now)).length;
    const batch = picks.filter((p) => purchaseBlockers(p, event).length === 0).slice(0, Math.max(0, room));
    if (batch.length === 0) return;
    if (simulation) {
      const at = new Date().toISOString();
      setSimPatches((prev) => batch.reduce(
        (acc, p) => setSimPatch(acc, p.id, { purchasing_claimed_by: myName, purchasing_claimed_at: at }),
        prev,
      ));
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    const missed: string[] = [];
    for (const p of batch) {
      try {
        await api.participants.claim(Number(eventId), p.id, clerkToken, myName);
      } catch (e) {
        missed.push(`${p.first_name} ${p.last_name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    await fetchAll();
    if (missed.length > 0) alert(`Couldn't claim everyone:\n${missed.join('\n')}`);
  };

  const handleUnclaim = async (p: Participant) => {
    if (simulation) {
      setSimPatches((prev) => setSimPatch(prev, p.id, {
        purchasing_claimed_by: '',
        purchasing_claimed_at: null,
      }));
      return;
    }
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
    if (!canEditPurchases(p, myDisplayName, now)) {
      alert('Claim this person first before marking purchase days');
      return;
    }
    if (simulation) {
      setSimPatches((prev) => setSimPatch(prev, p.id, {
        [`pur_${day}`]: checked,
        who_purchased: p.who_purchased || myDisplayName,
      }));
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
    if (!canEditPurchases(p, myDisplayName, now)) {
      alert('Claim this person first before editing who bought');
      setEditingRow(null);
      return;
    }
    if (simulation) {
      setSimPatches((prev) => setSimPatch(prev, p.id, { who_purchased: who }));
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
    if (filterStatus !== 'all' && rowStatus(p, now) !== filterStatus) return false;
    if (!filterText) return true;
    const q = filterText.includes('*') ? filterText : `*${filterText}*`;
    const re = wildcardToRegex(q);
    if (!re) return false;
    return re.test(p.first_name) || re.test(p.last_name) || re.test(p.member_id) || re.test(p.purchasing_coordinator);
  });

  const me = participants.find((p) => p.id === identityId) ?? null;
  const myDisplayName = me ? `${me.first_name} ${me.last_name}` : '';
  const myClerkId = user?.id ?? me?.clerk_user_id ?? null;
  // Finished people keep their "who bought" record but stop consuming a slot.
  const myClaimCount = myDisplayName
    ? participants.filter((p) => holdsClaimSlot(p, myDisplayName, now)).length
    : 0;
  const atClaimLimit = myClaimCount >= MAX_ACTIVE_CLAIMS;

  // Default: you + group pinned; during purchasing your active claims rise next (claim order).
  // Manual drag order applies outside purchase/simulation only — purchase toggles don't reshuffle.
  const displayRows = customRowOrder && !showPurchaseChrome
    ? filtered
    : [...filtered].sort((a, b) => {
        const ta = rowSortTier(a, me, identityId, myDisplayName, showPurchaseChrome, now);
        const tb = rowSortTier(b, me, identityId, myDisplayName, showPurchaseChrome, now);
        if (ta !== tb) return ta - tb;

        if (ta === 2) {
          const claimCmp = claimSortKey(a) - claimSortKey(b);
          if (claimCmp !== 0) return claimCmp;
        }

        if (sortCol) {
          const ai = participants.indexOf(a);
          const bi = participants.indexOf(b);
          const av = sortValue(a, sortCol, ai, now);
          const bv = sortValue(b, sortCol, bi, now);
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortDir === 'asc' ? cmp : -cmp;
        }

        return a.sort_order - b.sort_order || a.id - b.id;
      });

  // People you're responsible for who can't be claimed yet — fix before purchase day.
  const blockedInMyGroup = participants
    .filter((p) => !p.all_purchased && canEditIdentityRow(p, me, identityId, myClerkId))
    .map((p) => ({ p, blockers: purchaseBlockers(p, event) }))
    .filter(({ blockers }) => blockers.length > 0);

  const purchased  = participants.filter((p) => p.all_purchased).length;
  const inProgress = participants.filter((p) => hasRequestedDays(p) && !p.all_purchased && isClaimLive(p, now)).length;
  // "left" means buyable right now, so blocked people are counted separately.
  const remaining  = participants.filter((p) => isClaimable(p, event) && !isClaimLive(p, now)).length;
  const withGaps   = participants.filter((p) => p.gaps.length > 0 && p.any_purchased).length;
  const needsSetup = participants.filter((p) => !p.all_purchased && purchaseBlockers(p, event).length > 0).length;

  const [showNextUp, setShowNextUp] = useState(false);

  const byDefaultPriority = (a: Participant, b: Participant) => {
    const diff = priorityScore(b, me, identityId) - priorityScore(a, me, identityId);
    return diff !== 0 ? diff : a.sort_order - b.sort_order;
  };
  const listRank = new Map(buyList.map((id, i) => [id, i]));
  const buyable = participants.filter((p) => isClaimable(p, event) && !isClaimLive(p, now));
  // Your own buy list comes first, in your order; everyone else follows by default priority.
  const priorityQueue = [
    ...buyable.filter((p) => listRank.has(p.id)).sort((a, b) => listRank.get(a.id)! - listRank.get(b.id)!),
    ...buyable.filter((p) => !listRank.has(p.id)).sort(byDefaultPriority),
  ];
  const suggestedOffList = priorityQueue.filter((p) => !listRank.has(p.id));
  const buyListQuickAdd = me
    ? [me, ...participants
        .filter((p) => p.id !== me.id && (
          (me.group_id != null && p.group_id === me.group_id) || canEditIdentityRow(p, me, identityId, myClerkId)
        ))
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)]
    : [];

  const openWhosNext = () => { setShowBuyerQueue(false); setShowNextUp(true); };
  const toggleWhosNext = () => { setShowBuyerQueue(false); setShowNextUp((v) => !v); };
  const toggleBuyerQueue = () => { setShowNextUp(false); setShowBuyerQueue((v) => !v); };

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

  const handleEditSave = async (data: Partial<Participant>, days: DayFlags | null) => {
    if (!editParticipant) return;
    const meRow = participants.find((x) => x.id === identityId) ?? null;
    if (!canEditIdentityRow(editParticipant, meRow, identityId, user?.id)) {
      alert('You can only edit your own profile or your group members');
      setEditParticipant(null);
      return;
    }
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await api.participants.updateProfile(Number(eventId), editParticipant.id, clerkToken, data);
      if (days) await api.participants.updateRequested(Number(eventId), editParticipant.id, clerkToken, days);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
    setEditParticipant(null);
    await fetchAll();
  };

  const refreshBuyerQueue = async (next: PurchaseQueueEntry[]) => {
    applyQueue(next);
    setQueueStale(false);
  };

  const handleQueueJoin = async (label?: string) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.join(Number(eventId), clerkToken, label));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to join queue');
    }
  };

  const handleQueueClearAll = async () => {
    const count = buyerQueue.length;
    const live = event?.status === 'purchasing' && !simulation;
    if (!window.confirm(
      `Clear all ${count} place${count === 1 ? '' : 's'} from the Queue-It line for everyone?`
      + (live ? '\n\nPurchase day is LIVE. Only do this if these are leftover practice places.' : '')
      + '\n\nThis can\'t be undone.',
    )) return;
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await api.admin.purchaseQueue.clear(clerkToken, Number(eventId));
      await refreshBuyerQueue(await api.purchaseQueue.list(Number(eventId), clerkToken));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to clear the line');
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

  const handleQueueRename = async (qid: number, label: string) => {
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      await refreshBuyerQueue(await api.purchaseQueue.rename(Number(eventId), qid, clerkToken, label));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename');
    }
  };

  const handleSoldOut = async (day: SaleDay, soldOut: boolean) => {
    const verb = soldOut ? 'Mark' : 'Un-mark';
    const what = soldOut ? 'SOLD OUT for everyone' : 'available again';
    if (!window.confirm(`${verb} ${SALE_DAY_FULL[day]} as ${what}?`)) return;
    const clerkToken = await getToken({ template: 'komikone' });
    if (!clerkToken) return;
    try {
      setEvent(await api.events.setSoldOut(Number(eventId), clerkToken, day, soldOut));
      void fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update sold-out days');
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
      <div className={`bg-zinc-950 dark:bg-zinc-900 border-b-[5px] px-3 sm:px-4 py-2.5 flex items-center gap-2 sm:gap-3 shrink-0 ${
        simulation ? 'border-fuchsia-500' : 'border-yellow-400 dark:border-yellow-500'
      }`}>
        <Link to="/" className="font-bangers text-yellow-400 text-xl tracking-wide shrink-0 hover:text-yellow-300 transition-colors">komikone</Link>
        <span className="text-zinc-600 dark:text-zinc-500 shrink-0 text-base hidden sm:inline">·</span>
        <div className="flex-1 min-w-0">
          <div className="font-bangers text-white text-lg tracking-wide leading-tight truncate" title={event?.name}>{event?.name}</div>
          <div className={`text-[10px] uppercase tracking-widest leading-tight truncate ${
            simulation ? 'text-fuchsia-400' : 'text-yellow-600 dark:text-yellow-500'
          }`}>
            {event?.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} · Live Board
            {simulation && ' · Simulation'}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <span className="text-zinc-500 dark:text-zinc-400 text-xs hidden sm:block">
            {lastUpdated ? lastUpdated.toLocaleTimeString() : '…'}
          </span>
          <button
            type="button"
            onClick={() => (simulation ? exitSimulation() : setSimulation(true))}
            className={`text-xs font-bold px-2.5 py-0.5 rounded border transition-colors ${
              simulation
                ? 'bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_12px_rgba(217,70,239,0.55)]'
                : 'text-zinc-400 dark:text-zinc-300 border-zinc-700 dark:border-zinc-600 hover:text-fuchsia-300 hover:border-fuchsia-500'
            }`}
            title={simulation ? 'Exit practice mode and discard practice changes' : 'Practice claim & purchase without touching the real roster'}
          >
            {simulation ? 'Sim ON' : 'Simulate'}
          </button>
          <button
            type="button"
            onClick={toggle}
            className="text-zinc-400 dark:text-zinc-300 hover:text-yellow-400 text-xs border border-zinc-700 dark:border-zinc-600 px-2 py-0.5 rounded transition-colors"
            aria-label={isDark ? 'Switch to day mode' : 'Switch to night mode'}
          >
            {isDark ? '☀' : '◑'}<span className="hidden sm:inline">{isDark ? ' Day' : ' Night'}</span>
          </button>
          <HeaderUserMenu
            boardIdentity={me ? {
              displayName: myDisplayName,
              memberId: me.member_id,
              groupName: me.group_name,
              groupColor: me.group_color,
              onChange: () => setShowLinkModal(true),
            } : undefined}
          />
        </div>
      </div>

      {/* On phones this stack can outgrow the screen; cap it so the board always keeps room. */}
      <div className="shrink-0 max-h-[50vh] overflow-y-auto sm:max-h-none sm:overflow-visible">
      {simulation && (
        <div className="bg-fuchsia-600 text-white px-4 py-2 shrink-0 flex items-center gap-3 border-b-2 border-fuchsia-300">
          <span className="text-xs font-black uppercase tracking-[0.2em]">Practice mode</span>
          <span className="text-xs text-fuchsia-100">
            Nothing is saved. Practice claims and purchases stay on your screen — the real roster is untouched.
          </span>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            {hasSimEdits && (
              <button
                type="button"
                onClick={() => setSimPatches({})}
                className="text-xs font-bold underline hover:no-underline"
              >
                Reset practice
              </button>
            )}
            <button
              type="button"
              onClick={exitSimulation}
              className="text-xs font-bold underline hover:no-underline"
            >
              Exit
            </button>
          </div>
        </div>
      )}

      {/* ── Stats bar ── */}
      <div className="bg-black dark:bg-zinc-950 border-b-2 border-zinc-800 dark:border-yellow-950 px-3 sm:px-4 py-1 flex flex-wrap items-center gap-x-4 sm:gap-x-5 gap-y-1 shrink-0">
        <span className="text-green-400 dark:text-green-300 text-xs font-mono">{purchased} <span className="text-zinc-600 dark:text-zinc-500">done</span></span>
        <span className="text-yellow-400 dark:text-yellow-300 text-xs font-mono">{inProgress} <span className="text-zinc-600 dark:text-zinc-500">claiming</span></span>
        {myDisplayName && (
          <span
            className={`text-xs font-mono ${atClaimLimit ? 'text-orange-400 font-bold' : 'text-zinc-400'}`}
            title="Comic-Con lets you buy for at most 3 people at a time"
          >
            {myClaimCount}/{MAX_ACTIVE_CLAIMS} <span className="text-zinc-600 dark:text-zinc-500">yours</span>
          </span>
        )}
        <span className="text-gray-700 dark:text-gray-600 text-xs font-mono">{remaining} <span className="text-zinc-600 dark:text-zinc-500">left</span></span>
        {needsSetup > 0 && (
          <span className="text-amber-400 text-xs font-mono" title="Missing badge days, Member ID, or return eligibility">
            {needsSetup} <span className="text-zinc-600 dark:text-zinc-500">blocked</span>
          </span>
        )}
        {withGaps > 0 && <span className="text-red-400 dark:text-red-700 text-xs font-mono font-bold">{withGaps} gaps</span>}
        <div className="ml-auto flex items-center gap-2">
          {showPurchaseChrome && (
            <button
              type="button"
              onClick={toggleBuyerQueue}
              className={`text-xs font-bold uppercase tracking-wide px-3 py-1 rounded border transition-colors ${
                showBuyerQueue
                  ? 'bg-sky-400 text-black border-sky-200'
                  : 'text-sky-300 border-sky-700 hover:border-sky-400 hover:text-sky-200'
              }`}
            >
              Queue-It line{buyerQueue.length > 0 ? ` · ${activeQueue(buyerQueue).length}` : ''}
            </button>
          )}
          {me && (showPurchaseChrome ? (
            <button
              type="button"
              onClick={toggleWhosNext}
              className={`text-sm font-black uppercase tracking-wide px-4 py-1.5 rounded-md border-2 transition-colors ${
                showNextUp
                  ? 'bg-yellow-300 text-black border-yellow-100 shadow-lg shadow-yellow-400/40'
                  : 'whos-next-flash bg-yellow-400 text-black border-yellow-200 hover:bg-yellow-300'
              }`}
            >
              ⚡ Who&apos;s next?
            </button>
          ) : (
            <button
              type="button"
              onClick={toggleWhosNext}
              className={`text-xs font-bold uppercase tracking-wide px-3 py-1 rounded border transition-colors ${
                showNextUp
                  ? 'bg-yellow-400 text-black border-yellow-200'
                  : 'text-yellow-300 border-yellow-700 hover:border-yellow-400 hover:text-yellow-200'
              }`}
              title="Rank who you want to buy for on purchase day"
            >
              ★ My buy list{buyList.length > 0 ? ` · ${buyList.length}` : ''}
            </button>
          ))}
        </div>
      </div>

      {showPurchaseChrome && (
        <SoldOutBar
          soldOut={soldOutDays(event)}
          // Practice mode promises nothing is saved, and this writes to the real event.
          canEdit={!simulation && (identityId != null || isPlatformAdmin)}
          onToggle={handleSoldOut}
        />
      )}

      {/* ── Group readiness: who can't be bought for yet ── */}
      {blockedInMyGroup.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border-b-2 border-amber-400 dark:border-amber-800 px-4 py-2 shrink-0">
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-amber-800 dark:text-amber-300 text-xs font-bold uppercase tracking-wider shrink-0">
              {blockedInMyGroup.length} can&apos;t be bought for ·
            </span>
            {blockedInMyGroup.map(({ p, blockers }) => (
              <span key={p.id} className="text-xs text-amber-800 dark:text-amber-200">
                <button
                  onClick={() => setEditParticipant(p)}
                  className="font-semibold underline hover:no-underline"
                >
                  {p.first_name} {p.last_name}
                </button>
                <span className="text-amber-700 dark:text-amber-400">
                  {' '}({blockers.map((b) => BLOCKER_LABEL[b].toLowerCase()).join(', ')})
                </span>
              </span>
            ))}
            {blockedInMyGroup.some(({ blockers }) => blockers.includes('days')) && (
              <span className="text-[11px] text-amber-700 dark:text-amber-400 basis-full">
                Badge days are set in the Requested column before purchase day opens.
              </span>
            )}
          </div>
        </div>
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
      </div>

      {/* Board + optional Queue-It side rail */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          {/* ── Filter bar ── */}
          <div className="border-b-2 border-yellow-200 dark:border-gray-300 bg-amber-50 dark:bg-gray-900 px-3 sm:px-4 py-2 flex items-center gap-x-3 gap-y-2 flex-wrap shrink-0">
            <input
              type="search"
              placeholder="Search… (* wildcard)"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1 text-sm text-gray-900 dark:text-gray-50 flex-1 min-w-0 sm:flex-none sm:w-52 focus:outline-none focus:border-yellow-400 dark:focus:border-yellow-400 placeholder:text-gray-400 dark:placeholder:text-gray-500"
            />
            <div className="order-last sm:order-none basis-full sm:basis-auto flex gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-visible -mx-3 px-3 sm:mx-0 sm:px-0">
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
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors shrink-0 whitespace-nowrap ${
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
              daysLocked={simulation || event?.status === 'purchasing'}
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
                      col === 'actions' ? 'px-1' : 'px-3',
                      'py-2 text-left text-xs uppercase tracking-wide select-none align-top',
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
              const status = rowStatus(p, now);
              const naturalIdx = participants.indexOf(p);
              const isFlashing = flash[p.id];
              const isRowDragTarget = rowDragTarget === p.id;
              const evenRow = dispIdx % 2 === 0;
              const isSelf = identityId != null && p.id === identityId;
              const isMyGroup = !isSelf && me?.group_id != null && p.group_id === me.group_id;

              // Frozen cells must be opaque or scrolled columns show through them, so the
              // translucent tints are pre-blended over gray-900 (dark) and white (light).
              const frozenBg = isFlashing
                ? 'bg-blue-100 dark:bg-[#152245]'
                : isSelf
                  ? 'bg-yellow-50 dark:bg-[#251b1a]'
                  : isMyGroup
                    ? 'bg-[#fffcef] dark:bg-[#1e181e]'
                    : evenRow
                      ? 'bg-white dark:bg-gray-900'
                      : 'bg-gray-50 dark:bg-[#192231]';

              const rowBg = isRowDragTarget && !isFlashing
                ? 'bg-blue-100 dark:bg-[#141f3b]'
                : frozenBg;

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
                          col === 'actions' ? 'px-1' : 'px-3',
                          'py-1.5 border-b border-gray-100 dark:border-gray-200/70 align-middle',
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
                            canTogglePurchase={canEditPurchases(p, myDisplayName, now)}
                            atClaimLimit={atClaimLimit}
                            blockers={purchaseBlockers(p, event)}
                            now={now}
                            onClaim={handleClaim}
                            onUnclaim={handleUnclaim}
                            onRequestedToggle={handleRequestedToggle}
                            onPurchaseToggle={handlePurchaseToggle}
                            onWhoChange={handleWhoChange}
                            onEditParticipant={setEditParticipant}
                            buyListRank={listRank.has(p.id) ? listRank.get(p.id)! + 1 : undefined}
                            onAddToBuyList={me && canAddToBuyList(p, event) ? (x) => void saveBuyList([...buyList, x.id]) : undefined}
                            onOpenBuyList={openWhosNext}
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
            moves={queueMoves}
            now={now}
            stale={queueStale}
            myClerkId={user?.id ?? null}
            isAdmin={isPlatformAdmin}
            identityLinked={identityId != null}
            buyFor={priorityQueue.slice(0, MAX_ACTIVE_CLAIMS)}
            onOpenWhosNext={openWhosNext}
            onJoin={handleQueueJoin}
            onLeave={handleQueueLeave}
            onStatus={handleQueueStatus}
            onEta={handleQueueEta}
            onMove={handleQueueMove}
            onRename={handleQueueRename}
            onClearAll={handleQueueClearAll}
            onDismiss={() => setShowBuyerQueue(false)}
          />
        )}

        {showNextUp && me && (
          <BuyListPanel
            event={event}
            participants={participants}
            list={buyList}
            identityId={identityId}
            myDisplayName={myDisplayName}
            quickAdd={buyListQuickAdd}
            suggested={suggestedOffList}
            reasonFor={(p) => priorityReason(p, me, identityId)}
            purchasing={showPurchaseChrome}
            now={now}
            onChange={(ids) => void saveBuyList(ids)}
            onClaimMany={handleClaimMany}
            onRelease={handleUnclaim}
            onDismiss={() => setShowNextUp(false)}
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
  atClaimLimit, blockers, now, onClaim, onUnclaim, onRequestedToggle, onPurchaseToggle, onWhoChange, onEditParticipant,
  buyListRank, onAddToBuyList, onOpenBuyList,
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
  atClaimLimit: boolean;
  blockers: PurchaseBlocker[];
  now: number;
  onClaim: (p: Participant) => void;
  onUnclaim: (p: Participant) => void;
  onRequestedToggle: (p: Participant, day: DayKey, checked: boolean) => void;
  onPurchaseToggle: (p: Participant, day: DayKey, checked: boolean) => void;
  onWhoChange: (p: Participant, who: string) => void;
  onEditParticipant: (p: Participant) => void;
  /** 1-based spot on your buy list; undefined when they're not on it. */
  buyListRank: number | undefined;
  /** Omitted when you can't keep a buy list (no linked identity). */
  onAddToBuyList?: (p: Participant) => void;
  onOpenBuyList: () => void;
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
        <div className="flex items-center justify-center gap-1">
          {buyListRank != null ? (
            <button
              type="button"
              onClick={onOpenBuyList}
              className="w-5 h-5 rounded-full bg-yellow-400 text-black text-[10px] font-black leading-none flex items-center justify-center hover:bg-yellow-300"
              title={`#${buyListRank} on your buy list — open it`}
            >
              {buyListRank}
            </button>
          ) : onAddToBuyList && !p.all_purchased ? (
            <button
              type="button"
              onClick={() => onAddToBuyList(p)}
              className="w-5 h-5 rounded-full border border-yellow-500/70 text-yellow-600 dark:text-yellow-400 text-sm font-bold leading-none flex items-center justify-center hover:bg-yellow-400 hover:text-black"
              title={`Add ${p.first_name} to your buy list`}
              aria-label={`Add ${p.first_name} ${p.last_name} to your buy list`}
            >
              +
            </button>
          ) : (
            <span className="w-5" />
          )}
          {canEditProfile && (
            <button
              onClick={() => onEditParticipant(p)}
              // Always visible on touch, where there is no hover to reveal it with.
              className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-400"
              title="Edit participant"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
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
                    title={isClaimLive(p, now) ? 'Only the claimer can mark purchases' : 'Claim this person first to mark purchases'}
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
            const isSoldOutGap = (p.sold_out_gaps ?? []).some((g) => g.toLowerCase() === day);
            return (
              <div key={day} style={{ width: DAY_SLOT_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div
                  className={`w-4 h-4 rounded-sm border-2 flex items-center justify-center text-[9px] font-black leading-none ${
                    isGap
                      ? 'bg-red-500 border-red-600 dark:bg-red-500 dark:border-red-400'
                      : isSoldOutGap
                        ? 'bg-zinc-300 border-zinc-400 text-zinc-600 dark:bg-zinc-700 dark:border-zinc-500 dark:text-zinc-300'
                        : 'border-gray-200 dark:border-gray-300'
                  }`}
                  title={isSoldOutGap ? 'Wanted, but sold out' : undefined}
                >
                  {isSoldOutGap ? '✕' : null}
                </div>
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
            {(p.sold_out_gaps?.length ?? 0) > 0 && (
              <span className="font-normal text-zinc-500">· {p.sold_out_gaps!.join(', ')} sold out</span>
            )}
          </span>
        );
      }
      if (blockers.length > 0) {
        const reasons = blockers.map((b) => BLOCKER_LABEL[b]).join(' · ');
        return (
          <div className="flex flex-col items-start gap-0.5" title={`Can't buy for this person yet — ${reasons}`}>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/50 border border-amber-400 dark:border-amber-700 px-2 py-0.5 rounded-full">
              ⚠ Setup
            </span>
            <span className="text-[10px] leading-tight text-amber-700 dark:text-amber-400">{BLOCKER_SHORT[blockers[0]]}</span>
            {canEditProfile && (
              <button
                onClick={() => onEditParticipant(p)}
                className="text-[11px] font-bold text-blue-600 dark:text-blue-400 underline hover:no-underline"
              >
                Fix setup
              </button>
            )}
          </div>
        );
      }
      if (eventStatus !== 'purchasing') {
        return <span className="text-gray-400 dark:text-gray-600 text-xs">—</span>;
      }
      if (isClaimLive(p, now)) {
        const remainingMs = claimRemainingMs(p.purchasing_claimed_at, now);
        const urgent = remainingMs <= 30_000;
        const warn = remainingMs <= 120_000;
        const timerCls = urgent
          ? 'text-red-600 dark:text-red-400 font-bold'
          : warn
            ? 'text-orange-600 dark:text-yellow-400 font-semibold'
            : 'text-zinc-500 dark:text-zinc-400';
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-xs font-bold text-orange-600 dark:text-yellow-400">{p.purchasing_claimed_by}</span>
            <span
              className={`font-mono text-[11px] tabular-nums leading-none ${timerCls}`}
              title={`Claim auto-releases after ${CLAIM_TIMEOUT_MINUTES} minutes`}
            >
              {formatClaimCountdown(remainingMs)}
            </span>
            <button onClick={() => onUnclaim(p)} className="text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400 underline">Release</button>
          </div>
        );
      }
      return (
        <button
          onClick={() => onClaim(p)}
          disabled={atClaimLimit}
          title={atClaimLimit ? `Limit ${MAX_ACTIVE_CLAIMS} claims — release someone first` : undefined}
          className={`text-xs font-bold px-3 py-1 rounded transition-colors border-2 ${
            atClaimLimit
              ? 'bg-gray-300 text-gray-500 border-gray-400 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400 dark:border-zinc-600'
              : 'bg-red-600 hover:bg-red-700 text-white border-black dark:bg-yellow-500 dark:hover:bg-yellow-400 dark:text-yellow-950 dark:border-transparent'
          }`}
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
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl w-full max-w-sm max-h-[90vh] overflow-y-auto shadow-2xl">
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
  participant, daysLocked, onSave, onClose,
}: {
  participant: Participant;
  daysLocked: boolean;
  onSave: (data: Partial<Participant>, days: DayFlags | null) => Promise<void>;
  onClose: () => void;
}) {
  const initialDays: DayFlags = {
    req_preview: participant.req_preview, req_thu: participant.req_thu, req_fri: participant.req_fri,
    req_sat: participant.req_sat, req_sun: participant.req_sun,
  };
  const [days, setDays] = useState<DayFlags>(initialDays);
  const daysChanged = DAY_KEYS.some((d) => !!days[`req_${d}`] !== !!initialDays[`req_${d}`]);
  const [form, setForm] = useState({
    first_name: participant.first_name,
    last_name: participant.last_name,
    member_id: participant.member_id,
    badge_type: participant.badge_type as 'ADULT' | 'JUNIOR',
    notes: participant.notes,
    return_eligible: participant.return_eligible,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form, daysChanged && !daysLocked ? days : null);
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
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl w-full max-w-sm max-h-[90vh] overflow-y-auto shadow-2xl">
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
          <ToggleSwitch
            checked={form.return_eligible}
            onChange={(v) => setForm((f) => ({ ...f, return_eligible: v }))}
            label="Return eligible"
          />
          <div>
            <label className="text-gray-400 text-xs">Badge Days</label>
            <div className="mt-1.5">
              <DayPicker value={days} onChange={setDays} disabled={daysLocked} />
            </div>
            {daysLocked && (
              <p className="text-gray-500 text-xs mt-1.5">Days are locked while purchasing is underway.</p>
            )}
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

// ─── Who's next ───────────────────────────────────────────────────────────

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
