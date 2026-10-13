import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { api, type Year } from '../lib/api';
import { AppPage } from '../components/AppPage';
import { normalizeMemberIdInput } from '../components/MemberId';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { ClerkLoading } from '../components/ClerkLoading';
import { forgetPendingInvite, rememberPendingInvite } from '../lib/pendingInvite';

type InviteInfo = {
  invite: { code: string; label: string; year_id: number };
  year: Pick<Year, 'id' | 'name' | 'con_year'>;
};

const inputCls = 'w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-gray-900 dark:text-gray-50 text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-gray-400 mb-1';

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [inviteUsed, setInviteUsed] = useState(false);
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
  const [regEvents, setRegEvents] = useState<{ id: number; name: string }[]>([]);
  const [prefilled, setPrefilled] = useState(false);

  // Without the hash, so Clerk's own #/factor-one style steps aren't carried back here.
  const joinUrl = `${window.location.origin}/join/${code ?? ''}`;

  // Step 1: validate the invite code
  useEffect(() => {
    if (!code) return;
    api.invites.get(code).then((info) => {
      rememberPendingInvite(code);
      setInviteInfo(info);
      setStep(isLoaded && isSignedIn ? 'form' : 'sign-in');
    }).catch((e) => {
      const msg = e.message ?? '';
      setInviteError(msg);
      setInviteUsed(msg.toLowerCase().includes('already been used'));
      setStep('form');
    });
  }, [code]);

  // Step 2: once signed in, move to form
  useEffect(() => {
    if (isLoaded && isSignedIn && step === 'sign-in') {
      setStep('form');
    }
  }, [isLoaded, isSignedIn, step]);

  // Step 3: adopt whatever the organizer already recorded for this email, so the
  // invitee confirms rather than retypes. Silent on failure — typing still works.
  useEffect(() => {
    if (!code || !isLoaded || !isSignedIn || step !== 'form' || prefilled) return;
    let cancelled = false;
    (async () => {
      try {
        const tok = await getToken({ template: 'komikone' });
        if (!tok) return;
        const { prefill } = await api.invites.prefill(code, tok);
        if (cancelled || !prefill) return;
        setForm((f) => ({
          ...f,
          first_name: f.first_name || prefill.first_name,
          last_name: f.last_name || prefill.last_name,
          member_id: normalizeMemberIdInput(f.member_id || prefill.member_id),
          badge_type: prefill.badge_type,
          return_eligible: prefill.return_eligible,
        }));
        setPrefilled(true);
      } catch {
        // No prefill available; the form stays blank and manual entry works as before.
      }
    })();
    return () => { cancelled = true; };
  }, [code, isLoaded, isSignedIn, step, prefilled, getToken]);

  const set = (key: keyof typeof form, val: unknown) => setForm(f => ({ ...f, [key]: val }));

  const handleSubmit = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setSubmitError('First and last name are required.');
      return;
    }
    if (!form.member_id.trim()) {
      setSubmitError('SDCC Member ID is required — the purchase board uses it to identify you.');
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
      // Days are per-event, so list every open registration rather than guessing one.
      // Picking a single target silently stranded people when a year had more than one
      // open event — they never saw the other and showed up to purchase day with no days.
      const preferred = form.return_eligible ? 'return' : 'open';
      const openRegs = events
        .filter((e) => e.year === conYear && e.status === 'registration')
        .sort((a, b) => Number(b.reg_type === preferred) - Number(a.reg_type === preferred));
      setRegEvents(openRegs.map((e) => ({ id: e.id, name: e.name })));
      forgetPendingInvite();
      setStep('done');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Registration failed';
      if (msg.toLowerCase().includes('already registered')) {
        forgetPendingInvite();
        navigate('/dashboard');
        return;
      }
      setSubmitError(msg);
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
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 rounded-xl p-6 text-center">
          <p className="text-red-700 dark:text-red-300 font-medium mb-1">
            {inviteUsed ? 'Invite already used' : 'Invalid invite'}
          </p>
          <p className="text-gray-400 text-sm">{inviteError}</p>
          {inviteUsed && (
            <p className="text-gray-400 text-sm mt-4">
              Already joined?{' '}
              <Link to="/sign-in?redirect=%2Fdashboard" className="text-blue-400 hover:text-blue-300">
                Sign in to your dashboard
              </Link>
            </p>
          )}
        </div>
        <Link to="/" className="text-gray-500 hover:text-gray-700 text-sm mt-6 block text-center">← Home</Link>
      </Screen>
    );
  }

  if (step === 'done') {
    return (
      <Screen>
        <div className="bg-green-950/40 border border-green-700 rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">🎉</div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">You're in!</h2>
          <p className="text-gray-400 text-sm mb-6">
            Welcome to {inviteInfo?.year.name}.
            {regEvents.length
              ? ' Pick your badge days for each registration below.'
              : ' Head to your dashboard to manage your group.'}
          </p>
          <div className="flex flex-col gap-3 justify-center">
            {regEvents.map((e) => (
              <Link
                key={e.id}
                to={`/register/${e.id}`}
                className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
              >
                Select badge days — {e.name} →
              </Link>
            ))}
            <button
              onClick={() => navigate('/dashboard')}
              className={`font-medium px-6 py-2.5 rounded-lg transition-colors ${
                regEvents.length
                  ? 'bg-gray-100 hover:bg-gray-300 text-gray-800'
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
            You've been invited to <span className="text-gray-900 dark:text-white font-medium">{inviteInfo?.year.name ?? 'KomikOne'}</span>.
            Sign in to continue.
          </p>
        </div>
        <div className="flex justify-center">
          {isLoaded ? (
            <SignIn
              routing="hash"
              forceRedirectUrl={joinUrl}
              signUpForceRedirectUrl={joinUrl}
            />
          ) : (
            <ClerkLoading />
          )}
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Join {inviteInfo?.year.name}</h1>
        <p className="text-gray-400 text-sm mt-1">Complete your registration below.</p>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-6 space-y-4">
        {prefilled && (
          <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg px-3 py-2">
            We filled this in from what your organizer already entered. Check it over and fix
            anything that's wrong.
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          <label className={labelCls}>SDCC Member ID *</label>
          <input
            type="text"
            value={form.member_id}
            onChange={e => set('member_id', normalizeMemberIdInput(e.target.value))}
            className={`${inputCls} font-mono uppercase tracking-wide`}
            placeholder="e.g. AB12CD34"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <p className="text-xs text-gray-600 mt-1">
            Found in your SDCC account. This is what links you to your badge — without it the
            purchase board can't let you in.
          </p>
        </div>

        {/* Stacked on phones: "Junior / Senior / Military" and the toggle label both
            overflow a half-width column at 390px. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Badge Type</label>
            <select value={form.badge_type} onChange={e => set('badge_type', e.target.value as 'ADULT' | 'JUNIOR')} className={inputCls}>
              <option value="ADULT">Adult</option>
              <option value="JUNIOR">Junior / Senior / Military</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <ToggleSwitch
              checked={form.return_eligible}
              onChange={(v) => set('return_eligible', v)}
              label="Return eligible"
              className="w-full"
            />
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
    <AppPage backTo={{ to: '/', label: '← Home' }}>
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </AppPage>
  );
}
