import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { api, type EventDetail, DAY_KEYS, dayLabel } from '../lib/api';

export default function Registration() {
  const { eventId } = useParams<{ eventId: string }>();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    member_id: '',
    badge_type: 'ADULT' as 'ADULT' | 'JUNIOR',
    req_preview: false,
    req_thu: false,
    req_fri: false,
    req_sat: false,
    req_sun: false,
  });

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { navigate('/sign-in?redirect=' + encodeURIComponent(window.location.pathname)); return; }
    if (!eventId) return;

    getToken({ template: 'komikone' }).then((tok) => {
      if (!tok) return;
      api.events.get(Number(eventId), tok).then(setEvent).catch((e) => setError(e.message));
    });
  }, [isLoaded, isSignedIn, eventId, getToken, navigate]);

  const setDay = (day: string, val: boolean) =>
    setForm((f) => ({ ...f, [`req_${day}`]: val }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First and last name are required.');
      return;
    }
    try {
      const tok = await getToken({ template: 'komikone' });
      if (!tok) { setError('Authentication error — please sign in again.'); return; }
      await api.participants.register(Number(eventId), tok, form);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    }
  };

  if (!isLoaded || (!event && !error)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-gray-500">Loading…</div>
      </div>
    );
  }

  if (error && !event) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="bg-gray-900 border border-green-600 rounded-xl p-8 max-w-sm text-center">
          <div className="text-green-400 text-4xl mb-4">✓</div>
          <h2 className="text-white text-xl font-bold mb-2">You're registered!</h2>
          <p className="text-gray-400 text-sm mb-6">
            On purchase day, open the live board — you'll be recognized automatically.
          </p>
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">← Back to home</Link>
        </div>
      </div>
    );
  }

  const isReturn = event?.reg_type === 'return';

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-6 py-10">
        <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">← Home</Link>

        <h1 className="text-2xl font-bold text-white mt-4 mb-1">
          {event?.name ?? 'Registration'}
        </h1>
        <p className="text-gray-400 text-sm mb-8">
          {isReturn ? 'Return Member Registration' : 'Open Registration'}
        </p>

        {error && (
          <div className="bg-red-900/40 border border-red-600 rounded p-3 mb-6 text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-300 mb-1">First Name *</label>
              <input
                type="text"
                required
                value={form.first_name}
                onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Last Name *</label>
              <input
                type="text"
                required
                value={form.last_name}
                onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1">
              Comic-Con Member ID
              {isReturn && <span className="text-red-400 ml-1">* (required for return reg)</span>}
            </label>
            <input
              type="text"
              required={isReturn}
              value={form.member_id}
              onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}
              placeholder="e.g. 1234567"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">Badge Type</label>
            <div className="flex gap-4">
              {(['ADULT', 'JUNIOR'] as const).map((type) => (
                <label key={type} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="badge_type"
                    value={type}
                    checked={form.badge_type === type}
                    onChange={() => setForm((f) => ({ ...f, badge_type: type }))}
                    className="accent-blue-500"
                  />
                  <span className="text-gray-300 text-sm">
                    {type === 'JUNIOR' ? 'Junior / Military / Senior' : 'Adult'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">Which days do you want?</label>
            <div className="space-y-2">
              {DAY_KEYS.map((day) => (
                <label key={day} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={form[`req_${day}` as keyof typeof form] as boolean}
                    onChange={(e) => setDay(day, e.target.checked)}
                    className="w-4 h-4 rounded accent-blue-500 cursor-pointer"
                  />
                  <span className="text-gray-300 group-hover:text-white text-sm">{dayLabel(day)}</span>
                </label>
              ))}
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-lg transition-colors"
          >
            Submit Registration
          </button>

          <p className="text-gray-500 text-xs text-center">
            Tony will review your registration and confirm your slot before purchase day.
          </p>
        </form>
      </div>
    </div>
  );
}
