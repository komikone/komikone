import { useState } from 'react';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { inputCls, labelCls } from './styles';
import type { GroupView } from './DashboardContext';
import { MemberId, normalizeMemberIdInput } from '../components/MemberId';
import { ToggleSwitch } from '../components/ToggleSwitch';

type ParticipantFormData = {
  first_name: string;
  last_name: string;
  member_id: string;
  badge_type: 'ADULT' | 'JUNIOR';
  return_eligible: boolean;
};

export function FamilySection({
  view,
  excludeClerkUserId,
}: {
  view: GroupView;
  excludeClerkUserId: string;
}) {
  const { tok, resolveYearId, reload } = useDashboard();
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const family = view.participants.filter((p) => p.clerk_user_id !== excludeClerkUserId);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Family & group</h3>
        <button
          onClick={() => setAddOpen(true)}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          + Add person
        </button>
      </div>

      {addOpen && (
        <AddParticipantForm
          onSave={async (data) => {
            const t = await tok();
            const yearId = resolveYearId();
            if (!yearId) throw new Error('Year not found');
            await api.years.addParticipant(yearId, view.event.id, t, data);
            setAddOpen(false);
            await reload();
          }}
          onCancel={() => setAddOpen(false)}
        />
      )}

      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        {family.length === 0 && !addOpen ? (
          <p className="text-gray-500 text-sm p-4 text-center">
            No family members yet. Add anyone who does not need their own account.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 text-xs bg-gray-50/80 dark:bg-gray-800/80">
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Member ID</th>
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Return</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {family.map((p) =>
                editingId === p.id ? (
                  <EditParticipantRow
                    key={p.id}
                    participant={p}
                    onSave={async (data) => {
                      const t = await tok();
                      const yearId = resolveYearId();
                      if (!yearId) throw new Error('Year not found');
                      await api.years.updateParticipant(yearId, view.event.id, p.id, t, data);
                      setEditingId(null);
                      await reload();
                    }}
                    onCancel={() => setEditingId(null)}
                    onError={(msg) => alert(msg)}
                  />
                ) : (
                  <tr key={p.id} className="group hover:bg-gray-100 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-2.5 text-gray-900 dark:text-white font-medium">
                      {p.first_name} {p.last_name}
                    </td>
                    <td className="px-4 py-2.5">
                      <MemberId
                        value={p.member_id}
                        letterClassName="text-gray-400"
                        digitClassName="text-amber-400"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">
                      {p.badge_type === 'ADULT' ? 'Adult' : 'Jr/Sr/Mil'}
                    </td>
                    <td className="px-4 py-2.5">
                      {p.return_eligible
                        ? <span className="text-green-400 text-xs">✓</span>
                        : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setEditingId(p.id)}
                          className="text-xs text-gray-400 hover:text-gray-900"
                        >
                          Edit
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`Remove ${p.first_name} ${p.last_name}?`)) return;
                            const t = await tok();
                            const yearId = resolveYearId();
                            if (!yearId) return;
                            await api.years.removeParticipant(yearId, view.event.id, p.id, t);
                            await reload();
                          }}
                          className="text-xs text-red-500 hover:text-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

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
    <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-3">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className={labelCls}>First name *</label>
          <input type="text" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Last name *</label>
          <input type="text" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Member ID</label>
          <input
            type="text"
            value={form.member_id}
            onChange={(e) => set('member_id', normalizeMemberIdInput(e.target.value))}
            className={`${inputCls} font-mono uppercase tracking-wide`}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
        <div>
          <label className={labelCls}>Badge type</label>
          <select value={form.badge_type} onChange={(e) => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
      </div>
      <ToggleSwitch
        checked={form.return_eligible}
        onChange={(v) => set('return_eligible', v)}
        label="Return eligible"
        className="mb-3"
      />
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
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
        >
          {saving ? 'Saving…' : 'Add'}
        </button>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-gray-900 px-3">Cancel</button>
      </div>
    </div>
  );
}

function EditParticipantRow({
  participant, onSave, onCancel, onError,
}: {
  participant: { id: number; first_name: string; last_name: string; member_id: string; badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean };
  onSave: (data: Partial<ParticipantFormData>) => Promise<void>;
  onCancel: () => void;
  onError?: (msg: string) => void;
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
    <tr className="bg-gray-100/50">
      <td colSpan={5} className="px-4 py-3">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input type="text" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} placeholder="First name" className={inputCls} />
          <input type="text" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} placeholder="Last name" className={inputCls} />
          <input
            type="text"
            value={form.member_id}
            onChange={(e) => set('member_id', normalizeMemberIdInput(e.target.value))}
            placeholder="Member ID"
            className={`${inputCls} font-mono uppercase tracking-wide`}
            autoCapitalize="characters"
            spellCheck={false}
          />
          <select value={form.badge_type} onChange={(e) => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Jr / Sr / Military</option>
          </select>
        </div>
        <div className="flex items-center gap-4">
          <ToggleSwitch
            checked={form.return_eligible}
            onChange={(v) => set('return_eligible', v)}
            label="Return eligible"
            className="flex-1"
          />
          <button
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(form);
              } catch (e) {
                onError?.(e instanceof Error ? e.message : 'Failed to save');
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-900">Cancel</button>
        </div>
      </td>
    </tr>
  );
}
