import type { EventDetail, Participant } from './api';

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
  return isClaimedBy(p, displayName, now) && !p.all_purchased;
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

export function computeGaps(p: Participant): string[] {
  const gaps: string[] = [];
  if (p.req_preview && !p.pur_preview) gaps.push('Preview');
  if (p.req_thu && !p.pur_thu) gaps.push('Thu');
  if (p.req_fri && !p.pur_fri) gaps.push('Fri');
  if (p.req_sat && !p.pur_sat) gaps.push('Sat');
  if (p.req_sun && !p.pur_sun) gaps.push('Sun');
  return gaps;
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
  return total;
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
  return purchaseBlockers(p, event).length === 0 && !p.all_purchased;
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
    gaps: computeGaps(p),
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
