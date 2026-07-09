import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { inputCls, labelCls } from './styles';
import { PageShell } from './DashboardProfile';

export default function DashboardBilling() {
  const { profile, tok, reload } = useDashboard();
  const [form, setForm] = useState({
    venmo: profile?.venmo ?? '',
    paypal: profile?.paypal ?? '',
    zelle: profile?.zelle ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!profile) return;
    setForm({
      venmo: profile.venmo ?? '',
      paypal: profile.paypal ?? '',
      zelle: profile.zelle ?? '',
    });
  }, [profile]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSaved(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const t = await tok();
      await api.profile.update(t, form);
      setSaved(true);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
      <PageShell
      title="Billing"
      subtitle="Payment info used when settling badge costs after purchase day. These handles also prefill the Payment page coordinator form."
    >
      {err && <p className="text-red-400 text-sm mb-4">{err}</p>}
      {saved && <p className="text-green-400 text-sm mb-4">Saved.</p>}

      <form onSubmit={handleSave} className="max-w-lg space-y-4">
        <h2 className="text-sm font-medium text-gray-300 mb-2">Payment info</h2>
        <div>
          <label className={labelCls}>Venmo</label>
          <input type="text" value={form.venmo} onChange={set('venmo')} placeholder="@username" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>PayPal</label>
          <input type="text" value={form.paypal} onChange={set('paypal')} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Zelle</label>
          <input type="text" value={form.zelle} onChange={set('zelle')} className={inputCls} />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Save payment info'}
        </button>
      </form>
    </PageShell>
  );
}
