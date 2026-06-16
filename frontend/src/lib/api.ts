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
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error: string }).error ?? res.statusText);
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

export type Participant = {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
  sponsor: string;
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
  // Computed by server
  claim_active: boolean;
  purchase_total: number; // cents
  gaps: string[];
  all_purchased: boolean;
  any_purchased: boolean;
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
    register: (eventId: number, token: string, data: Partial<Participant>) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/register?token=${token}`, {
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
      create: (secret: string, data: Partial<EventDetail>) =>
        req<{ id: number; access_token: string }>('/api/admin/events', {
          method: 'POST',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
      update: (secret: string, id: number, data: Partial<EventDetail>) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'PATCH',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
      delete: (secret: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'DELETE',
          headers: headers(undefined, secret),
        }),
      regenerateToken: (secret: string, id: number) =>
        req<{ access_token: string }>(`/api/admin/events/${id}/token`, {
          method: 'POST',
          headers: headers(undefined, secret),
        }),
      getWithToken: (secret: string, id: number) =>
        req<EventDetail>(`/api/events/${id}`, {
          headers: headers(undefined, secret),
        }),
    },
    participants: {
      add: (secret: string, eventId: number, data: Partial<Participant>) =>
        req<{ id: number }>(`/api/admin/events/${eventId}/participants`, {
          method: 'POST',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
      update: (secret: string, eventId: number, pid: number, data: Partial<Participant>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'PATCH',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
      delete: (secret: string, eventId: number, pid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'DELETE',
          headers: headers(undefined, secret),
        }),
      reorder: (secret: string, eventId: number, order: number[]) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/sort`, {
          method: 'PATCH',
          headers: headers(undefined, secret),
          body: JSON.stringify({ order }),
        }),
      copy: (
        secret: string,
        sourceEventId: number,
        data: { target_event_id: number; reset_purchasing?: boolean; transfer?: boolean; participant_ids?: number[] }
      ) =>
        req<{ ok: boolean; copied: number }>(`/api/admin/events/${sourceEventId}/participants/copy`, {
          method: 'POST',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
    },
    coordinators: {
      add: (secret: string, eventId: number, data: Partial<Coordinator>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators`, {
          method: 'POST',
          headers: headers(undefined, secret),
          body: JSON.stringify(data),
        }),
      delete: (secret: string, eventId: number, cid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators/${cid}`, {
          method: 'DELETE',
          headers: headers(undefined, secret),
        }),
    },
    exportUrl: (id: number, secret: string) =>
      `${BASE}/api/admin/events/${id}/export.csv?token=${encodeURIComponent(secret)}`,
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
