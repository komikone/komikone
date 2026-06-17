export type Sponsor = {
  id: number;
  name: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

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
  access_token: string;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: number;
  sponsor: string; // legacy text column — use sponsor_name for display
  sponsor_id: number;
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
  pur_preview: number;
  pur_thu: number;
  pur_fri: number;
  pur_sat: number;
  pur_sun: number;
  who_purchased: string;
  paid: number;
  group_id: number | null;
  // Joined from groups table:
  group_name: string | null;
  group_color: string | null;
  // Joined from sponsors table:
  sponsor_name: string | null;
  created_at: string;
  updated_at: string;
};

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

// Claim expires after 10 minutes
export const CLAIM_TIMEOUT_MINUTES = 10;

export function computePurchaseTotal(p: Participant, event: Event): number {
  const tier = p.badge_type === 'ADULT' ? 'adult' : 'junior';
  let total = 0;
  if (p.pur_preview) total += event[`price_preview_${tier}` as keyof Event] as number;
  if (p.pur_thu) total += event[`price_thu_${tier}` as keyof Event] as number;
  if (p.pur_fri) total += event[`price_fri_${tier}` as keyof Event] as number;
  if (p.pur_sat) total += event[`price_sat_${tier}` as keyof Event] as number;
  if (p.pur_sun) total += event[`price_sun_${tier}` as keyof Event] as number;
  return total;
}

export function computeGaps(p: Participant): string[] {
  const gaps: string[] = [];
  if (p.req_preview && !p.pur_preview) gaps.push('Preview');
  if (p.req_thu && !p.pur_thu) gaps.push('Thu');
  if (p.req_fri && !p.pur_fri) gaps.push('Fri');
  if (p.req_sat && !p.pur_sat) gaps.push('Sat');
  if (p.req_sun && !p.pur_sun) gaps.push('Sun');
  return gaps;
}

export function isClaimExpired(claimedAt: string | null): boolean {
  if (!claimedAt) return true;
  const claimed = new Date(claimedAt).getTime();
  const now = Date.now();
  return now - claimed > CLAIM_TIMEOUT_MINUTES * 60 * 1000;
}

export function enrichParticipant(p: Participant, event: Event) {
  const claimActive = p.purchasing_claimed_by && !isClaimExpired(p.purchasing_claimed_at);
  const gaps = computeGaps(p);
  const allPurchased =
    (!p.req_preview || p.pur_preview) &&
    (!p.req_thu || p.pur_thu) &&
    (!p.req_fri || p.pur_fri) &&
    (!p.req_sat || p.pur_sat) &&
    (!p.req_sun || p.pur_sun);
  const anyPurchased = p.pur_preview || p.pur_thu || p.pur_fri || p.pur_sat || p.pur_sun;

  return {
    ...p,
    group_id: p.group_id ?? null,
    group_name: p.group_name ?? null,
    group_color: p.group_color ?? null,
    sponsor_name: p.sponsor_name ?? null,
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
    all_purchased: Boolean(allPurchased),
    any_purchased: Boolean(anyPurchased),
  };
}
