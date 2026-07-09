const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

function authHeaders(clerkToken?: string, adminToken?: string): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminToken) h['Authorization'] = `Bearer ${adminToken}`;
  else if (clerkToken) h['Authorization'] = `Bearer ${clerkToken}`;
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
  return_eligible: boolean;
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
  created_at: string;
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

export type Background = {
  id: number;
  url: string;
  label: string;
  sort_order: number;
  active: boolean;
  created_at: string;
};

export type Participant = {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
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
  clerk_user_id: string | null;
  registered_by_clerk_user_id: string | null;
  // Computed by server
  claim_active: boolean;
  purchase_total: number; // cents
  gaps: string[];
  all_purchased: boolean;
  any_purchased: boolean;
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
    get: (id: number, clerkToken: string) =>
      req<EventDetail>(`/api/events/${id}`, { headers: authHeaders(clerkToken) }),
  },

  participants: {
    list: (eventId: number, clerkToken: string) =>
      req<Participant[]>(`/api/events/${eventId}/participants`, { headers: authHeaders(clerkToken) }),
    getMyIdentity: (eventId: number, clerkToken: string) =>
      req<{ linked: boolean; participant?: Participant }>(
        `/api/events/${eventId}/me`,
        { headers: authHeaders(clerkToken) }
      ),
    linkIdentity: (eventId: number, pid: number, clerkToken: string) =>
      req<{ ok: boolean }>(
        `/api/events/${eventId}/participants/${pid}/link-identity`,
        { method: 'POST', headers: authHeaders(clerkToken), body: JSON.stringify({}) }
      ),
    register: (eventId: number, clerkToken: string, data: Partial<Participant>) =>
      req<{ ok: boolean; id: number }>(`/api/events/${eventId}/register`, {
        method: 'POST',
        headers: authHeaders(clerkToken),
        body: JSON.stringify(data),
      }),
    claim: (eventId: number, pid: number, clerkToken: string, coordinator_name: string) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/claim`, {
        method: 'POST',
        headers: authHeaders(clerkToken),
        body: JSON.stringify({ coordinator_name }),
      }),
    unclaim: (eventId: number, pid: number, clerkToken: string) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/unclaim`, {
        method: 'POST',
        headers: authHeaders(clerkToken),
        body: JSON.stringify({}),
      }),
    updatePurchased: (
      eventId: number, pid: number, clerkToken: string,
      data: { pur_preview?: boolean; pur_thu?: boolean; pur_fri?: boolean; pur_sat?: boolean; pur_sun?: boolean; who_purchased?: string }
    ) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/purchased`, {
        method: 'PATCH', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
    updateRequested: (
      eventId: number, pid: number, clerkToken: string,
      data: { req_preview?: boolean; req_thu?: boolean; req_fri?: boolean; req_sat?: boolean; req_sun?: boolean }
    ) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/requested`, {
        method: 'PATCH', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
    markPaid: (eventId: number, pid: number, clerkToken: string, paid: boolean) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/paid`, {
        method: 'PATCH', headers: authHeaders(clerkToken), body: JSON.stringify({ paid }),
      }),
    updateProfile: (
      eventId: number, pid: number, clerkToken: string,
      data: { first_name?: string; last_name?: string; member_id?: string; badge_type?: string; notes?: string }
    ) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/participants/${pid}/profile`, {
        method: 'PATCH', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
  },

  groups: {
    list: (eventId: number, clerkToken: string) =>
      req<Group[]>(`/api/events/${eventId}/groups`, { headers: authHeaders(clerkToken) }),
  },

  coordinators: {
    list: (eventId: number, clerkToken: string) =>
      req<Coordinator[]>(`/api/events/${eventId}/coordinators`, { headers: authHeaders(clerkToken) }),
    upsert: (eventId: number, name: string, clerkToken: string, data: Partial<Coordinator>) =>
      req<{ ok: boolean }>(`/api/events/${eventId}/coordinators/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
  },

  profile: {
    get: (clerkToken: string) =>
      req<Profile>('/api/profile', { headers: authHeaders(clerkToken) }),
    update: (clerkToken: string, data: Partial<Profile>) =>
      req<{ ok: boolean }>('/api/profile', {
        method: 'PUT', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
  },

  backgrounds: {
    list: () => req<{ urls: string[] }>('/api/backgrounds'),
  },

  invites: {
    get: (code: string) =>
      req<{ invite: Pick<Invite, 'code' | 'label' | 'year_id'>; year: Pick<Year, 'id' | 'name' | 'con_year'> }>(
        `/api/invites/${code.toUpperCase()}`
      ),
    accept: (code: string, clerkToken: string, data: {
      first_name: string; last_name: string; member_id: string;
      badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
    }) =>
      req<{ ok: boolean; member: YearMember }>(`/api/invites/${code.toUpperCase()}/accept`, {
        method: 'POST', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
    createForYear: (yearId: number, clerkToken: string, label?: string) =>
      req<Invite>(`/api/years/${yearId}/invites`, {
        method: 'POST', headers: authHeaders(clerkToken), body: JSON.stringify({ label }),
      }),
    listForYear: (yearId: number, clerkToken: string) =>
      req<Invite[]>(`/api/years/${yearId}/invites`, { headers: authHeaders(clerkToken) }),
  },

  years: {
    list: (clerkToken: string) =>
      req<Year[]>('/api/years', { headers: authHeaders(clerkToken) }),
    me: (yearId: number, clerkToken: string) =>
      req<{ member: YearMember }>(`/api/years/${yearId}/me`, { headers: authHeaders(clerkToken) }),
    myGroup: (yearId: number, eventId: number, clerkToken: string) =>
      req<{ group: Group | null; participants: Participant[] }>(
        `/api/years/${yearId}/events/${eventId}/my-group`,
        { headers: authHeaders(clerkToken) }
      ),
    addParticipant: (yearId: number, eventId: number, clerkToken: string, data: {
      first_name: string; last_name: string; member_id?: string;
      badge_type?: 'ADULT' | 'JUNIOR'; return_eligible?: boolean;
    }) =>
      req<Participant>(`/api/years/${yearId}/events/${eventId}/my-group/participants`, {
        method: 'POST', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
    updateParticipant: (yearId: number, eventId: number, pid: number, clerkToken: string, data: Partial<{
      first_name: string; last_name: string; member_id: string;
      badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
      req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
    }>) =>
      req<Participant>(`/api/years/${yearId}/events/${eventId}/my-group/participants/${pid}`, {
        method: 'PATCH', headers: authHeaders(clerkToken), body: JSON.stringify(data),
      }),
    removeParticipant: (yearId: number, eventId: number, pid: number, clerkToken: string) =>
      req<{ ok: boolean }>(`/api/years/${yearId}/events/${eventId}/my-group/participants/${pid}`, {
        method: 'DELETE', headers: authHeaders(clerkToken),
      }),
  },

  // ─── Admin API ──────────────────────────────────────────────────────────────
  admin: {
    events: {
      create: (authToken: string, data: Partial<EventDetail>) =>
        req<{ id: number }>('/api/admin/events', {
          method: 'POST',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
      update: (authToken: string, id: number, data: Partial<EventDetail>) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'PATCH',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${id}`, {
          method: 'DELETE',
          headers: authHeaders(undefined, authToken),
        }),
      getWithToken: (authToken: string, id: number) =>
        req<EventDetail>(`/api/events/${id}`, { headers: authHeaders(undefined, authToken) }),
    },
    participants: {
      add: (authToken: string, eventId: number, data: Partial<Participant>) =>
        req<{ id: number }>(`/api/admin/events/${eventId}/participants`, {
          method: 'POST',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
      update: (authToken: string, eventId: number, pid: number, data: Partial<Participant>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'PATCH',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, pid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/${pid}`, {
          method: 'DELETE',
          headers: authHeaders(undefined, authToken),
        }),
      reorder: (authToken: string, eventId: number, order: number[]) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/participants/sort`, {
          method: 'PATCH',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify({ order }),
        }),
      copy: (
        authToken: string,
        sourceEventId: number,
        data: { target_event_id: number; reset_purchasing?: boolean; transfer?: boolean; participant_ids?: number[]; carryover?: boolean }
      ) =>
        req<{ ok: boolean; copied: number }>(`/api/admin/events/${sourceEventId}/participants/copy`, {
          method: 'POST',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
    },
    coordinators: {
      add: (authToken: string, eventId: number, data: Partial<Coordinator>) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators`, {
          method: 'POST',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, cid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/coordinators/${cid}`, {
          method: 'DELETE',
          headers: authHeaders(undefined, authToken),
        }),
    },
    groups: {
      create: (authToken: string, eventId: number, data: { name: string; color?: string }) =>
        req<{ id: number }>(`/api/admin/events/${eventId}/groups`, {
          method: 'POST', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      update: (authToken: string, eventId: number, gid: number, data: { name?: string; color?: string }) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/${gid}`, {
          method: 'PATCH', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, eventId: number, gid: number) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/${gid}`, {
          method: 'DELETE', headers: authHeaders(undefined, authToken),
        }),
      reorder: (authToken: string, eventId: number, order: number[]) =>
        req<{ ok: boolean }>(`/api/admin/events/${eventId}/groups/reorder`, {
          method: 'PATCH', headers: authHeaders(undefined, authToken), body: JSON.stringify({ order }),
        }),
    },
    years: {
      list: (authToken: string) =>
        req<Year[]>('/api/admin/years', { headers: authHeaders(undefined, authToken) }),
      create: (authToken: string, data: { name?: string; con_year: number }) =>
        req<Year>('/api/admin/years', {
          method: 'POST', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      update: (authToken: string, yearId: number, data: Partial<Pick<Year, 'name' | 'owner_clerk_user_id'>>) =>
        req<{ ok: boolean }>(`/api/admin/years/${yearId}`, {
          method: 'PATCH', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
    },
    invites: {
      list: (authToken: string, yearId: number) =>
        req<Invite[]>(`/api/admin/years/${yearId}/invites`, { headers: authHeaders(undefined, authToken) }),
      create: (authToken: string, yearId: number, label?: string) =>
        req<Invite>(`/api/admin/years/${yearId}/invites`, {
          method: 'POST', headers: authHeaders(undefined, authToken), body: JSON.stringify({ label }),
        }),
      bulkCreate: (authToken: string, yearId: number, data: { count: number; label_prefix?: string }) =>
        req<{ invites: Invite[] }>(`/api/admin/years/${yearId}/invites/bulk`, {
          method: 'POST', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, yearId: number, inviteId: number) =>
        req<{ ok: boolean }>(`/api/admin/years/${yearId}/invites/${inviteId}`, {
          method: 'DELETE', headers: authHeaders(undefined, authToken),
        }),
    },
    members: {
      list: (authToken: string, yearId: number) =>
        req<YearMember[]>(`/api/admin/years/${yearId}/members`, { headers: authHeaders(undefined, authToken) }),
    },
    inviteRequests: {
      list: (authToken: string, status?: 'pending' | 'approved' | 'rejected') =>
        req<InviteRequest[]>(`/api/admin/invite-requests${status ? `?status=${status}` : ''}`, {
          headers: authHeaders(undefined, authToken),
        }),
      update: (authToken: string, id: number, data: { status?: 'pending' | 'approved' | 'rejected'; admin_notes?: string }) =>
        req<{ ok: boolean }>(`/api/admin/invite-requests/${id}`, {
          method: 'PATCH', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/invite-requests/${id}`, {
          method: 'DELETE', headers: authHeaders(undefined, authToken),
        }),
    },
    yearMeta: {
      get: (authToken: string, year: number) =>
        req<YearMeta>(`/api/admin/year-meta/${year}`, { headers: authHeaders(undefined, authToken) }),
      upsert: (authToken: string, year: number, data: Partial<YearMeta>) =>
        req<{ ok: boolean }>(`/api/admin/year-meta/${year}`, {
          method: 'PUT',
          headers: authHeaders(undefined, authToken),
          body: JSON.stringify(data),
        }),
    },
    initializeYear: (authToken: string, data: {
      year: number;
      price_preview_adult: number; price_thu_adult: number; price_fri_adult: number;
      price_sat_adult: number; price_sun_adult: number;
      price_preview_junior: number; price_thu_junior: number; price_fri_junior: number;
      price_sat_junior: number; price_sun_junior: number;
    }) =>
      req<{ ok: boolean }>('/api/admin/initialize-year', {
        method: 'POST',
        headers: authHeaders(undefined, authToken),
        body: JSON.stringify(data),
      }),
    exportUrl: (id: number, authToken: string) =>
      `${BASE}/api/admin/events/${id}/export.csv?token=${encodeURIComponent(authToken)}`,
    backgrounds: {
      list: (authToken: string) =>
        req<Background[]>('/api/admin/backgrounds', { headers: authHeaders(undefined, authToken) }),
      create: (authToken: string, data: { url: string; label?: string }) =>
        req<Background>('/api/admin/backgrounds', {
          method: 'POST', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      update: (authToken: string, id: number, data: Partial<Pick<Background, 'url' | 'label' | 'active' | 'sort_order'>>) =>
        req<Background>(`/api/admin/backgrounds/${id}`, {
          method: 'PATCH', headers: authHeaders(undefined, authToken), body: JSON.stringify(data),
        }),
      delete: (authToken: string, id: number) =>
        req<{ ok: boolean }>(`/api/admin/backgrounds/${id}`, {
          method: 'DELETE', headers: authHeaders(undefined, authToken),
        }),
    },
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
