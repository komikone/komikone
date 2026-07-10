import { Link } from 'react-router-dom';
import { useDashboard } from './DashboardContext';
import { badgeTypeLabel } from './styles';
import BackgroundLayer from '../components/BackgroundLayer';
import { MemberId } from '../components/MemberId';

export default function DashboardHome() {
  const { member, primaryView } = useDashboard();

  if (!member) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center max-w-md">
          <p className="text-gray-400">You are not registered for this year yet.</p>
          <p className="text-gray-500 text-sm mt-2">
            Use your invite link to join, or request access from the homepage.
          </p>
          <Link to="/" className="inline-block mt-4 text-sm text-blue-400 hover:text-blue-300">
            Go to homepage
          </Link>
        </div>
      </div>
    );
  }

  return (
    <BackgroundLayer className="flex-1" minHeight="min-h-[calc(100vh)]">
      <div className="flex flex-col justify-end min-h-[calc(100vh)] p-8 md:p-12">
        <div className="max-w-lg">
          <div className="bg-gray-900/90 backdrop-blur-md border border-gray-700/80 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Welcome back</p>
                <h1 className="text-2xl font-bold text-white">
                  {member.first_name} {member.last_name}
                </h1>
              </div>
              <Link
                to="/dashboard/profile"
                className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors shrink-0"
              >
                Edit
              </Link>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-gray-500 text-xs">Member ID</dt>
                <dd className="mt-0.5">
                  <MemberId
                    value={member.member_id}
                    className="font-mono text-sm tracking-wide"
                    letterClassName="text-gray-200"
                    digitClassName="text-amber-400"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">Badge type</dt>
                <dd className="text-gray-200 mt-0.5">{badgeTypeLabel(member.badge_type)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">Return eligible</dt>
                <dd className={`mt-0.5 ${member.return_eligible ? 'text-green-400' : 'text-gray-400'}`}>
                  {member.return_eligible ? 'Yes' : 'No'}
                </dd>
              </div>
              {primaryView?.group && (
                <div>
                  <dt className="text-gray-500 text-xs">Group</dt>
                  <dd className="text-gray-200 mt-0.5 inline-flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: primaryView.group.color }}
                    />
                    {primaryView.group.name}
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-5 pt-4 border-t border-gray-800 flex gap-3">
              <Link
                to="/dashboard/registrations"
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Registrations →
              </Link>
              <Link
                to="/dashboard/invitations"
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Invitations →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </BackgroundLayer>
  );
}
