import { useState } from 'react';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { PageShell, EmptyState } from './DashboardProfile';

export default function DashboardInvitations() {
  const { member, invites, selectedYearId, tok, resolveYearId, reload } = useDashboard();
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'ok' | 'warn'; text: string } | null>(null);

  if (!member) {
    return <EmptyState title="Invitations" message="Join with an invite before generating new ones." />;
  }

  const handleCreate = async () => {
    if (selectedYearId === null) return;
    setCreating(true);
    setStatus(null);
    try {
      const t = await tok();
      const yearId = resolveYearId();
      if (!yearId) throw new Error('Year not found');

      const payload: { label?: string; email?: string } = {};
      if (label.trim()) payload.label = label.trim();
      if (email.trim()) payload.email = email.trim().toLowerCase();

      const res = await api.invites.createForYear(yearId, t, payload);
      setLabel('');
      setEmail('');
      await reload();

      if (payload.email) {
        if (res.email_sent) {
          setStatus({ type: 'ok', text: `Invite created and email sent to ${payload.email}.` });
        } else {
          setStatus({
            type: 'warn',
            text: res.email_error ?? 'Invite created, but the email could not be sent.',
          });
        }
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create invite');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = (code: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/join/${code}`);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  const sendByEmail = email.trim().length > 0;

  return (
    <PageShell
      title="Invitations"
      subtitle="Create a Komikone invite link. Add an email to have Clerk send the invitation for you."
    >
      <div className="max-w-lg">
        <h2 className="text-sm font-medium text-gray-300 mb-3">Invite someone</h2>
        <div className="space-y-3 mb-6">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name (for your reference)"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email (optional — Clerk sends the invite)"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            {creating
              ? 'Working…'
              : sendByEmail
                ? 'Create invite & send email'
                : 'Create invite link'}
          </button>
        </div>

        {status && (
          <p className={`text-sm mb-4 ${status.type === 'ok' ? 'text-green-400' : 'text-amber-400'}`}>
            {status.text}
          </p>
        )}

        <p className="text-xs text-gray-500 mb-4">
          Email uses Clerk&apos;s invitation (no Organizations). After sign-up, they land on your join link to complete Komikone registration.
        </p>

        {invites.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 mb-2">Unused invites</p>
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <div className="flex-1 min-w-0">
                  {inv.label && <p className="text-white text-sm truncate">{inv.label}</p>}
                  <p className="text-gray-500 text-xs font-mono">{inv.code}</p>
                </div>
                <button
                  onClick={() => copyLink(inv.code)}
                  className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
                >
                  {copied === inv.code ? 'Copied!' : 'Copy link'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No unused invites yet.</p>
        )}
      </div>
    </PageShell>
  );
}
