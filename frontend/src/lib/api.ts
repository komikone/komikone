const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

function headers(token?: string, adminSecret?: string): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminSecret) h['Authorization'] = `Bearer ${adminSecret}`;
  if (token) h['x-access-token'] = token;
  return h;
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { error?: string }).error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type EventSummary = {
  id: number;
  year: number;
  name: string;
  reg_type: 'return' | 'open';
  status: 'setup' | 'registration' | 'purchasing' | 'payment' | 'complete';
};

export type EventDetail = EventSummary & {
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
  access_token?: string; // only in admin context
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

export type Sponsor = {
  id: number;
  name: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

const SPONSOR_PALETTE = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#84cc16',
];

export function sponsorColor(id: number): string {
  if (id <= 1) return '#9ca3af'; // Unassigned → gray
  return SPONSOR_PALETTE[(id - 2) % SPONSOR_PALETTE.length];
}

export type Participant = {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
  sponsor_id: number;
  sponsor_name: string | null;
  notes: string;
  req_preview: boolean;
  req_thu: boolean;
  req_fri: boolean;
  req_sat: boolean;
  req_sun: boolean;
  sort_order: number;
  purchasing_coordinator: string;
  purchasing_claimed_by: string;
  purchasing_claimed_at: string | null;
  pur_preview: boolean;
  pur_thu: boolean;
  pur_fri: boolean;
  pur_sat: boolean;
  pur_sun: boolean;
  who_purchased: string;
  paid: boolean;
  group_id: number | null;
  group_name: string | null;
  group_color: string | null;
  // Computed by server
  claim_active: boolean;
  purchase_total: number; // cents
  gaps: string[];
  all_purchased: boolean;
  any_purchased: boolean;
  clerk_user_id: string | null;
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

export type Coordinator = {
  id: number;
  event_id: number;
  name: string;
  venmo: string;
  zelle: string;
  paypal: string;
  phone_last4: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const api = {
  sponsors: {
    list: () => req<Sponsor[]>('/api/sponsors'),
  },

  inviteRequests: {
    submit: (data: { email: string; referred_by: string; notes?: string }) =>
      req<{ ok: boolean }>('/api/invite-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  },

  events: {
    list: () => req<EventSummary[]>('/api/events'),
    get: (id: number, token?: string) =>
      req<EventDetail>(`/api/events/${id}${token ? `?token=${token}` : ''}`, {
        headers: headers(token),
      }),
  },

  participants: {
    list: (eventId: number, token?: string) =>
      req<Participant[]>(`/api/events/${eventId}/participants${token ? `?token=${token}` : ''}`, {
        headers: headers(token),
      }),
    getMyIdentity: (eventId: number, token: string, authToken: string) =>
      req<{ linked: boolean; participant?: Participant }>(
        `/api/events/${eventId}/me?token=${token}`,
        { headers: headers(token, authToken) }
      ),
    linkIdentity: (eventId: number, pid: number, token: string, authToken: string) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/participants/${pid}/link-identity?token=${token}`,
        { method: 'POST', headers: headers(token, authToken), body: JSON.stringify({}) }
      ),
    register: (eventId: number, token: string, data: Partial<Participant>) =>
      req<{ ok: boolean; id: number }>(`/api/events/${eventId}/register?token=${token}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(data),
      }),
    claim: (eventId: number, pid: number, token: string, coordinator_name: string) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/claim?token=${token}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ coordinator_name }),
      }),
    unclaim: (eventId: number, pid: number, token: string) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/unclaim?token=${token}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({}),
      }),
    updatePurchased: (
      eventId: number,
      pid: number,
      token: string,
      data: {
        pur_preview?: boolean; pur_thu?: boolean; pur_fri?: boolean;
        pur_sat?: boolean; pur_sun?: boolean; who_purchased?: string;
      }
    ) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/participants/${pid}/purchased?token=${token}`,
        { method: 'PATCH', headers: headers(token), body: JSON.stringify(data) }
      ),
    updateRequested: (
      eventId: number,
      pid: number,
      token: string,
      data: { req_preview?: boolean; req_thu?: boolean; req_fri?: boolean; req_sat?: boolean; req_sun?: boolean }
    ) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/participants/${pid}/requested?token=${token}`,
        { method: 'PATCH', headers: headers(token), body: JSON.stringify(data) }
      ),
    markPaid: (eventId: number, pid: number, token: string, paid: boolean) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/paid?token=${token}`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({ paid }),
      }),
    updateProfile: (
      eventId: number,
      pid: number,
      token: string,
      data: { first_name?: string; last_name?: string; member_id?: string; badge_type?: string; notes?: string }
    ) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/participants/${pid}/profile?token=${token}`,
        { method: 'PATCH', headers: headers(token), body: JSON.stringify(data) }
      ),
  },

  groups: {
    list: (eventId: number, token?: string) =>
      req<Group[]>(`/api/events/${eventId}/groups${token ? `?token=${token}` : ''}`, {
        headers: headers(token),
      }),
  },

  coordinators: {
    list: (eventId: number, token?: string) =>
      req<Coordinator[]>(`/api/events/${eventId}/coordinators${token ? `?token=${token}` : ''}`, {
        headers: headers(token),
      }),
    upsert: (eventId: number, name: string, token: string, data: Partial<Coordinator>) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/coordinators/${encodeURIComponent(name)}?token=${token}`,
        { method: 'PUT', headers: headers(token), body: JSON.stringify(data) }
      ),
  },

  // ─── Admin API ──────────────────────────────────────────────────────────────
  admin: {
    events: {
      create: (authToken: string, data: Partial<EventDetail>) =>
        req<{ id: number; access_token: string }>('/api/admin/events', {
          method: 'POST',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
      update: (authToken: string, id: number, data: Partial<EventDetail>) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'PATCH',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'DELETE',
          headers: headers(undefined, authToken),
        }),
      regenerateToken: (authToken: string, id: number) =>
        req<{ access_token: string }>(`/api/admin/events/${id}/token`, {
          method: 'POST',
          headers: headers(undefined, authToken),
        }),
      getWithToken: (authToken: string, id: number) =>
        req<EventDetail>(`/api/events/${id}`, {
          headers: headers(undefined, authToken),
        }),
    },
    participants: {
      add: (authToken: string, eventId: number, data: Partial<Participant>) =>
        req<{ id: number }>(`/api/admin/events/${eventId}/participants`, {
          method: 'POST',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
      update: (authToken: string, eventId: number, pid: number, data: Partial<Participant>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'PATCH',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, pid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'DELETE',
          headers: headers(undefined, authToken),
        }),
      reorder: (authToken: string, eventId: number, order: number[]) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/sort`, {
          method: 'PATCH',
          headers: headers(undefined, authToken),
          body: JSON.stringify({ order }),
        }),
      copy: (
        authToken: string,
        sourceEventId: number,
        data: { target_event_id: number; reset_purchasing?: boolean; transfer?: boolean; participant_ids?: number[]; carryover?: boolean }
      ) =>
        req<{ ok: boolean; copied: number }>(`/api/admin/events/${sourceEventId}/participants/copy`, {
          method: 'POST',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
    },
    coordinators: {
      add: (authToken: string, eventId: number, data: Partial<Coordinator>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators`, {
          method: 'POST',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, cid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators/${cid}`, {
          method: 'DELETE',
          headers: headers(undefined, authToken),
        }),
    },
    groups: {
      create: (authToken: string, eventId: number, data: { name: string; color?: string }) =>
        req<{ id: number }>(`/api/admin/events/${eventId}/groups`, {
          method: 'POST', headers: headers(undefined, authToken), body: JSON.stringify(data),
        }),
      update: (authToken: string, eventId: number, gid: number, data: { name?: string; color?: string }) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/${gid}`, {
          method: 'PATCH', headers: headers(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, gid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/${gid}`, {
          method: 'DELETE', headers: headers(undefined, authToken),
        }),
      reorder: (authToken: string, eventId: number, order: number[]) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/reorder`, {
          method: 'PATCH', headers: headers(undefined, authToken), body: JSON.stringify({ order }),
        }),
    },
    inviteRequests: {
      list: (authToken: string, status?: 'pending' | 'approved' | 'rejected') =>
        req<InviteRequest[]>(`/api/admin/invite-requests${status ? `?status=${status}` : ''}`, {
          headers: headers(undefined, authToken),
        }),
      update: (authToken: string, id: number, data: { status?: 'pending' | 'approved' | 'rejected'; admin_notes?: string }) =>
        req<{ ok: boolean }>(`/api/admin/invite-requests/${id}`, {
          method: 'PATCH', headers: headers(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/invite-requests/${id}`, {
          method: 'DELETE', headers: headers(undefined, authToken),
        }),
    },
    sponsors: {
      list: (authToken: string) =>
        req<Sponsor[]>('/api/admin/sponsors', { headers: headers(undefined, authToken) }),
      create: (authToken: string, data: { name: string; notes?: string }) =>
        req<{ id: number }>('/api/admin/sponsors', {
          method: 'POST', headers: headers(undefined, authToken), body: JSON.stringify(data),
        }),
      update: (authToken: string, id: number, data: { name?: string; notes?: string }) =>
        req<{ ok: boolean }>(`/api/admin/sponsors/${id}`, {
          method: 'PATCH', headers: headers(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/sponsors/${id}`, {
          method: 'DELETE', headers: headers(undefined, authToken),
        }),
    },
    yearMeta: {
      get: (authToken: string, year: number) =>
        req<YearMeta>(`/api/admin/year-meta/${year}`, {
          headers: headers(undefined, authToken),
        }),
      upsert: (authToken: string, year: number, data: Partial<YearMeta>) =>
        req<{ ok: boolean }>(`/api/admin/year-meta/${year}`, {
          method: 'PUT',
          headers: headers(undefined, authToken),
          body: JSON.stringify(data),
        }),
    },
    initializeYear: (
      authToken: string,
      data: {
        year: number;
        price_preview_adult: number; price_thu_adult: number; price_fri_adult: number;
        price_sat_adult: number; price_sun_adult: number;
        price_preview_junior: number; price_thu_junior: number; price_fri_junior: number;
        price_sat_junior: number; price_sun_junior: number;
      }
    ) =>
      req<{ ok: boolean }>('/api/admin/initialize-year', {
        method: 'POST',
        headers: headers(undefined, authToken),
        body: JSON.stringify(data),
      }),
    exportUrl: (id: number, authToken: string) =>
      `${BASE}/api/admin/events/${id}/export.csv?token=${encodeURIComponent(authToken)}`,
  },
};

export function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function dayLabel(key: string) {
  return { preview: 'Preview Night', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }[key] ?? key;
}

const DAY_KEYS = ['preview', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = typeof DAY_KEYS[number];
export { DAY_KEYS };
