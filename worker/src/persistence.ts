/**
 * Shared persistence helpers for group-linked participants.
 * These keep register / days / family / copy paths from creating orphan rows.
 */

export type DayFlags = {
  req_preview: boolean;
  req_thu: boolean;
  req_fri: boolean;
  req_sat: boolean;
  req_sun: boolean;
};

export type Identity = {
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
};

export function bool01(v: unknown): 0 | 1 {
  return v ? 1 : 0;
}

export function normalizeDays(input: Partial<DayFlags> | Record<string, unknown>): DayFlags {
  return {
    req_preview: !!input.req_preview,
    req_thu: !!input.req_thu,
    req_fri: !!input.req_fri,
    req_sat: !!input.req_sat,
    req_sun: !!input.req_sun,
  };
}

export function daysToSql(days: DayFlags): [number, number, number, number, number] {
  return [
    bool01(days.req_preview),
    bool01(days.req_thu),
    bool01(days.req_fri),
    bool01(days.req_sat),
    bool01(days.req_sun),
  ];
}

/** Priority order for finding the "self" participant row to update. */
export type ParticipantRef = {
  id: number;
  clerk_user_id: string | null;
  member_id: string | null;
  group_id: number | null;
};

export function resolveSelfParticipant(
  rows: ParticipantRef[],
  opts: { clerkUserId: string; memberId?: string; groupId?: number | null },
): ParticipantRef | null {
  const memberId = opts.memberId?.trim().toUpperCase() || '';
  const groupId = opts.groupId ?? null;

  if (groupId != null) {
    const inGroupByClerk = rows.find(
      (r) => r.group_id === groupId && r.clerk_user_id === opts.clerkUserId,
    );
    if (inGroupByClerk) return inGroupByClerk;

    if (memberId) {
      const inGroupByMember = rows.find(
        (r) => r.group_id === groupId && (r.member_id ?? '').toUpperCase() === memberId,
      );
      if (inGroupByMember) return inGroupByMember;
    }
  }

  const byClerk = rows.find((r) => r.clerk_user_id === opts.clerkUserId);
  if (byClerk) return byClerk;

  if (memberId) {
    const byMember = rows.find((r) => (r.member_id ?? '').toUpperCase() === memberId);
    if (byMember) return byMember;
  }

  return null;
}

export function groupDisplayName(identity: {
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const name = [identity.first_name, identity.last_name].filter(Boolean).join(' ').trim();
  return name || 'My Group';
}

/**
 * When copying participants between events, map source group_ids onto target
 * groups that share the same owner (or name fallback).
 */
export function mapGroupIdForCopy(
  sourceGroupId: number | null | undefined,
  sourceGroups: { id: number; owner_clerk_user_id?: string | null; name: string }[],
  targetGroups: { id: number; owner_clerk_user_id?: string | null; name: string }[],
): number | null {
  if (sourceGroupId == null) return null;
  const src = sourceGroups.find((g) => g.id === sourceGroupId);
  if (!src) return null;

  if (src.owner_clerk_user_id) {
    const byOwner = targetGroups.find((g) => g.owner_clerk_user_id === src.owner_clerk_user_id);
    if (byOwner) return byOwner.id;
  }

  const byName = targetGroups.find(
    (g) => g.name.trim().toLowerCase() === src.name.trim().toLowerCase(),
  );
  return byName?.id ?? null;
}

export function assertRegistrationOpen(status: string): string | null {
  if (status !== 'registration') return 'Registration is not open';
  return null;
}

export function assertPurchasingOpen(status: string): string | null {
  if (status !== 'purchasing') return 'Not in purchasing phase';
  return null;
}
