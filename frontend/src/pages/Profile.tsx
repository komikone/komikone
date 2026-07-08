import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { api } from '../lib/api';

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-gray-400 mb-1';

export default function ProfilePage() {
  const { getToken } = useAuth();
  const [form, setForm] = useState({ display_name: '', venmo: '', paypal: '', zelle: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getToken({ template: 'komikone' }).then(async (tok) => {
      if (!tok) return;
      try {
        const p = await api.profile.get(tok);
        setForm({
          display_name: p.display_name ?? '',
          venmo: p.venmo ?? '',
          paypal: p.paypal ?? '',
          zelle: p.zelle ?? '',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    });
  }, [getToken]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const tok = await getToken({ template: 'komikone' });
      if (!tok) throw new Error('Not signed in');
      await api.profile.update(tok, form);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-gray-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-6 py-8">
        <Link to="/dashboard" className="text-gray-500 hover:text-gray-300 text-sm">← Dashboard</Link>
        <h1 className="text-2xl font-bold text-white mt-4 mb-1">Payment Info</h1>
        <p className="text-gray-400 text-sm mb-6">Used when settling badge costs after purchase day.</p>

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        {saved && <p className="text-green-400 text-sm mb-4">Saved.</p>}

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className={labelCls}>Display Name</label>
            <input type="text" value={form.display_name} onChange={set('display_name')} className={inputCls} />
          </div>
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
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  );
}
