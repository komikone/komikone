import type { EventDetail, Participant, SaleDay } from './api';

/** Comic-Con lets you buy badges for at most 3 people per purchase session. */
export const MAX_ACTIVE_CLAIMS = 3;
/** Soft claim lock — matches worker CLAIM_TIMEOUT_MINUTES. */
export const CLAIM_TIMEOUT_MINUTES = 10;
export const CLAIM_TIMEOUT_MS = CLAIM_TIMEOUT_MINUTES * 60 * 1000;

/** D1 `datetime('now')` is UTC without a timezone suffix — parse as UTC. */
export function parseClaimTimestamp(claimedAt: string): number | null {
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(claimedAt)
    ? claimedAt
    : claimedAt.includes('T')
      ? `${claimedAt}Z`
      : `${claimedAt.replace(' ', 'T')}Z`;
  const t = new Date(normalized).getTime();
  return Number.isNaN(t) ? null : t;
}

export function claimRemainingMs(claimedAt: string | null, now = Date.now()): number {
  if (!claimedAt) return 0;
  const start = parseClaimTimestamp(claimedAt);
  if (start == null) return 0;
  return Math.max(0, start + CLAIM_TIMEOUT_MS - now);
}

export function formatClaimCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Someone holds this row right now (claim not expired). */
export function isClaimLive(p: Participant, now = Date.now()): boolean {
  if (!p.purchasing_claimed_by?.trim()) return false;
  if (p.purchasing_claimed_at) return claimRemainingMs(p.purchasing_claimed_at, now) > 0;
  return !!p.claim_active;
}

export function isClaimedBy(p: Participant, displayName: string, now = Date.now()): boolean {
  if (!isClaimLive(p, now)) return false;
  if (!displayName.trim()) return false;
  return p.purchasing_claimed_by.trim().toLowerCase() === displayName.trim().toLowerCase();
}

/**
 * A claim only ties up one of your 3 Comic-Con slots while there is still
 * something left to buy. Finishing someone frees the slot without releasing.
 */
export function holdsClaimSlot(p: Participant, displayName: string, now = Date.now()): boolean {
  return isClaimedBy(p, displayName, now) && !nothingLeftToBuy(p);
}

/**
 * Every requested day is bought or sold out, read from the server-derived fields. Mirrors
 * worker nothingLeftToBuy, which is what frees a claim slot there.
 */
export function nothingLeftToBuy(p: Participant): boolean {
  return p.all_purchased || (p.gaps.length === 0 && (p.sold_out_gaps?.length ?? 0) > 0);
}

/** You bought for this person, so you can still correct days after the claim ends. */
export function purchasedByMe(p: Participant, displayName: string): boolean {
  if (!displayName.trim()) return false;
  return p.who_purchased.trim().toLowerCase() === displayName.trim().toLowerCase();
}

export function hasRequestedDays(p: Participant): boolean {
  return !!(p.req_preview || p.req_thu || p.req_fri || p.req_sat || p.req_sun);
}

// ─── Derived fields (mirrors worker enrichParticipant) ────────────────────────

export const SALE_DAYS: SaleDay[] = ['preview', 'thu', 'fri', 'sat', 'sun'];

export const SALE_DAY_LABEL: Record<SaleDay, string> = {
  preview: 'Preview', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

export const SALE_DAY_FULL: Record<SaleDay, string> = {
  preview: 'Preview Night', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

export function isSoldOut(event: EventDetail | null | undefined, day: SaleDay): boolean {
  return !!event?.[`sold_out_${day}`];
}

export function soldOutDays(event: EventDetail | null | undefined): SaleDay[] {
  return SALE_DAYS.filter((d) => isSoldOut(event, d));
}

function unboughtDays(p: Participant): SaleDay[] {
  return SALE_DAYS.filter((d) => p[`req_${d}`] && !p[`pur_${d}`]);
}

/** Mirrors worker computeGaps: a sold-out day is not a gap, because nobody can close it. */
export function computeGaps(p: Participant, event?: EventDetail | null): string[] {
  return unboughtDays(p).filter((d) => !isSoldOut(event, d)).map((d) => SALE_DAY_LABEL[d]);
}

export function computeSoldOutGaps(p: Participant, event?: EventDetail | null): string[] {
  return unboughtDays(p).filter((d) => isSoldOut(event, d)).map((d) => SALE_DAY_LABEL[d]);
}

export function computeAllPurchased(p: Participant): boolean {
  if (!hasRequestedDays(p)) return false;
  return (!p.req_preview || p.pur_preview)
    && (!p.req_thu || p.pur_thu)
    && (!p.req_fri || p.pur_fri)
    && (!p.req_sat || p.pur_sat)
    && (!p.req_sun || p.pur_sun);
}

export function computeAnyPurchased(p: Participant): boolean {
  return !!(p.pur_preview || p.pur_thu || p.pur_fri || p.pur_sat || p.pur_sun);
}

/** Mirrors HANDLING_FEE_CENTS in worker/src/db.ts — Comic-Con charges it once per member. */
export const HANDLING_FEE_CENTS = 1500;

export function computePurchaseTotal(p: Participant, event: EventDetail | null): number {
  if (!event) return 0;
  const tier = p.badge_type === 'ADULT' ? 'adult' : 'junior';
  const price = (day: string) => Number(event[`price_${day}_${tier}` as keyof EventDetail] ?? 0);
  let total = 0;
  if (p.pur_preview) total += price('preview');
  if (p.pur_thu) total += price('thu');
  if (p.pur_fri) total += price('fri');
  if (p.pur_sat) total += price('sat');
  if (p.pur_sun) total += price('sun');
  if (computeAnyPurchased(p)) total += HANDLING_FEE_CENTS;
  return total;
}

/**
 * Comic-Con only sells Preview Night alongside all four main days. Mirrors
 * previewRequiresAllDays in worker/src/db.ts so the picker can block it before the
 * server has to.
 */
export function previewRequiresAllDays(d: {
  req_preview?: boolean; req_thu?: boolean; req_fri?: boolean;
  req_sat?: boolean; req_sun?: boolean;
}): boolean {
  if (!d.req_preview) return true;
  return Boolean(d.req_thu && d.req_fri && d.req_sat && d.req_sun);
}

// ─── Purchase readiness ──────────────────────────────────────────────────────

export type PurchaseBlocker = 'days' | 'member_id' | 'return_eligible';

export const BLOCKER_LABEL: Record<PurchaseBlocker, string> = {
  days: 'No badge days requested',
  member_id: 'No Member ID',
  return_eligible: 'Not return eligible',
};

/** Why this person cannot be bought for yet. Empty means claimable. */
export function purchaseBlockers(p: Participant, event: EventDetail | null): PurchaseBlocker[] {
  const blockers: PurchaseBlocker[] = [];
  if (!hasRequestedDays(p)) blockers.push('days');
  if (!p.member_id.trim()) blockers.push('member_id');
  if (event?.reg_type === 'return' && !p.return_eligible) blockers.push('return_eligible');
  return blockers;
}

export function isClaimable(p: Participant, event: EventDetail | null): boolean {
  return purchaseBlockers(p, event).length === 0 && computeGaps(p, event).length > 0;
}

// ─── Simulation sandbox ──────────────────────────────────────────────────────

/**
 * Practice-mode edits. Held in the browser only — Simulate never writes to the
 * event roster, so exiting practice restores the real board exactly.
 */
export type SimPatch = Partial<Pick<Participant,
  | 'purchasing_claimed_by'
  | 'purchasing_claimed_at'
  | 'pur_preview'
  | 'pur_thu'
  | 'pur_fri'
  | 'pur_sat'
  | 'pur_sun'
  | 'who_purchased'
>>;

export type SimPatches = Record<number, SimPatch>;

/** Recompute the fields the server normally derives, after a local edit. */
export function reDerive(p: Participant, event: EventDetail | null, now = Date.now()): Participant {
  const withDerived: Participant = {
    ...p,
    gaps: computeGaps(p, event),
    sold_out_gaps: computeSoldOutGaps(p, event),
    all_purchased: computeAllPurchased(p),
    any_purchased: computeAnyPurchased(p),
    purchase_total: computePurchaseTotal(p, event),
    claim_active: false,
  };
  withDerived.claim_active = isClaimLive(withDerived, now);
  return withDerived;
}

export function applySimPatches(
  participants: Participant[],
  patches: SimPatches,
  event: EventDetail | null,
  now = Date.now(),
): Participant[] {
  if (Object.keys(patches).length === 0) return participants;
  return participants.map((p) => {
    const patch = patches[p.id];
    if (!patch) return p;
    return reDerive({ ...p, ...patch }, event, now);
  });
}

export function setSimPatch(patches: SimPatches, id: number, patch: SimPatch): SimPatches {
  return { ...patches, [id]: { ...patches[id], ...patch } };
}
