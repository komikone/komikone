import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { api, type EventDetail, type Participant, type Coordinator, formatDollars } from '../lib/api';

export default function Payment() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { getToken, isLoaded, isSignedIn } = useAuth();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [coordinators, setCoordinators] = useState<Coordinator[]>([]);
  const [error, setError] = useState('');

  // Coordinator self-entry
  const [myCoordName, setMyCoordName] = useState('');
  const [coordForm, setCoordForm] = useState({ venmo: '', zelle: '', paypal: '', phone_last4: '' });
  const [coordSaved, setCoordSaved] = useState(false);
  const [profilePrefill, setProfilePrefill] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      navigate('/sign-in?redirect=' + encodeURIComponent(window.location.pathname));
      return;
    }
    if (!eventId) return;
    getToken({ template: 'komikone' }).then((tok) => {
      if (!tok) return;
      Promise.all([
        api.events.get(Number(eventId), tok),
        api.participants.list(Number(eventId), tok),
        api.coordinators.list(Number(eventId), tok),
        api.profile.get(tok).catch(() => null),
      ]).then(([ev, ps, cs, profile]) => {
        setEvent(ev);
        setParticipants(ps);
        setCoordinators(cs);
        if (profile && !profilePrefill) {
          setCoordForm((f) => ({
            ...f,
            venmo: f.venmo || profile.venmo || '',
            zelle: f.zelle || profile.zelle || '',
            paypal: f.paypal || profile.paypal || '',
          }));
          setProfilePrefill(true);
        }
      }).catch((e) => setError(e.message));
    });
  }, [isLoaded, isSignedIn, eventId, getToken, navigate, profilePrefill]);

  // Group participants by who_purchased
  const byCoordinator: Record<string, Participant[]> = {};
  for (const p of participants) {
    const coord = p.who_purchased || '(unknown)';
    if (!byCoordinator[coord]) byCoordinator[coord] = [];
    byCoordinator[coord].push(p);
  }

  const coordInfo: Record<string, Coordinator> = {};
  for (const c of coordinators) coordInfo[c.name] = c;

  const handleCoordSave = async () => {
    if (!myCoordName.trim()) return;
    try {
      const tok = await getToken({ template: 'komikone' });
      if (!tok) return;
      await api.coordinators.upsert(Number(eventId), myCoordName, tok, coordForm);
      // Keep dashboard billing profile in sync so handles aren't siloed
      await api.profile.update(tok, {
        venmo: coordForm.venmo,
        zelle: coordForm.zelle,
        paypal: coordForm.paypal,
      }).catch(() => {});
      const cs = await api.coordinators.list(Number(eventId), tok);
      setCoordinators(cs);
      setCoordSaved(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const handleMarkPaid = async (p: Participant) => {
    try {
      const tok = await getToken({ template: 'komikone' });
      if (!tok) return;
      await api.participants.markPaid(Number(eventId), p.id, tok, !p.paid);
      const ps = await api.participants.list(Number(eventId), tok);
      setParticipants(ps);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  if (!isLoaded || (!event && !error)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-gray-500">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  const unpaidTotal = participants
    .filter((p) => !p.paid && p.purchase_total > 0)
    .reduce((sum, p) => sum + p.purchase_total, 0);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">← Home</Link>

        <h1 className="text-2xl font-bold mt-4 mb-1">{event?.name ?? 'Payment'}</h1>
        <p className="text-gray-400 text-sm mb-8">Payment Settlement</p>

        {/* Coordinator self-entry */}
        <section className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-8">
          <h2 className="font-semibold text-gray-200 mb-1">Are you a coordinator?</h2>
          <p className="text-gray-400 text-sm mb-4">
            Enter your payment handles so participants know how to pay you.
          </p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Your Name (as listed in the board)</label>
              <input
                type="text"
                value={myCoordName}
                onChange={(e) => setMyCoordName(e.target.value)}
                placeholder="e.g. Tony"
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Phone last 4 (for Zelle)</label>
              <input
                type="text"
                value={coordForm.phone_last4}
                maxLength={4}
                onChange={(e) => setCoordForm((f) => ({ ...f, phone_last4: e.target.value }))}
                placeholder="1234"
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Venmo handle</label>
              <input
                type="text"
                value={coordForm.venmo}
                onChange={(e) => setCoordForm((f) => ({ ...f, venmo: e.target.value }))}
                placeholder="@handle"
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Zelle (phone or email)</label>
              <input
                type="text"
                value={coordForm.zelle}
                onChange={(e) => setCoordForm((f) => ({ ...f, zelle: e.target.value }))}
                placeholder="phone or email"
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">PayPal (handle or email)</label>
              <input
                type="text"
                value={coordForm.paypal}
                onChange={(e) => setCoordForm((f) => ({ ...f, paypal: e.target.value }))}
                placeholder="@handle"
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <button
            onClick={handleCoordSave}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
          >
            Save Payment Info
          </button>
          {coordSaved && <span className="ml-3 text-green-400 text-sm">Saved!</span>}
        </section>

        {/* Summary */}
        {unpaidTotal > 0 && (
          <div className="bg-red-950/40 border border-red-700 rounded-lg px-4 py-3 mb-6 text-sm">
            <span className="text-red-300 font-medium">Outstanding: </span>
            <span className="text-white font-mono">{formatDollars(unpaidTotal)}</span>
            <span className="text-gray-400 ml-2">total unpaid across all participants</span>
          </div>
        )}

        {/* By coordinator */}
        {Object.entries(byCoordinator)
          .filter(([, ps]) => ps.some((p) => p.purchase_total > 0))
          .map(([name, ps]) => {
            const info = coordInfo[name];
            const total = ps.reduce((s, p) => s + p.purchase_total, 0);
            const unpaid = ps.filter((p) => !p.paid && p.purchase_total > 0).reduce((s, p) => s + p.purchase_total, 0);

            return (
              <div key={name} className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-bold text-white text-lg">{name}</h3>
                    {info && (
                      <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-400">
                        {info.venmo && (
                          <span>Venmo: <span className="text-white">{info.venmo}</span></span>
                        )}
                        {info.zelle && (
                          <span>Zelle: <span className="text-white">{info.zelle}</span></span>
                        )}
                        {info.paypal && (
                          <span>PayPal: <span className="text-white">{info.paypal}</span></span>
                        )}
                        {info.phone_last4 && (
                          <span>Phone: <span className="text-white">...{info.phone_last4}</span></span>
                        )}
                      </div>
                    )}
                    {!info && (
                      <p className="text-yellow-500 text-xs mt-1">
                        Payment info not yet entered — ask {name} to fill out the form above.
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-white font-mono font-semibold">{formatDollars(total)}</div>
                    <div className="text-xs text-gray-400">total paid out</div>
                    {unpaid > 0 && (
                      <div className="text-red-400 text-xs font-mono">{formatDollars(unpaid)} owed</div>
                    )}
                  </div>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs">
                      <th className="text-left py-1">Participant</th>
                      <th className="text-left py-1">Days Purchased</th>
                      <th className="text-right py-1">Amount</th>
                      <th className="text-center py-1">Paid?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {ps.filter((p) => p.purchase_total > 0).map((p) => (
                      <tr key={p.id} className={p.paid ? 'opacity-50' : ''}>
                        <td className="py-2 text-white">
                          {p.first_name} {p.last_name}
                        </td>
                        <td className="py-2 text-gray-400 text-xs">
                          {[
                            p.pur_preview && 'Preview',
                            p.pur_thu && 'Thu',
                            p.pur_fri && 'Fri',
                            p.pur_sat && 'Sat',
                            p.pur_sun && 'Sun',
                          ].filter(Boolean).join(', ')}
                        </td>
                        <td className="py-2 text-right font-mono text-white">
                          {formatDollars(p.purchase_total)}
                        </td>
                        <td className="py-2 text-center">
                          <button
                            onClick={() => handleMarkPaid(p)}
                            className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                              p.paid
                                ? 'bg-green-800 text-green-300 hover:bg-green-700'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                            }`}
                          >
                            {p.paid ? 'Paid ✓' : 'Mark Paid'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}

        {Object.keys(byCoordinator).length === 0 && (
          <div className="text-gray-500 text-center py-12">
            No purchases recorded yet.
          </div>
        )}
      </div>
    </div>
  );
}
