import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { api, type YearMember, type Year, type Participant, type Group, type EventSummary, type Invite } from '../lib/api';

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-gray-400 mb-1';

type GroupView = { group: Group | null; participants: Participant[]; event: EventSummary };

export default function Dashboard() {
  const { getToken } = useAuth();

  const [years, setYears] = useState<Year[]>([]);
  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [member, setMember] = useState<YearMember | null>(null);
  const [groupViews, setGroupViews] = useState<GroupView[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
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
      .then((t) => api.years.list(t))
      .then((ys) => {
        setYears(ys);
        if (ys.length > 0) setSelectedYearId((prev) => prev ?? ys[0].con_year);
      })
      .catch(() => {});
  }, [tok]);

  const loadYear = useCallback(async (conYear: number) => {
    setLoading(true);
    setError('');
    try {
      const t = await tok();
      const yearList = await api.years.list(t);
      setYears(yearList);

      const yearObj = yearList.find((y) => y.con_year === conYear);
      if (!yearObj) {
        setMember(null);
        setGroupViews([]);
        setInvites([]);
        return;
      }

      const [memberRes, events] = await Promise.all([
        api.years.me(yearObj.id, t).catch(() => null),
        api.events.list(),
      ]);

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

  const returnView = groupViews.find(v => v.event.reg_type === 'return');
  const openView = groupViews.find(v => v.event.reg_type === 'open');
  const primaryView = returnView ?? openView;
  const yearObj = years.find((y) => y.con_year === selectedYearId);
  const registrationEvent = (() => {
    if (!member) return null;
    const view = member.return_eligible ? returnView ?? openView : openView ?? returnView;
    return view?.event.status === 'registration' ? view.event : null;
  })();

  const resolveYearId = () => yearObj?.id ?? null;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">← Home</Link>
          {years.length > 1 && (
            <select
              value={selectedYearId ?? ''}
              onChange={e => setSelectedYearId(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-3 py-1.5"
            >
              {years.map(y => <option key={y.con_year} value={y.con_year}>{y.name}</option>)}
            </select>
          )}
        </div>

        {error && <p className="text-red-400 mb-4">{error}</p>}

        {!member ? (
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center">
            <p className="text-gray-400">You are not registered for this year.</p>
            <p className="text-gray-500 text-sm mt-2">Ask for an invite link to join.</p>
          </div>
        ) : (
          <>
            {/* Member header */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-6">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-xl font-bold text-white">
                    {member.first_name} {member.last_name}
                  </h1>
                  <p className="text-gray-400 text-sm mt-0.5">
                    {member.badge_type === 'ADULT' ? 'Adult' : 'Junior / Senior / Military'}
                    {member.return_eligible && <span className="ml-2 text-green-400 text-xs">✓ Return eligible</span>}
                  </p>
                  {member.member_id && (
                    <p className="text-gray-500 text-xs mt-1">Member ID: {member.member_id}</p>
                  )}
                </div>
                {primaryView?.group && (
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: primaryView.group.color }}
                    />
                    <span className="text-sm text-gray-300">{primaryView.group.name}</span>
                  </div>
                )}
              </div>
            </div>

            {registrationEvent && (
              <div className="bg-blue-950/40 border border-blue-800 rounded-xl p-4 mb-6 flex items-center justify-between gap-4">
                <div>
                  <p className="text-white text-sm font-medium">Registration is open</p>
                  <p className="text-gray-400 text-xs mt-0.5">Select which badge days you want for {registrationEvent.name}.</p>
                </div>
                <Link
                  to={`/register/${registrationEvent.id}`}
                  className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors shrink-0"
                >
                  Select days →
                </Link>
              </div>
            )}

            {/* Group members */}
            {primaryView && (
              <section className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-gray-200">
                    {primaryView.group?.name ?? 'Your Group'}
                  </h2>
                  <button
                    onClick={() => setAddOpen(true)}
                    className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                  >
                    + Add person
                  </button>
                </div>

                {addOpen && primaryView && (
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
                  {primaryView.participants.length === 0 && !addOpen ? (
                    <p className="text-gray-500 text-sm p-5 text-center">No one added yet.</p>
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
                        {primaryView.participants.map(p => (
                          editingId === p.id ? (
                            <EditParticipantRow
                              key={p.id}
                              participant={p}
                              isSelf={p.clerk_user_id === member.clerk_user_id}
                              onSave={async (data) => {
                                const t = await tok();
                                const realYearId = resolveYearId();
                                if (!realYearId || !primaryView) return;
                                await api.years.updateParticipant(realYearId, primaryView.event.id, p.id, t, data);
                                setEditingId(null);
                                loadYear(selectedYearId!);
                              }}
                              onCancel={() => setEditingId(null)}
                            />
                          ) : (
                            <tr key={p.id} className="group hover:bg-gray-800/50">
                              <td className="px-4 py-3 text-white font-medium">
                                {p.first_name} {p.last_name}
                                {p.clerk_user_id === member.clerk_user_id && (
                                  <span className="ml-2 text-xs text-gray-500">(you)</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-gray-400">{p.member_id || '—'}</td>
                              <td className="px-4 py-3 text-gray-400 text-xs">
                                {p.badge_type === 'ADULT' ? 'Adult' : 'Jr/Sr/Mil'}
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
                                    onClick={() => setEditingId(p.id)}
                                    className="text-xs text-gray-400 hover:text-white"
                                  >
                                    Edit
                                  </button>
                                  {p.clerk_user_id !== member.clerk_user_id && (
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
                                  )}
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
            <section className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-200">Invite Someone</h2>
              </div>
              <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
                <p className="text-gray-400 text-sm mb-4">
                  Generate an invite link to bring someone into your group.
                </p>
                <div className="flex gap-2 mb-4">
                  <input
                    type="text"
                    value={inviteLabel}
                    onChange={e => setInviteLabel(e.target.value)}
                    placeholder="Name or email (for your reference)"
                    className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                    onKeyDown={e => e.key === 'Enter' && handleCreateInvite()}
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
                    {invites.map(inv => (
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

            {/* Profile link */}
            <div className="flex justify-end">
              <Link
                to="/profile"
                className="text-sm text-gray-500 hover:text-gray-300"
              >
                Manage payment info →
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type ParticipantFormData = {
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
};

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
  const set = (k: keyof ParticipantFormData, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-3">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className={labelCls}>First Name *</label>
          <input type="text" value={form.first_name} onChange={e => set('first_name', e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Last Name *</label>
          <input type="text" value={form.last_name} onChange={e => set('last_name', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Member ID</label>
          <input type="text" value={form.member_id} onChange={e => set('member_id', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Badge Type</label>
          <select value={form.badge_type} onChange={e => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={form.return_eligible}
          onChange={e => set('return_eligible', e.target.checked)}
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
  participant, isSelf: _isSelf, onSave, onCancel,
}: {
  participant: Participant;
  isSelf: boolean;
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
  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  return (
    <tr className="bg-gray-800/50">
      <td colSpan={5} className="px-4 py-3">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input
            type="text"
            value={form.first_name}
            onChange={e => set('first_name', e.target.value)}
            placeholder="First name"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={form.last_name}
            onChange={e => set('last_name', e.target.value)}
            placeholder="Last name"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={form.member_id}
            onChange={e => set('member_id', e.target.value)}
            placeholder="Member ID"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <select
            value={form.badge_type}
            onChange={e => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')}
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
              onChange={e => set('return_eligible', e.target.checked)}
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
