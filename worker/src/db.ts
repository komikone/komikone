export type Group = {
  id: number;
  event_id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type Event = {
  id: number;
  year: number;
  year_id?: number | null;
  name: string;
  reg_type: 'return' | 'open';
  status: 'setup' | 'registration' | 'purchasing' | 'payment' | 'complete';
  price_preview_adult: number;
  price_thu_adult: number;
  price_fri_adult: number;
  price_sat_adult: number;
  price_sun_adult: number;
  price_preview_junior: number;
  price_thu_junior: number;
  price_fri_junior: number;
  price_sat_junior: number;
  price_sun_junior: number;
  sold_out_preview?: number;
  sold_out_thu?: number;
  sold_out_fri?: number;
  sold_out_sat?: number;
  sold_out_sun?: number;
  /** Set on a practice copy: the real event it rehearses. */
  practice_of?: number | null;
  created_at: string;
  updated_at: string;
};

export const SALE_DAYS = ['preview', 'thu', 'fri', 'sat', 'sun'] as const;
export type SaleDay = (typeof SALE_DAYS)[number];

export type Participant = {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  member_id: string;
  email: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: number;
  notes: string;
  req_preview: number;
  req_thu: number;
  req_fri: number;
  req_sat: number;
  req_sun: number;
  sort_order: number;
  purchasing_coordinator: string;
  purchasing_claimed_by: string;
  purchasing_claimed_at: string | null;
  /** Place in the Queue-It line this claim is being bought through. */
  purchasing_claimed_queue_id: number | null;
  pur_preview: number;
  pur_thu: number;
  pur_fri: number;
  pur_sat: number;
  pur_sun: number;
  who_purchased: string;
  paid: number;
  group_id: number | null;
  group_name: string | null;
  group_color: string | null;
  group_owner_clerk_user_id: string | null;
  clerk_user_id: string | null;
  registered_by_clerk_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Profile = {
  clerk_user_id: string;
  display_name: string;
  venmo: string;
  paypal: string;
  zelle: string;
  created_at: string;
  updated_at: string;
};

export type Year = {
  id: number;
  name: string;
  con_year: number;
  owner_clerk_user_id: string;
  created_at: string;
  updated_at: string;
};

export type YearMember = {
  id: number;
  year_id: number;
  clerk_user_id: string;
  role: 'owner' | 'admin' | 'registered';
  sponsor_clerk_user_id: string | null;
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: number;
  joined_at: string;
};

export type Invite = {
  id: number;
  year_id: number;
  code: string;
  label: string;
  invited_by_clerk_user_id: string;
  used_by_clerk_user_id: string | null;
  used_at: string | null;
  invited_email: string | null;
  clerk_invitation_id: string | null;
  /** 1 for a personal invite; more for a shared link. */
  max_uses: number;
  use_count: number;
  created_at: string;
};

export const MAX_SHARED_INVITE_USES = 500;

/** Shown when an invite can't be used any more; a full shared link reads differently. */
export function inviteUnavailableMessage(invite: Pick<Invite, 'max_uses'>): string {
  return invite.max_uses > 1
    ? 'This invite link is full. Ask whoever sent it for a new one.'
    : 'This invite has already been used';
}

export type InviteRequest = {
  id: number;
  email: string;
  referred_by: string;
  notes: string;
  status: 'pending' | 'approved' | 'rejected';
  admin_notes: string;
  created_at: string;
  updated_at: string;
};

export type Coordinator = {
  id: number;
  event_id: number;
  name: string;
  venmo: string;
  zelle: string;
  paypal: string;
  phone_last4: string;
  created_at: string;
  updated_at: string;
};

export type PurchaseQueueStatus =
  | 'waiting'
  | 'on_deck'
  | 'in_queueit'
  | 'buying'
  | 'done'
  | 'skipped';

export type PurchaseQueueEntry = {
  id: number;
  event_id: number;
  participant_id: number;
  clerk_user_id: string;
  position: number;
  status: PurchaseQueueStatus;
  /** Minutes left as last reported from the Queue-It screen; null if not reported. */
  eta_minutes: number | null;
  /** UTC time this place is expected through Queue-It. The sort key, because it counts down. */
  eta_at: string | null;
  /** Owner-chosen name for the browser this place lives in. */
  label: string;
  joined_at: string;
  updated_at: string;
};

export type YearMeta = {
  year: number;
  return_reg_start: string;
  return_reg_end: string;
  open_reg_start: string;
  open_reg_end: string;
  address_deadline: string;
  hotel_deadline: string;
  preview_date: string;
  thu_date: string;
  fri_date: string;
  sat_date: string;
  sun_date: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

export const CLAIM_TIMEOUT_MINUTES = 10;
/** Comic-Con lets you buy badges for at most 3 people per purchase session. */
export const MAX_ACTIVE_CLAIMS = 3;

/**
 * Comic-Con bills this once per member who buys anything, on top of the badge prices.
 * A constant rather than an events column because it is set by Comic-Con, not by us —
 * if they change it, every event changes with it, which is the opposite of how the
 * per-day prices behave.
 */
export const HANDLING_FEE_CENTS = 1500;

export function computePurchaseTotal(p: Participant, event: Event): number {
  const tier = p.badge_type === 'ADULT' ? 'adult' : 'junior';
  let total = 0;
  if (p.pur_preview) total += event[`price_preview_${tier}` as keyof Event] as number;
  if (p.pur_thu) total += event[`price_thu_${tier}` as keyof Event] as number;
  if (p.pur_fri) total += event[`price_fri_${tier}` as keyof Event] as number;
  if (p.pur_sat) total += event[`price_sat_${tier}` as keyof Event] as number;
  if (p.pur_sun) total += event[`price_sun_${tier}` as keyof Event] as number;
  // Keyed off a bought day rather than a non-zero total: an event with prices still
  // unset would otherwise skip the fee and under-report what everyone owes.
  const anyPurchased = p.pur_preview || p.pur_thu || p.pur_fri || p.pur_sat || p.pur_sun;
  if (anyPurchased) total += HANDLING_FEE_CENTS;
  return total;
}

const GAP_LABEL: Record<SaleDay, string> = {
  preview: 'Preview', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

type GapFlags = Pick<Participant,
  'req_preview' | 'req_thu' | 'req_fri' | 'req_sat' | 'req_sun' |
  'pur_preview' | 'pur_thu' | 'pur_fri' | 'pur_sat' | 'pur_sun'
>;
type SoldOutFlags = Partial<Pick<Event,
  'sold_out_preview' | 'sold_out_thu' | 'sold_out_fri' | 'sold_out_sat' | 'sold_out_sun'
>>;

export function isSoldOut(event: SoldOutFlags | null | undefined, day: SaleDay): boolean {
  return !!event?.[`sold_out_${day}`];
}

function unboughtDays(p: GapFlags): SaleDay[] {
  return SALE_DAYS.filter((d) => p[`req_${d}`] && !p[`pur_${d}`]);
}

/** Requested days still worth trying for. A sold-out day is not a gap — nobody can close it. */
export function computeGaps(p: GapFlags, event?: SoldOutFlags | null): string[] {
  return unboughtDays(p).filter((d) => !isSoldOut(event, d)).map((d) => GAP_LABEL[d]);
}

/** Requested days that went unbought because Comic-Con ran out. */
export function computeSoldOutGaps(p: GapFlags, event?: SoldOutFlags | null): string[] {
  return unboughtDays(p).filter((d) => isSoldOut(event, d)).map((d) => GAP_LABEL[d]);
}

/**
 * Nothing left a buyer could do for this person: every requested day is either bought or
 * sold out. This, not computeAllPurchased, is what frees a claim slot — otherwise someone
 * waiting on a sold-out Friday ties up one of the buyer's three slots for good.
 */
export function nothingLeftToBuy(p: GapFlags, event?: SoldOutFlags | null): boolean {
  const anyRequested = SALE_DAYS.some((d) => p[`req_${d}`]);
  return anyRequested && computeGaps(p, event).length === 0;
}

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

export function isClaimExpired(claimedAt: string | null): boolean {
  if (!claimedAt) return true;
  const claimed = parseClaimTimestamp(claimedAt);
  if (claimed == null) return true;
  return Date.now() - claimed > CLAIM_TIMEOUT_MINUTES * 60 * 1000;
}

type PurchaseDayFlags = Pick<Participant,
  'req_preview' | 'req_thu' | 'req_fri' | 'req_sat' | 'req_sun' |
  'pur_preview' | 'pur_thu' | 'pur_fri' | 'pur_sat' | 'pur_sun'
>;

export function anyPurchased(p: Pick<Participant, 'pur_preview' | 'pur_thu' | 'pur_fri' | 'pur_sat' | 'pur_sun'>): boolean {
  return Boolean(p.pur_preview || p.pur_thu || p.pur_fri || p.pur_sat || p.pur_sun);
}

/** Every requested day bought. Vacuous true when nobody requested days — treat as not done. */
export function computeAllPurchased(p: PurchaseDayFlags): boolean {
  const anyRequested = p.req_preview || p.req_thu || p.req_fri || p.req_sat || p.req_sun;
  if (!anyRequested) return false;
  return Boolean(
    (!p.req_preview || p.pur_preview) &&
    (!p.req_thu || p.pur_thu) &&
    (!p.req_fri || p.pur_fri) &&
    (!p.req_sat || p.pur_sat) &&
    (!p.req_sun || p.pur_sun),
  );
}

export function enrichParticipant(p: Participant, event: Event) {
  const claimActive = p.purchasing_claimed_by && !isClaimExpired(p.purchasing_claimed_at);
  const gaps = computeGaps(p, event);
  const soldOutGaps = computeSoldOutGaps(p, event);
  const allPurchased = computeAllPurchased(p);
  const anyPurchased = p.pur_preview || p.pur_thu || p.pur_fri || p.pur_sat || p.pur_sun;

  return {
    ...p,
    group_id: p.group_id ?? null,
    group_name: p.group_name ?? null,
    group_color: p.group_color ?? null,
    group_owner_clerk_user_id: p.group_owner_clerk_user_id ?? null,
    return_eligible: Boolean(p.return_eligible),
    req_preview: Boolean(p.req_preview),
    req_thu: Boolean(p.req_thu),
    req_fri: Boolean(p.req_fri),
    req_sat: Boolean(p.req_sat),
    req_sun: Boolean(p.req_sun),
    pur_preview: Boolean(p.pur_preview),
    pur_thu: Boolean(p.pur_thu),
    pur_fri: Boolean(p.pur_fri),
    pur_sat: Boolean(p.pur_sat),
    pur_sun: Boolean(p.pur_sun),
    paid: Boolean(p.paid),
    claim_active: Boolean(claimActive),
    purchase_total: computePurchaseTotal(p, event),
    gaps,
    sold_out_gaps: soldOutGaps,
    all_purchased: Boolean(allPurchased),
    any_purchased: Boolean(anyPurchased),
  };
}
