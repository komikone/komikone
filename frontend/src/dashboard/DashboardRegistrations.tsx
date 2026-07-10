import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DAY_KEYS, dayLabel, type Participant } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { selectedDays } from './participantDays';
import { PageShell, EmptyState } from './DashboardProfile';
import { FamilySection } from './FamilySection';

export default function DashboardRegistrations() {
  const {
    member, groupViews, saveSelf, registrationOpen, primaryView,
  } = useDashboard();
  const [editingDays, setEditingDays] = useState(false);
  const [days, setDays] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  if (!member) {
    return <EmptyState title="Registrations" message="Join with an invite to manage registrations." />;
  }

  const relevantViews = groupViews.filter((v) =>
    v.event.status !== 'complete' || v.participants.length > 0
  );

  if (relevantViews.length === 0) {
    return (
      <PageShell title="Registrations" subtitle="Badge days and family members for each event.">
        <p className="text-gray-400 text-sm">No active registrations for this year.</p>
      </PageShell>
    );
  }

  const startEditDays = (participant: Participant | undefined) => {
    setDays(
      Object.fromEntries(
        DAY_KEYS.map((d) => [`req_${d}`, participant ? !!participant[`req_${d}` as keyof typeof participant] : false])
      )
    );
    setEditingDays(true);
    setErr('');
  };

  const handleSaveDays = async () => {
    setSaving(true);
    setErr('');
    try {
      await saveSelf(days as Parameters<typeof saveSelf>[0]);
      setEditingDays(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell title="Registrations" subtitle="Badge days and family members for each event.">
      <div className="space-y-8">
        {relevantViews.map((view) => {
          const self = view.participants.find((p) => p.clerk_user_id === member.clerk_user_id)
            ?? view.participants.find(
              (p) => !!(member.member_id && p.member_id && p.member_id.toUpperCase() === member.member_id.toUpperCase()),
            );
          const dayPrefix =
            ['purchasing', 'payment', 'complete'].includes(view.event.status) ? 'pur' : 'req';
          const myDays = self ? selectedDays(self, dayPrefix) : [];
          const isPrimary = view.event.id === primaryView?.event.id;
          const canEditDays = isPrimary && view.event.status === 'registration';

          return (
            <section key={view.event.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 dark:border-gray-800 flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold text-gray-900 dark:text-white">{view.event.name}</h2>
                  <EventStatusBadge status={view.event.status} />
                </div>
                {view.event.status === 'purchasing' || view.event.status === 'payment' ? (
                  <Link
                    to={`/live/${view.event.id}`}
                    className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
                  >
                    Live board →
                  </Link>
                ) : null}
              </div>

              <div className="p-5 space-y-6">
                {/* Badge days */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Badge days desired</h3>
                    {canEditDays && !editingDays && (
                      <button
                        onClick={() => startEditDays(self)}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        {myDays.length > 0 ? 'Edit' : 'Select days'}
                      </button>
                    )}
                  </div>

                  {isPrimary && editingDays ? (
                    <div>
                      <div className="space-y-2 mb-4">
                        {DAY_KEYS.map((day) => (
                          <label key={day} className="flex items-center gap-3 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={!!days[`req_${day}`]}
                              onChange={(e) =>
                                setDays((d) => ({ ...d, [`req_${day}`]: e.target.checked }))
                              }
                              className="w-4 h-4 rounded border-gray-300 bg-gray-100 accent-blue-500"
                            />
                            <span className="text-gray-700 text-sm">{dayLabel(day)}</span>
                          </label>
                        ))}
                      </div>
                      {err && <p className="text-red-400 text-xs mb-2">{err}</p>}
                      <div className="flex gap-2">
                        <button
                          onClick={handleSaveDays}
                          disabled={saving}
                          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
                        >
                          {saving ? 'Saving…' : 'Save days'}
                        </button>
                        <button
                          onClick={() => setEditingDays(false)}
                          className="text-sm text-gray-400 hover:text-gray-900 px-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : myDays.length > 0 ? (
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
                      {canEditDays ? 'No days selected yet.' : 'No badge days on file.'}
                    </p>
                  )}

                  {dayPrefix === 'pur' && self && selectedDays(self, 'pur').length === 0
                    && selectedDays(self, 'req').length > 0 && (
                    <p className="text-gray-500 text-xs mt-2">
                      Requested: {selectedDays(self, 'req').map(dayLabel).join(', ')}
                    </p>
                  )}
                </div>

                {/* Family — only on primary view to avoid duplicate management */}
                {isPrimary && (
                  <FamilySection
                    view={view}
                    excludeClerkUserId={member.clerk_user_id}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>

      {registrationOpen && (
        <p className="text-gray-500 text-xs mt-6">
          Registration is open — update your badge days above.
        </p>
      )}
    </PageShell>
  );
}

function EventStatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    registration: 'Registration open',
    purchasing: 'Purchase day',
    payment: 'Settling up',
    complete: 'Complete',
  };
  const colors: Record<string, string> = {
    registration: 'text-green-400',
    purchasing: 'text-yellow-400',
    payment: 'text-blue-400',
    complete: 'text-gray-500',
  };
  return (
    <p className={`text-xs mt-0.5 ${colors[status] ?? 'text-gray-500'}`}>
      {labels[status] ?? status}
    </p>
  );
}
