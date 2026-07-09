import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  api, DAY_KEYS,
  type YearMember, type Year, type Participant, type Group,
  type EventSummary, type Invite, type Profile, type DayKey,
} from '../lib/api';

export type GroupView = { group: Group | null; participants: Participant[]; event: EventSummary };

export function selectedDays(p: Participant, prefix: 'req' | 'pur'): DayKey[] {
  return DAY_KEYS.filter((d) => p[`${prefix}_${d}` as keyof Participant]);
}

type DashboardContextValue = {
  loading: boolean;
  error: string;
  years: Year[];
  selectedYearId: number | null;
  setSelectedYearId: (id: number) => void;
  yearObj: Year | undefined;
  member: YearMember | null;
  profile: Profile | null;
  groupViews: GroupView[];
  invites: Invite[];
  primaryView: GroupView | undefined;
  selfParticipant: Participant | undefined;
  familyParticipants: Participant[];
  activeEvent: EventSummary | undefined;
  registrationOpen: boolean;
  reload: () => Promise<void>;
  saveSelf: (data: {
    req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
  }) => Promise<void>;
  saveIdentity: (data: {
    first_name: string; last_name: string; member_id: string;
    badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
  }) => Promise<void>;
  tok: () => Promise<string>;
  resolveYearId: () => number | null;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const [years, setYears] = useState<Year[]>([]);
  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [member, setMember] = useState<YearMember | null>(null);
  const [groupViews, setGroupViews] = useState<GroupView[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const tok = useCallback(async () => {
    const t = await getToken({ template: 'komikone' });
    if (!t) throw new Error('Not signed in');
    return t;
  }, [getToken]);

  useEffect(() => {
    tok()
      .then(async (t) => {
        const ys = await api.years.list(t);
        setYears(ys);
        if (ys.length > 0) {
          setSelectedYearId((prev) =>
            prev && ys.some((y) => y.con_year === prev) ? prev : ys[0].con_year
          );
        } else {
          setSelectedYearId(null);
        }
      })
      .catch(() => {});
  }, [tok]);

  const loadYear = useCallback(async (conYear: number, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError('');
    try {
      const t = await tok();
      const [yearList, events, profileRes] = await Promise.all([
        api.years.list(t),
        api.events.list(),
        api.profile.get(t).catch(() => null),
      ]);
      setYears(yearList);
      setProfile(profileRes);

      const yearObj = yearList.find((y) => y.con_year === conYear);
      if (!yearObj) {
        setMember(null);
        setGroupViews([]);
        setInvites([]);
        return;
      }

      const memberRes = await api.years.me(yearObj.id, t).catch(() => null);
      if (!memberRes) {
        setMember(null);
        setGroupViews([]);
        setInvites([]);
        return;
      }

      setMember(memberRes.member);

      const yearEvents = events.filter((e) => e.year === conYear);
      const views = await Promise.all(
        yearEvents.map(async (e) => {
          const { group, participants } = await api.years.myGroup(yearObj.id, e.id, t);
          return { group, participants, event: e };
        })
      );
      setGroupViews(views);

      const inv = await api.invites.listForYear(yearObj.id, t).catch(() => []);
      setInvites(inv.filter((i) => !i.used_at));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [tok]);

  useEffect(() => {
    if (selectedYearId !== null) loadYear(selectedYearId);
  }, [selectedYearId, loadYear]);

  const yearObj = years.find((y) => y.con_year === selectedYearId);
  const resolveYearId = () => yearObj?.id ?? null;

  const returnView = groupViews.find((v) => v.event.reg_type === 'return');
  const openView = groupViews.find((v) => v.event.reg_type === 'open');
  const primaryView = useMemo(() => {
    if (!member) return returnView ?? openView;
    return member.return_eligible ? returnView ?? openView : openView ?? returnView;
  }, [member, returnView, openView]);

  const selfParticipant = primaryView?.participants.find(
    (p) => p.clerk_user_id === member?.clerk_user_id
      || (member?.member_id && p.member_id && p.member_id.toUpperCase() === member.member_id.toUpperCase())
  );
  const familyParticipants = primaryView?.participants.filter(
    (p) => p.clerk_user_id !== member?.clerk_user_id
  ) ?? [];
  const activeEvent = primaryView?.event;
  const registrationOpen = activeEvent?.status === 'registration';

  const saveSelf = useCallback(async (data: {
    req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
  }) => {
    const t = await tok();
    const realYearId = resolveYearId();
    if (!realYearId || !primaryView || !member) throw new Error('Not found');
    await api.years.updateMyDays(realYearId, primaryView.event.id, t, data);
    if (selectedYearId !== null) await loadYear(selectedYearId, { silent: true });
  }, [tok, primaryView, member, selectedYearId, loadYear, yearObj]);

  const saveIdentity = useCallback(async (data: {
    first_name: string; last_name: string; member_id: string;
    badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
  }) => {
    const t = await tok();
    const realYearId = resolveYearId();
    if (!realYearId || selectedYearId === null) throw new Error('Year not found');
    const { member: updated } = await api.years.updateMe(realYearId, t, data);
    setMember(updated);

    // Refresh group views (return eligibility changes which event is primary)
    const events = await api.events.list();
    const yearEvents = events.filter((e) => e.year === selectedYearId);
    const views = await Promise.all(
      yearEvents.map(async (e) => {
        const { group, participants } = await api.years.myGroup(realYearId, e.id, t);
        return { group, participants, event: e };
      })
    );
    setGroupViews(views);
  }, [tok, selectedYearId, yearObj]);

  const value: DashboardContextValue = {
    loading,
    error,
    years,
    selectedYearId,
    setSelectedYearId,
    yearObj,
    member,
    profile,
    groupViews,
    invites,
    primaryView,
    selfParticipant,
    familyParticipants,
    activeEvent,
    registrationOpen,
    reload: async () => { if (selectedYearId !== null) await loadYear(selectedYearId); },
    saveSelf,
    saveIdentity,
    tok,
    resolveYearId,
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}
