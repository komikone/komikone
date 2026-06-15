import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type EventDetail,
  type Participant,
  type Coordinator,
  formatDollars,
  DAY_KEYS,
  dayLabel,
} from '../lib/api';

const STATUS_OPTIONS: EventDetail['status'][] = ['setup', 'registration', 'purchasing', 'payment', 'complete'];

// ─── Auth gate ────────────────────────────────────────────────────────────────

function useAdminSecret(): [string, (s: string) => void, boolean] {
  const [secret, setSecretState] = useState(() => sessionStorage.getItem('admin_secret') ?? '');
  const [verified, setVerified] = useState(false);

  const setSecret = (s: string) => {
    sessionStorage.setItem('admin_secret', s);
    setSecretState(s);
    setVerified(false);
  };

  return [secret, setSecret, verified || Boolean(secret)];
}

export default function Admin() {
  const [secret, setSecret] = useAdminSecret();
  const [inputSecret, setInputSecret] = useState('');
  const [authError, setAuthError] = useState('');
  const [authed, setAuthed] = useState(Boolean(sessionStorage.getItem('admin_secret')));

  const [events, setEvents] = useState<EventDetail[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [coordinators, setCoordinators] = useState<Coordinator[]>([]);
  const [loading, setLoading] = useState(false);

  // Tabs
  const [tab, setTab] = useState<'overview' | 'participants' | 'coordinators' | 'prices'>('overview');

  const selectedEvent = events.find((e) => e.id === selectedEventId) ?? null;

  const loadEvents = useCallback(async () => {
    if (!secret) return;
    setLoading(true);
    try {
      const summaries = await api.events.list();
      const detailed = await Promise.all(
        summaries.map((s) => api.admin.events.getWithToken(secret, s.id))
      );
      setEvents(detailed);
      if (!selectedEventId && detailed.length > 0) setSelectedEventId(detailed[0].id);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [secret, selectedEventId]);

  const loadEventDetail = useCallback(async (id: number) => {
    if (!secret) return;
    const [ps, cs] = await Promise.all([
      api.participants.list(id, undefined),
      api.coordinators.list(id, undefined),
    ]).catch(() =>
      Promise.all([
        api.participants.list(id, selectedEvent?.access_token),
        api.coordinators.list(id, selectedEvent?.access_token),
      ])
    );
    setParticipants(ps);
    setCoordinators(cs);
  }, [secret, selectedEvent?.access_token]);

  useEffect(() => {
    if (authed) loadEvents();
  }, [authed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authed && selectedEventId) loadEventDetail(selectedEventId);
  }, [selectedEventId, authed]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      // Verify by trying to list events with this secret
      await api.events.list();
      setSecret(inputSecret);
      setAuthed(true);
    } catch {
      setAuthError('Invalid secret');
    }
    setSecret(inputSecret);
    setAuthed(true);
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <form onSubmit={handleLogin} className="bg-gray-900 border border-gray-700 rounded-xl p-8 w-80">
          <h1 className="text-xl font-bold mb-6 text-center">KomikOne Admin</h1>
          <label className="block text-sm text-gray-300 mb-1">Admin Secret</label>
          <input
            type="password"
            value={inputSecret}
            onChange={(e) => setInputSecret(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white mb-4 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2 rounded transition-colors"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <Link to="/" className="text-gray-400 hover:text-white text-xs">← Public site</Link>
          <h1 className="font-bold text-white mt-1">Admin</h1>
        </div>

        <div className="px-3 py-3 border-b border-gray-800">
          <div className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Events</div>
          {events.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelectedEventId(e.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-sm mb-0.5 transition-colors ${
                selectedEventId === e.id ? 'bg-blue-700 text-white' : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              {e.name}
              <div className="text-xs text-gray-400">{e.reg_type} / {e.status}</div>
            </button>
          ))}
          <CreateEventButton secret={secret} onCreated={loadEvents} />
        </div>

        {selectedEvent && (
          <div className="px-3 py-3">
            <div className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Views</div>
            {(['overview', 'participants', 'coordinators', 'prices'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm mb-0.5 transition-colors capitalize ${
                  tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {!selectedEvent ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {loading ? 'Loading...' : 'Select or create an event'}
          </div>
        ) : (
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-white">{selectedEvent.name}</h2>
                <p className="text-sm text-gray-400">
                  {selectedEvent.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} — {selectedEvent.status}
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <a
                  href={api.admin.exportUrl(selectedEvent.id, secret)}
                  className="text-sm bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition-colors"
                  download
                >
                  Export CSV
                </a>
                <Link
                  to={`/live/${selectedEvent.id}?token=${selectedEvent.access_token}`}
                  target="_blank"
                  className="text-sm bg-yellow-600 hover:bg-yellow-500 text-white px-3 py-1.5 rounded transition-colors"
                >
                  Live Board ↗
                </Link>
              </div>
            </div>

            {tab === 'overview' && (
              <OverviewTab
                event={selectedEvent}
                secret={secret}
                participants={participants}
                onUpdate={() => { loadEvents(); if (selectedEventId) loadEventDetail(selectedEventId); }}
              />
            )}
            {tab === 'participants' && (
              <ParticipantsTab
                event={selectedEvent}
                secret={secret}
                participants={participants}
                onUpdate={() => selectedEventId && loadEventDetail(selectedEventId)}
              />
            )}
            {tab === 'coordinators' && (
              <CoordinatorsTab
                event={selectedEvent}
                secret={secret}
                coordinators={coordinators}
                onUpdate={() => selectedEventId && loadEventDetail(selectedEventId)}
              />
            )}
            {tab === 'prices' && (
              <PricesTab
                event={selectedEvent}
                secret={secret}
                onUpdate={loadEvents}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Create Event ─────────────────────────────────────────────────────────────

function CreateEventButton({ secret, onCreated }: { secret: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ year: number; name: string; reg_type: 'return' | 'open' }>({
    year: new Date().getFullYear() + 1, name: '', reg_type: 'open',
  });

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    try {
      await api.admin.events.create(secret, { ...form, status: 'setup' });
      setOpen(false);
      onCreated();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left px-2 py-1.5 rounded text-sm text-blue-400 hover:bg-gray-800 mt-1"
      >
        + New event
      </button>
    );
  }

  return (
    <div className="bg-gray-800 rounded p-3 mt-2 space-y-2">
      <input
        type="text"
        placeholder="Event name (e.g. SDCC 2027)"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none"
      />
      <div className="flex gap-2">
        <input
          type="number"
          value={form.year}
          onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))}
          className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none"
        />
        <select
          value={form.reg_type}
          onChange={(e) => setForm((f) => ({ ...f, reg_type: e.target.value as 'return' | 'open' }))}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none"
        >
          <option value="return">Return Reg</option>
          <option value="open">Open Reg</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button onClick={handleCreate} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs py-1 rounded">
          Create
        </button>
        <button onClick={() => setOpen(false)} className="text-gray-400 text-xs hover:text-white">Cancel</button>
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  event,
  secret,
  participants,
  onUpdate,
}: {
  event: EventDetail;
  secret: string;
  participants: Participant[];
  onUpdate: () => void;
}) {
  const [status, setStatus] = useState(event.status);

  const handleStatusChange = async (newStatus: EventDetail['status']) => {
    try {
      await api.admin.events.update(secret, event.id, { status: newStatus });
      setStatus(newStatus);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const complete = participants.filter((p) => p.all_purchased).length;
  const inProgress = participants.filter((p) => !p.all_purchased && p.claim_active).length;
  const remaining = participants.filter((p) => !p.all_purchased && !p.claim_active).length;
  const paid = participants.filter((p) => p.paid).length;

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-3">Event Status</h3>
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors capitalize ${
                status === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Access token */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-2">Access Token</h3>
        <p className="text-gray-400 text-sm mb-3">Share this link with participants:</p>
        <div className="flex gap-2 items-center">
          <code className="bg-gray-800 text-green-400 text-xs px-3 py-2 rounded flex-1 break-all">
            {window.location.origin}/register/{event.id}?token={event.access_token}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(
              `${window.location.origin}/register/${event.id}?token=${event.access_token}`
            )}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded"
          >
            Copy
          </button>
        </div>
        <div className="mt-2 flex gap-2 items-center">
          <code className="bg-gray-800 text-yellow-400 text-xs px-3 py-2 rounded flex-1 break-all">
            {window.location.origin}/live/{event.id}?token={event.access_token}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(
              `${window.location.origin}/live/${event.id}?token=${event.access_token}`
            )}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total', value: participants.length, color: 'text-white' },
          { label: 'Complete', value: complete, color: 'text-green-400' },
          { label: 'In Progress', value: inProgress, color: 'text-yellow-400' },
          { label: 'Remaining', value: remaining, color: 'text-gray-300' },
          { label: 'Paid', value: paid, color: 'text-green-400' },
          { label: 'Unpaid', value: participants.length - paid, color: 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-center">
            <div className={`text-3xl font-bold font-mono ${color}`}>{value}</div>
            <div className="text-gray-400 text-sm">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Participants Tab ─────────────────────────────────────────────────────────

function ParticipantsTab({
  event,
  secret,
  participants,
  onUpdate,
}: {
  event: EventDetail;
  secret: string;
  participants: Participant[];
  onUpdate: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newParticipant, setNewParticipant] = useState<Partial<Participant>>({
    badge_type: 'ADULT',
  });

  const handleDelete = async (p: Participant) => {
    if (!confirm(`Delete ${p.first_name} ${p.last_name}?`)) return;
    try {
      await api.admin.participants.delete(secret, event.id, p.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleAdd = async () => {
    if (!newParticipant.first_name?.trim() || !newParticipant.last_name?.trim()) {
      alert('First and last name required');
      return;
    }
    try {
      await api.admin.participants.add(secret, event.id, newParticipant);
      setNewParticipant({ badge_type: 'ADULT' });
      setAddOpen(false);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleMoveUp = async (_p: Participant, idx: number) => {
    if (idx === 0) return;
    const newOrder = [...participants];
    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
    try {
      await api.admin.participants.reorder(secret, event.id, newOrder.map((x) => x.id));
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleMoveDown = async (_p: Participant, idx: number) => {
    if (idx === participants.length - 1) return;
    const newOrder = [...participants];
    [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
    try {
      await api.admin.participants.reorder(secret, event.id, newOrder.map((x) => x.id));
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-200">{participants.length} participants</h3>
        <button
          onClick={() => setAddOpen(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded"
        >
          + Add participant
        </button>
      </div>

      {/* Add form */}
      {addOpen && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-4">
          <h4 className="font-medium text-gray-200 mb-3">New Participant</h4>
          <ParticipantForm
            value={newParticipant}
            onChange={setNewParticipant}
            coordinatorNames={[]} // TODO: pull from coordinators
          />
          <div className="flex gap-2 mt-3">
            <button onClick={handleAdd} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded">
              Add
            </button>
            <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-white text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="text-gray-400 text-xs border-b border-gray-700">
            <tr>
              <th className="px-2 py-2 text-left w-12">Sort</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Member ID</th>
              <th className="px-2 py-2 text-center">Type</th>
              <th className="px-2 py-2 text-center">Ret.</th>
              <th className="px-2 py-2 text-center">Requested</th>
              <th className="px-2 py-2 text-left">Coordinator</th>
              <th className="px-2 py-2 text-center">Purchased</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-center">Paid</th>
              <th className="px-2 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {participants.map((p, idx) => (
              <tr key={p.id} className={`hover:bg-gray-900/50 ${p.all_purchased ? 'opacity-70' : ''}`}>
                <td className="px-2 py-2">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => handleMoveUp(p, idx)} className="text-gray-500 hover:text-white text-xs leading-none">▲</button>
                    <span className="text-gray-500 text-xs text-center">{idx + 1}</span>
                    <button onClick={() => handleMoveDown(p, idx)} className="text-gray-500 hover:text-white text-xs leading-none">▼</button>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="text-white font-medium">{p.first_name} {p.last_name}</div>
                  {p.sponsor && <div className="text-xs text-gray-500">via {p.sponsor}</div>}
                  {p.notes && <div className="text-xs text-gray-500 italic">{p.notes}</div>}
                </td>
                <td className="px-2 py-2 font-mono text-xs text-gray-300">{p.member_id || '—'}</td>
                <td className="px-2 py-2 text-center text-xs">
                  <span className={p.badge_type === 'JUNIOR' ? 'text-blue-400' : 'text-gray-300'}>
                    {p.badge_type}
                  </span>
                </td>
                <td className="px-2 py-2 text-center">
                  <ReturnToggle p={p} secret={secret} eventId={event.id} onUpdate={onUpdate} />
                </td>
                <td className="px-2 py-2 text-center text-xs text-gray-400">
                  {DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).map((d) => d.slice(0, 2).toUpperCase()).join(' ')}
                </td>
                <td className="px-2 py-2 text-xs text-gray-300">{p.purchasing_coordinator || '—'}</td>
                <td className="px-2 py-2 text-center text-xs">
                  {p.all_purchased ? (
                    <span className="text-green-400">All ✓</span>
                  ) : p.any_purchased ? (
                    <span className="text-yellow-400">
                      {DAY_KEYS.filter((d) => p[`pur_${d}` as keyof Participant]).map((d) => d.slice(0, 2).toUpperCase()).join(' ')}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-xs">
                  {p.purchase_total > 0 ? formatDollars(p.purchase_total) : '—'}
                </td>
                <td className="px-2 py-2 text-center">
                  <span className={`text-xs ${p.paid ? 'text-green-400' : 'text-gray-500'}`}>
                    {p.paid ? '✓' : '—'}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <button
                      onClick={() => setEditingId(p.id)}
                      className="text-xs text-gray-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-gray-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="text-xs text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-gray-700"
                    >
                      Del
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      {editingId !== null && (
        <EditParticipantModal
          participant={participants.find((p) => p.id === editingId)!}
          secret={secret}
          eventId={event.id}
          onSave={() => { setEditingId(null); onUpdate(); }}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function ReturnToggle({
  p, secret, eventId, onUpdate,
}: { p: Participant; secret: string; eventId: number; onUpdate: () => void }) {
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    setLoading(true);
    try {
      await api.admin.participants.update(secret, eventId, p.id, { return_eligible: !p.return_eligible });
      onUpdate();
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`text-xs px-2 py-0.5 rounded ${
        p.return_eligible ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'
      }`}
    >
      {p.return_eligible ? '✓ Ret' : '○'}
    </button>
  );
}

function EditParticipantModal({
  participant, secret, eventId, onSave, onClose,
}: {
  participant: Participant;
  secret: string;
  eventId: number;
  onSave: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Partial<Participant>>(participant);

  const handleSave = async () => {
    try {
      await api.admin.participants.update(secret, eventId, participant.id, form);
      onSave();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-white">Edit Participant</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <ParticipantForm value={form} onChange={setForm} coordinatorNames={[]} showAdminFields />
        <div className="flex gap-2 mt-4">
          <button onClick={handleSave} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded">
            Save
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white px-4">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ParticipantForm({
  value, onChange, coordinatorNames, showAdminFields = false,
}: {
  value: Partial<Participant>;
  onChange: (v: Partial<Participant>) => void;
  coordinatorNames: string[];
  showAdminFields?: boolean;
}) {
  const set = (key: keyof Participant, val: unknown) => onChange({ ...value, [key]: val });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="First Name">
          <input
            type="text"
            value={value.first_name ?? ''}
            onChange={(e) => set('first_name', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Last Name">
          <input
            type="text"
            value={value.last_name ?? ''}
            onChange={(e) => set('last_name', e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Member ID">
          <input
            type="text"
            value={value.member_id ?? ''}
            onChange={(e) => set('member_id', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Badge Type">
          <select
            value={value.badge_type ?? 'ADULT'}
            onChange={(e) => set('badge_type', e.target.value)}
            className={inputCls}
          >
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Junior / Military / Senior</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Sponsor">
          <input
            type="text"
            value={value.sponsor ?? ''}
            onChange={(e) => set('sponsor', e.target.value)}
            className={inputCls}
          />
        </Field>
        {showAdminFields && (
          <Field label="Coordinator">
            <input
              type="text"
              value={value.purchasing_coordinator ?? ''}
              onChange={(e) => set('purchasing_coordinator', e.target.value)}
              list="coord-names"
              className={inputCls}
            />
            <datalist id="coord-names">
              {coordinatorNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Field>
        )}
      </div>

      <Field label="Requested Days">
        <div className="flex flex-wrap gap-3">
          {DAY_KEYS.map((day) => (
            <label key={day} className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-300">
              <input
                type="checkbox"
                checked={Boolean(value[`req_${day}` as keyof Participant])}
                onChange={(e) => set(`req_${day}` as keyof Participant, e.target.checked)}
                className="accent-blue-500"
              />
              {dayLabel(day)}
            </label>
          ))}
        </div>
      </Field>

      {showAdminFields && (
        <>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
              <input
                type="checkbox"
                checked={Boolean(value.return_eligible)}
                onChange={(e) => set('return_eligible', e.target.checked)}
                className="accent-green-500"
              />
              Return Eligible
            </label>
          </div>

          <Field label="Notes">
            <input
              type="text"
              value={value.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
              className={inputCls}
            />
          </Field>
        </>
      )}
    </div>
  );
}

// ─── Coordinators Tab ─────────────────────────────────────────────────────────

function CoordinatorsTab({
  event, secret, coordinators, onUpdate,
}: {
  event: EventDetail;
  secret: string;
  coordinators: Coordinator[];
  onUpdate: () => void;
}) {
  const [newName, setNewName] = useState('');

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await api.admin.coordinators.add(secret, event.id, { name: newName.trim() });
      setNewName('');
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (c: Coordinator) => {
    if (!confirm(`Remove ${c.name}?`)) return;
    try {
      await api.admin.coordinators.delete(secret, event.id, c.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Coordinator name"
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        />
        <button onClick={handleAdd} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded">
          Add
        </button>
      </div>

      <div className="space-y-2">
        {coordinators.map((c) => (
          <div key={c.id} className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between">
            <div>
              <span className="font-medium text-white">{c.name}</span>
              <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-3">
                {c.venmo && <span>Venmo: {c.venmo}</span>}
                {c.zelle && <span>Zelle: {c.zelle}</span>}
                {c.paypal && <span>PayPal: {c.paypal}</span>}
                {c.phone_last4 && <span>Phone: ...{c.phone_last4}</span>}
                {!c.venmo && !c.zelle && !c.paypal && (
                  <span className="text-gray-600 italic">No payment info yet</span>
                )}
              </div>
            </div>
            <button
              onClick={() => handleDelete(c)}
              className="text-gray-500 hover:text-red-400 text-sm ml-4"
            >
              Remove
            </button>
          </div>
        ))}
        {coordinators.length === 0 && (
          <p className="text-gray-500 text-sm">No coordinators added yet.</p>
        )}
      </div>
    </div>
  );
}

// ─── Prices Tab ───────────────────────────────────────────────────────────────

function PricesTab({
  event, secret, onUpdate,
}: {
  event: EventDetail;
  secret: string;
  onUpdate: () => void;
}) {
  const centsToDollars = (c: number) => (c / 100).toFixed(2);
  const dollarsToCents = (d: string) => Math.round(parseFloat(d || '0') * 100);

  const priceFields = [
    { key: 'price_preview_adult', label: 'Preview Night — Adult' },
    { key: 'price_thu_adult', label: 'Thursday — Adult' },
    { key: 'price_fri_adult', label: 'Friday — Adult' },
    { key: 'price_sat_adult', label: 'Saturday — Adult' },
    { key: 'price_sun_adult', label: 'Sunday — Adult' },
    { key: 'price_preview_junior', label: 'Preview Night — Junior' },
    { key: 'price_thu_junior', label: 'Thursday — Junior' },
    { key: 'price_fri_junior', label: 'Friday — Junior' },
    { key: 'price_sat_junior', label: 'Saturday — Junior' },
    { key: 'price_sun_junior', label: 'Sunday — Junior' },
  ] as const;

  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(priceFields.map(({ key }) => [key, centsToDollars(event[key] as number)]))
  );
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const patch = Object.fromEntries(
      priceFields.map(({ key }) => [key, dollarsToCents(values[key])])
    );
    try {
      await api.admin.events.update(secret, event.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="max-w-sm">
      <h3 className="font-semibold text-gray-200 mb-4">Badge Prices</h3>
      <div className="space-y-3">
        {priceFields.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-3">
            <label className="text-sm text-gray-300 flex-1">{label}</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={values[key]}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                className="bg-gray-800 border border-gray-600 rounded pl-7 pr-3 py-1.5 text-white text-sm w-28 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={handleSave}
        className="mt-5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-6 py-2 rounded transition-colors"
      >
        {saved ? 'Saved ✓' : 'Save Prices'}
      </button>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
