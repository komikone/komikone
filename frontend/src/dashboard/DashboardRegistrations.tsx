import { Link } from 'react-router-dom';
import { useDashboard } from './DashboardContext';
import { PageShell, EmptyState } from './DashboardProfile';
import { FamilySection } from './FamilySection';

export default function DashboardRegistrations() {
  const {
    member, groupViews, saveSelf, registrationOpen, primaryView,
  } = useDashboard();

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

  const identity = {
    first_name: member.first_name ?? '',
    last_name: member.last_name ?? '',
    member_id: member.member_id ?? '',
    badge_type: (member.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT') as 'ADULT' | 'JUNIOR',
    return_eligible: !!member.return_eligible,
  };

  return (
    <PageShell title="Registrations" subtitle="Badge days and family members for each event.">
      <div className="space-y-8">
        {relevantViews.map((view) => {
          const self = view.participants.find((p) => p.clerk_user_id === member.clerk_user_id)
            ?? view.participants.find(
              (p) => !!(member.member_id && p.member_id && p.member_id.toUpperCase() === member.member_id.toUpperCase()),
            );
          const isPrimary = view.event.id === primaryView?.event.id;
          const canOpenLive =
            view.event.reg_type !== 'return' || !!member.return_eligible;

          return (
            <section key={view.event.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 dark:border-gray-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 dark:border-gray-800 flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold text-gray-900 dark:text-white">{view.event.name}</h2>
                  <EventStatusBadge status={view.event.status} />
                </div>
                {canOpenLive ? (
                  <Link
                    to={`/live/${view.event.id}`}
                    className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
                  >
                    Live board →
                  </Link>
                ) : (
                  <span className="text-xs text-gray-500 shrink-0" title="Return Reg Live Board is for return-eligible members">
                    Open Reg only
                  </span>
                )}
              </div>

              <div className="p-5">
                {/* Family is managed on the primary event only, to avoid duplicate management. */}
                <FamilySection
                  view={view}
                  self={self}
                  identity={identity}
                  manageFamily={isPrimary}
                  canEditSelfDays={isPrimary && view.event.status === 'registration'}
                  onSaveSelfDays={saveSelf}
                />
              </div>
            </section>
          );
        })}
      </div>

      {registrationOpen && (
        <p className="text-gray-500 text-xs mt-6">
          Registration is open. Tap Edit on anyone, including yourself, to change badge days.
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
