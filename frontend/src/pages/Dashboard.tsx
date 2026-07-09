import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import {
  api, DAY_KEYS, dayLabel,
  type YearMember, type Year, type Participant, type Group,
  type EventSummary, type Invite, type Profile, type DayKey,
} from '../lib/api';

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-gray-400 mb-1';

type GroupView = { group: Group | null; participants: Participant[]; event: EventSummary };

function selectedDays(p: Participant, prefix: 'req' | 'pur'): DayKey[] {
  return DAY_KEYS.filter((d) => p[`${prefix}_${d}` as keyof Participant]);
}

function badgeTypeLabel(t: 'ADULT' | 'JUNIOR') {
  return t === 'ADULT' ? 'Adult' : 'Jr / Sr / Military';
}

export default function Dashboard() {
  const { getToken } = useAuth();

  const [years, setYears] = useState<Year[]>([]);
  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [member, setMember] = useState<YearMember | null>(null);
  const [groupViews, setGroupViews] = useState<GroupView[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [editingProfile, setEditingProfile] = useState(false);
  const [editingDays, setEditingDays] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingFamilyId, setEditingFamilyId] = useState<number | null>(null);
  const [inviteLabel, setInviteLabel] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

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

  const loadYear = useCallback(async (conYear: number) => {
    setLoading(true);
    setError('');
    setEditingProfile(false);
    setEditingDays(false);
    setEditingFamilyId(null);
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
      setLoading(false);
    }
  }, [tok]);

  useEffect(() => {
    if (selectedYearId !== null) loadYear(selectedYearId);
  }, [selectedYearId, loadYear]);

  const handleCreateInvite = async () => {
    if (selectedYearId === null) return;
    setCreatingInvite(true);
    try {
      const t = await tok();
      const yearObj = years.find((y) => y.con_year === selectedYearId);
      if (!yearObj) throw new Error('Year not found');
      const inv = await api.invites.createForYear(yearObj.id, t, inviteLabel || undefined);
      setInvites((prev) => [inv, ...prev]);
      setInviteLabel('');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create invite');
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyInviteLink = (code: string) => {
    const url = `${window.location.origin}/join/${code}`;
    navigator.clipboard.writeText(url);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-gray-400">Loading…</p>
      </div>
    );
  }

  const returnView = groupViews.find((v) => v.event.reg_type === 'return');
  const openView = groupViews.find((v) => v.event.reg_type === 'open');
  const primaryView = (() => {
    if (!member) return returnView ?? openView;
    return member.return_eligible ? returnView ?? openView : openView ?? returnView;
  })();

  const yearObj = years.find((y) => y.con_year === selectedYearId);
  const resolveYearId = () => yearObj?.id ?? null;

  const selfParticipant = primaryView?.participants.find(
    (p) => p.clerk_user_id === member?.clerk_user_id
  );
  const familyParticipants = primaryView?.participants.filter(
    (p) => p.clerk_user_id !== member?.clerk_user_id
  ) ?? [];

  const activeEvent = primaryView?.event;
  const registrationOpen = activeEvent?.status === 'registration';
  const dayPrefix: 'req' | 'pur' =
    activeEvent && ['purchasing', 'payment', 'complete'].includes(activeEvent.status) ? 'pur' : 'req';
  const myDays = selfParticipant ? selectedDays(selfParticipant, dayPrefix) : [];
  const hasPurchasedDays = selfParticipant ? selectedDays(selfParticipant, 'pur').length > 0 : false;

  const saveSelf = async (data: Parameters<typeof api.years.updateParticipant>[4]) => {
    const t = await tok();
    const realYearId = resolveYearId();
    if (!realYearId || !primaryView || !member) throw new Error('Not found');
    if (selfParticipant) {
      await api.years.updateParticipant(realYearId, primaryView.event.id, selfParticipant.id, t, data);
    } else {
      await api.participants.register(primaryView.event.id, t, {
        first_name: member.first_name,
        last_name: member.last_name,
        member_id: member.member_id,
        badge_type: member.badge_type,
        ...data,
      });
    }
    await loadYear(selectedYearId!);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">← Home</Link>
          {years.length > 1 ? (
            <select
              value={selectedYearId ?? ''}
              onChange={(e) => setSelectedYearId(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-3 py-1.5"
            >
              {years.map((y) => <option key={y.con_year} value={y.con_year}>{y.name}</option>)}
            </select>
          ) : yearObj ? (
            <span className="text-gray-400 text-sm">{yearObj.name}</span>
          ) : null}
        </div>

        {error && <p className="text-red-400 mb-4">{error}</p>}

        {!member ? (
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center">
            <p className="text-gray-400">
              {years.length === 0
                ? 'You are not registered for any active year yet.'
                : 'You are not registered for this year.'}
            </p>
            <p className="text-gray-500 text-sm mt-2">Use your invite link to join, or request access from the homepage.</p>
          </div>
        ) : (
          <>
            {activeEvent && (
              <EventStatusLine event={activeEvent} />
            )}

            {/* Profile */}
            <section className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-200">Your profile</h2>
                {!editingProfile && (
                  <button
                    onClick={() => setEditingProfile(true)}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Edit
                  </button>
                )}
              </div>

              {editingProfile ? (
                <ProfileEditForm
                  member={member}
                  profile={profile}
                  onSave={async (identity, payment) => {
                    const t = await tok();
                    if (primaryView) {
                      const realYearId = resolveYearId();
                      if (selfParticipant && realYearId) {
                        await api.years.updateParticipant(
                          realYearId, primaryView.event.id, selfParticipant.id, t, identity
                        );
                      } else {
                        await api.participants.register(primaryView.event.id, t, identity);
                      }
                    }
                    await api.profile.update(t, payment);
                    setEditingProfile(false);
                    await loadYear(selectedYearId!);
                  }}
                  onCancel={() => setEditingProfile(false)}
                />
              ) : (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <ProfileField label="Name" value={`${member.first_name} ${member.last_name}`} />
                  <ProfileField label="Member ID" value={member.member_id || '—'} />
                  <ProfileField label="Badge type" value={badgeTypeLabel(member.badge_type)} />
                  <ProfileField
                    label="Return eligible"
                    value={member.return_eligible ? 'Yes' : 'No'}
                    highlight={member.return_eligible}
                  />
                  {primaryView?.group && (
                    <ProfileField
                      label="Group"
                      value={
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: primaryView.group.color }}
                          />
                          {primaryView.group.name}
                        </span>
                      }
                    />
                  )}
                  <div className="col-span-2 pt-2 border-t border-gray-800 mt-1">
                    <p className="text-xs text-gray-500 mb-2">Payment info</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      <ProfileField label="Venmo" value={profile?.venmo || '—'} />
                      <ProfileField label="PayPal" value={profile?.paypal || '—'} />
                      <ProfileField label="Zelle" value={profile?.zelle || '—'} />
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Badge days */}
            {activeEvent && (
              <section className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="font-semibold text-gray-200">Badge days</h2>
                    <p className="text-gray-500 text-xs mt-0.5">{activeEvent.name}</p>
                  </div>
                  {registrationOpen && !editingDays && (
                    <button
                      onClick={() => setEditingDays(true)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      {myDays.length > 0 ? 'Edit' : 'Select days'}
                    </button>
                  )}
                </div>

                {editingDays ? (
                  <DaysEditForm
                    participant={selfParticipant}
                    onSave={async (days) => {
                      await saveSelf(days);
                      setEditingDays(false);
                    }}
                    onCancel={() => setEditingDays(false)}
                  />
                ) : (
                  <>
                    {myDays.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {myDays.map((d) => (
                          <span
                            key={d}
                            className="px-3 py-1 rounded-full text-sm bg-blue-950 text-blue-200 border border-blue-800"
                          >
                            {dayLabel(d)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm">
                        {registrationOpen
                          ? 'No days selected yet.'
                          : 'No badge days on file.'}
                      </p>
                    )}
                    {!registrationOpen && dayPrefix === 'pur' && !hasPurchasedDays && selfParticipant && selectedDays(selfParticipant, 'req').length > 0 && (
                      <p className="text-gray-500 text-xs mt-2">
                        Requested: {selectedDays(selfParticipant, 'req').map(dayLabel).join(', ')}
                      </p>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Family */}
            {primaryView && (
              <section className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-gray-200">Family & group</h2>
                  <button
                    onClick={() => setAddOpen(true)}
                    className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                  >
                    + Add person
                  </button>
                </div>

                {addOpen && (
                  <AddParticipantForm
                    onSave={async (data) => {
                      const t = await tok();
                      const realYearId = resolveYearId();
                      if (!realYearId) throw new Error('Year not found');
                      await api.years.addParticipant(realYearId, primaryView.event.id, t, data);
                      setAddOpen(false);
                      loadYear(selectedYearId!);
                    }}
                    onCancel={() => setAddOpen(false)}
                  />
                )}

                <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
                  {familyParticipants.length === 0 && !addOpen ? (
                    <p className="text-gray-500 text-sm p-5 text-center">
                      No family members added yet. Use + Add person for anyone without their own account.
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800 text-gray-500 text-xs">
                          <th className="text-left px-4 py-2.5">Name</th>
                          <th className="text-left px-4 py-2.5">Member ID</th>
                          <th className="text-left px-4 py-2.5">Type</th>
                          <th className="text-left px-4 py-2.5">Return</th>
                          <th className="px-4 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {familyParticipants.map((p) => (
                          editingFamilyId === p.id ? (
                            <EditParticipantRow
                              key={p.id}
                              participant={p}
                              onSave={async (data) => {
                                const t = await tok();
                                const realYearId = resolveYearId();
                                if (!realYearId || !primaryView) return;
                                await api.years.updateParticipant(realYearId, primaryView.event.id, p.id, t, data);
                                setEditingFamilyId(null);
                                loadYear(selectedYearId!);
                              }}
                              onCancel={() => setEditingFamilyId(null)}
                            />
                          ) : (
                            <tr key={p.id} className="group hover:bg-gray-800/50">
                              <td className="px-4 py-3 text-white font-medium">
                                {p.first_name} {p.last_name}
                              </td>
                              <td className="px-4 py-3 text-gray-400">{p.member_id || '—'}</td>
                              <td className="px-4 py-3 text-gray-400 text-xs">
                                {badgeTypeLabel(p.badge_type)}
                              </td>
                              <td className="px-4 py-3">
                                {p.return_eligible
                                  ? <span className="text-green-400 text-xs">✓</span>
                                  : <span className="text-gray-600 text-xs">—</span>
                                }
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => setEditingFamilyId(p.id)}
                                    className="text-xs text-gray-400 hover:text-white"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={async () => {
                                      if (!confirm(`Remove ${p.first_name} ${p.last_name}?`)) return;
                                      const t = await tok();
                                      const realYearId = resolveYearId();
                                      if (!realYearId || !primaryView) return;
                                      await api.years.removeParticipant(realYearId, primaryView.event.id, p.id, t);
                                      loadYear(selectedYearId!);
                                    }}
                                    className="text-xs text-red-500 hover:text-red-400"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            )}

            {/* Invites */}
            <section>
              <h2 className="font-semibold text-gray-200 mb-3">Invite someone</h2>
              <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
                <p className="text-gray-400 text-sm mb-4">
                  Generate an invite link for someone who needs their own account.
                </p>
                <div className="flex gap-2 mb-4">
                  <input
                    type="text"
                    value={inviteLabel}
                    onChange={(e) => setInviteLabel(e.target.value)}
                    placeholder="Name or email (for your reference)"
                    className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateInvite()}
                  />
                  <button
                    onClick={handleCreateInvite}
                    disabled={creatingInvite}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
                  >
                    {creatingInvite ? 'Creating…' : 'Generate'}
                  </button>
                </div>

                {invites.length > 0 && (
                  <div className="space-y-2">
                    {invites.map((inv) => (
                      <div key={inv.id} className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2">
                        <div className="flex-1 min-w-0">
                          {inv.label && <p className="text-white text-sm truncate">{inv.label}</p>}
                          <p className="text-gray-500 text-xs font-mono">{inv.code}</p>
                        </div>
                        <button
                          onClick={() => copyInviteLink(inv.code)}
                          className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
                        >
                          {copied === inv.code ? 'Copied!' : 'Copy link'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function EventStatusLine({ event }: { event: EventSummary }) {
  const messages: Record<string, { text: string; link?: { to: string; label: string } }> = {
    registration: { text: 'Registration is open — pick your badge days below.' },
    purchasing: { text: 'Purchase day is live.', link: { to: `/live/${event.id}`, label: 'Open live board →' } },
    payment: { text: 'Settling up after purchase.', link: { to: `/live/${event.id}`, label: 'Open live board →' } },
    complete: { text: 'This event is complete.' },
  };
  const msg = messages[event.status] ?? { text: event.status };

  return (
    <div className="mb-4 px-1 flex items-center justify-between gap-4">
      <p className="text-gray-400 text-sm">{msg.text}</p>
      {msg.link && (
        <Link to={msg.link.to} className="text-sm text-blue-400 hover:text-blue-300 shrink-0">
          {msg.link.label}
        </Link>
      )}
    </div>
  );
}

function ProfileField({
  label, value, highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 ${highlight ? 'text-green-400' : 'text-gray-200'}`}>{value}</p>
    </div>
  );
}

type IdentityFormData = {
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
};

type PaymentFormData = {
  venmo: string;
  paypal: string;
  zelle: string;
};

function ProfileEditForm({
  member, profile, onSave, onCancel,
}: {
  member: YearMember;
  profile: Profile | null;
  onSave: (identity: IdentityFormData, payment: PaymentFormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [identity, setIdentity] = useState<IdentityFormData>({
    first_name: member.first_name,
    last_name: member.last_name,
    member_id: member.member_id ?? '',
    badge_type: member.badge_type,
    return_eligible: member.return_eligible,
  });
  const [payment, setPayment] = useState<PaymentFormData>({
    venmo: profile?.venmo ?? '',
    paypal: profile?.paypal ?? '',
    zelle: profile?.zelle ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const setId = (k: keyof IdentityFormData, v: unknown) =>
    setIdentity((f) => ({ ...f, [k]: v }));
  const setPay = (k: keyof PaymentFormData, v: string) =>
    setPayment((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>First name</label>
          <input type="text" value={identity.first_name} onChange={(e) => setId('first_name', e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Last name</label>
          <input type="text" value={identity.last_name} onChange={(e) => setId('last_name', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Member ID</label>
          <input type="text" value={identity.member_id} onChange={(e) => setId('member_id', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Badge type</label>
          <select value={identity.badge_type} onChange={(e) => setId('badge_type', e.target.value)} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={identity.return_eligible}
          onChange={(e) => setId('return_eligible', e.target.checked)}
          className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-500"
        />
        <span className="text-sm text-gray-300">Return eligible</span>
      </label>

      <div className="pt-3 border-t border-gray-800">
        <p className="text-xs text-gray-500 mb-3">Payment info</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Venmo</label>
            <input type="text" value={payment.venmo} onChange={(e) => setPay('venmo', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>PayPal</label>
            <input type="text" value={payment.paypal} onChange={(e) => setPay('paypal', e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Zelle</label>
            <input type="text" value={payment.zelle} onChange={(e) => setPay('zelle', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      {err && <p className="text-red-400 text-xs">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            if (!identity.first_name.trim() || !identity.last_name.trim()) {
              setErr('Name required');
              return;
            }
            setSaving(true);
            try {
              await onSave(identity, payment);
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Failed to save');
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3">Cancel</button>
      </div>
    </div>
  );
}

function DaysEditForm({
  participant, onSave, onCancel,
}: {
  participant: Participant | undefined;
  onSave: (days: Record<`req_${DayKey}`, boolean>) => Promise<void>;
  onCancel: () => void;
}) {
  const [days, setDays] = useState(() =>
    Object.fromEntries(
      DAY_KEYS.map((d) => [`req_${d}`, participant ? !!participant[`req_${d}` as keyof Participant] : false])
    ) as Record<`req_${DayKey}`, boolean>
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  return (
    <div>
      <div className="space-y-2 mb-4">
        {DAY_KEYS.map((day) => (
          <label key={day} className="flex items-center gap-3 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={days[`req_${day}`]}
              onChange={(e) => setDays((d) => ({ ...d, [`req_${day}`]: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-500"
            />
            <span className="text-gray-300 group-hover:text-white text-sm">{dayLabel(day)}</span>
          </label>
        ))}
      </div>
      {err && <p className="text-red-400 text-xs mb-2">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(days);
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Failed to save');
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded transition-colors"
        >
          {saving ? 'Saving…' : 'Save days'}
        </button>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3">Cancel</button>
      </div>
    </div>
  );
}

type ParticipantFormData = IdentityFormData;

function AddParticipantForm({
  onSave, onCancel,
}: {
  onSave: (data: ParticipantFormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ParticipantFormData>({
    first_name: '', last_name: '', member_id: '', badge_type: 'ADULT', return_eligible: false,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof ParticipantFormData, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-3">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className={labelCls}>First Name *</label>
          <input type="text" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Last Name *</label>
          <input type="text" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Member ID</label>
          <input type="text" value={form.member_id} onChange={(e) => set('member_id', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Badge Type</label>
          <select value={form.badge_type} onChange={(e) => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={form.return_eligible}
          onChange={(e) => set('return_eligible', e.target.checked)}
          className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-500"
        />
        <span className="text-sm text-gray-300">Return eligible</span>
      </label>
      {err && <p className="text-red-400 text-xs mb-2">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            if (!form.first_name.trim() || !form.last_name.trim()) { setErr('Name required'); return; }
            setSaving(true);
            try { await onSave(form); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
            finally { setSaving(false); }
          }}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded transition-colors"
        >
          {saving ? 'Saving…' : 'Add'}
        </button>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3">Cancel</button>
      </div>
    </div>
  );
}

function EditParticipantRow({
  participant, onSave, onCancel,
}: {
  participant: Participant;
  onSave: (data: Partial<ParticipantFormData>) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    first_name: participant.first_name,
    last_name: participant.last_name,
    member_id: participant.member_id,
    badge_type: participant.badge_type,
    return_eligible: participant.return_eligible,
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <tr className="bg-gray-800/50">
      <td colSpan={5} className="px-4 py-3">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input
            type="text"
            value={form.first_name}
            onChange={(e) => set('first_name', e.target.value)}
            placeholder="First name"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={form.last_name}
            onChange={(e) => set('last_name', e.target.value)}
            placeholder="Last name"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={form.member_id}
            onChange={(e) => set('member_id', e.target.value)}
            placeholder="Member ID"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <select
            value={form.badge_type}
            onChange={(e) => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')}
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-300">
            <input
              type="checkbox"
              checked={form.return_eligible}
              onChange={(e) => set('return_eligible', e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-500"
            />
            Return eligible
          </label>
          <button
            onClick={async () => {
              setSaving(true);
              try { await onSave(form); } finally { setSaving(false); }
            }}
            disabled={saving}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onCancel} className="text-xs text-gray-400 hover:text-white">Cancel</button>
        </div>
      </td>
    </tr>
  );
}
