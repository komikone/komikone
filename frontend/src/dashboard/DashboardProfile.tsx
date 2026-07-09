import { useEffect, useState } from 'react';
import { useDashboard } from './DashboardContext';
import { inputCls, labelCls, badgeTypeLabel } from './styles';

export function ToggleSwitch({
  checked, onChange, label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
      <span className="text-sm text-gray-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-gray-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}

export default function DashboardProfile() {
  const { member, saveIdentity } = useDashboard();
  const [form, setForm] = useState(() => ({
    first_name: member?.first_name ?? '',
    last_name: member?.last_name ?? '',
    member_id: member?.member_id ?? '',
    badge_type: member?.badge_type ?? 'ADULT' as 'ADULT' | 'JUNIOR',
    return_eligible: member?.return_eligible ?? false,
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!member) return;
    setForm({
      first_name: member.first_name,
      last_name: member.last_name,
      member_id: member.member_id ?? '',
      badge_type: member.badge_type,
      return_eligible: !!member.return_eligible,
    });
  }, [member]);

  if (!member) {
    return <EmptyState title="Profile" message="Join with an invite to set up your profile." />;
  }

  const set = (k: keyof typeof form, v: unknown) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setErr('First and last name are required');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await saveIdentity(form);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell title="Profile" subtitle="Your badge identity for Comic-Con registration.">
      {err && <p className="text-red-400 text-sm mb-4">{err}</p>}
      {saved && <p className="text-green-400 text-sm mb-4">Saved.</p>}

      <form onSubmit={handleSave} className="max-w-lg space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>First name</label>
            <input
              type="text"
              value={form.first_name}
              onChange={(e) => set('first_name', e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Last name</label>
            <input
              type="text"
              value={form.last_name}
              onChange={(e) => set('last_name', e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Member ID</label>
          <input
            type="text"
            value={form.member_id}
            onChange={(e) => set('member_id', e.target.value)}
            className={inputCls}
            placeholder="Comic-Con member ID"
          />
        </div>

        <div>
          <label className={labelCls}>Badge type</label>
          <select
            value={form.badge_type}
            onChange={(e) => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')}
            className={inputCls}
          >
            <option value="ADULT">{badgeTypeLabel('ADULT')}</option>
            <option value="JUNIOR">{badgeTypeLabel('JUNIOR')}</option>
          </select>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <ToggleSwitch
            checked={form.return_eligible}
            onChange={(v) => set('return_eligible', v)}
            label="Return eligible"
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </PageShell>
  );
}

export function PageShell({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-gray-400 text-sm mt-1 mb-8">{subtitle}</p>}
        {!subtitle && <div className="mb-8" />}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <PageShell title={title}>
      <p className="text-gray-400">{message}</p>
    </PageShell>
  );
}
