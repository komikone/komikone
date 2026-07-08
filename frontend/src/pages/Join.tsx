import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { api, type Year } from '../lib/api';

type InviteInfo = {
  invite: { code: string; label: string; year_id: number };
  year: Pick<Year, 'id' | 'name' | 'con_year'>;
};

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-gray-400 mb-1';

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [step, setStep] = useState<'loading' | 'sign-in' | 'form' | 'done'>('loading');

  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    member_id: '',
    badge_type: 'ADULT' as 'ADULT' | 'JUNIOR',
    return_eligible: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [regEventId, setRegEventId] = useState<number | null>(null);

  // Step 1: validate the invite code
  useEffect(() => {
    if (!code) return;
    api.invites.get(code).then((info) => {
      setInviteInfo(info);
      setStep(isLoaded && isSignedIn ? 'form' : 'sign-in');
    }).catch((e) => {
      setInviteError(e.message);
      setStep('form'); // show error state
    });
  }, [code]);

  // Step 2: once signed in, move to form
  useEffect(() => {
    if (isLoaded && isSignedIn && step === 'sign-in') {
      setStep('form');
    }
  }, [isLoaded, isSignedIn, step]);

  const set = (key: keyof typeof form, val: unknown) => setForm(f => ({ ...f, [key]: val }));

  const handleSubmit = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setSubmitError('First and last name are required.');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const tok = await getToken({ template: 'komikone' });
      if (!tok) throw new Error('Not signed in');
      await api.invites.accept(code!, tok, form);
      const events = await api.events.list();
      const conYear = inviteInfo?.year.con_year;
      const openRegs = events.filter((e) => e.year === conYear && e.status === 'registration');
      const target = form.return_eligible
        ? openRegs.find((e) => e.reg_type === 'return') ?? openRegs.find((e) => e.reg_type === 'open')
        : openRegs.find((e) => e.reg_type === 'open') ?? openRegs.find((e) => e.reg_type === 'return');
      setRegEventId(target?.id ?? null);
      setStep('done');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'loading') {
    return <Screen><p className="text-gray-400">Checking invite…</p></Screen>;
  }

  if (inviteError) {
    return (
      <Screen>
        <div className="bg-red-950/40 border border-red-700 rounded-xl p-6 text-center">
          <p className="text-red-300 font-medium mb-1">Invalid invite</p>
          <p className="text-gray-400 text-sm">{inviteError}</p>
        </div>
        <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm mt-6 block text-center">← Home</Link>
      </Screen>
    );
  }

  if (step === 'done') {
    return (
      <Screen>
        <div className="bg-green-950/40 border border-green-700 rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">🎉</div>
          <h2 className="text-xl font-bold text-white mb-2">You're in!</h2>
          <p className="text-gray-400 text-sm mb-6">
            Welcome to {inviteInfo?.year.name}.
            {regEventId ? ' Select your badge days next, or head to your dashboard.' : ' Head to your dashboard to manage your group.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {regEventId && (
              <Link
                to={`/register/${regEventId}`}
                className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
              >
                Select badge days →
              </Link>
            )}
            <button
              onClick={() => navigate('/dashboard')}
              className={`font-medium px-6 py-2.5 rounded-lg transition-colors ${
                regEventId
                  ? 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </Screen>
    );
  }

  if (step === 'sign-in') {
    return (
      <Screen>
        <div className="mb-6 text-center">
          <p className="text-gray-400 text-sm">
            You've been invited to <span className="text-white font-medium">{inviteInfo?.year.name ?? 'KomikOne'}</span>.
            Sign in to continue.
          </p>
        </div>
        <div className="flex justify-center">
          <SignIn routing="hash" afterSignInUrl={window.location.href} afterSignUpUrl={window.location.href} />
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Join {inviteInfo?.year.name}</h1>
        <p className="text-gray-400 text-sm mt-1">Complete your registration below.</p>
      </div>

      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>First Name *</label>
            <input type="text" value={form.first_name} onChange={e => set('first_name', e.target.value)} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={labelCls}>Last Name *</label>
            <input type="text" value={form.last_name} onChange={e => set('last_name', e.target.value)} className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>SDCC Member ID</label>
          <input
            type="text"
            value={form.member_id}
            onChange={e => set('member_id', e.target.value)}
            className={inputCls}
            placeholder="e.g. 1234567"
          />
          <p className="text-xs text-gray-600 mt-1">Found in your SDCC account. Used to link your registration.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Badge Type</label>
            <select value={form.badge_type} onChange={e => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
              <option value="ADULT">Adult</option>
              <option value="JUNIOR">Junior / Senior / Military</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.return_eligible}
                onChange={e => set('return_eligible', e.target.checked)}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-500"
              />
              <span className="text-sm text-gray-300">Return eligible</span>
            </label>
          </div>
        </div>

        {submitError && (
          <p className="text-red-400 text-sm">{submitError}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
        >
          {submitting ? 'Registering…' : 'Complete Registration'}
        </button>
      </div>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
