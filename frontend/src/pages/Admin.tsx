import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type EventDetail,
  type Participant,
  type YearMeta,
  type Group,
  type Sponsor,
  type InviteRequest,
  sponsorColor,
  formatDollars,
  DAY_KEYS,
  dayLabel,
} from '../lib/api';

const STATUS_OPTIONS: EventDetail['status'][] = ['setup', 'registration', 'purchasing', 'payment', 'complete'];

// ─── Auth gate ────────────────────────────────────────────────────────────────

function useAdminSecret(): [string, (s: string) => void] {
  const [secret, setSecretState] = useState(() => sessionStorage.getItem('admin_secret') ?? '');
  const setSecret = (s: string) => {
    sessionStorage.setItem('admin_secret', s);
    setSecretState(s);
  };
  return [secret, setSecret];
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export default function Admin() {
  const [secret, setSecret] = useAdminSecret();
  const [inputSecret, setInputSecret] = useState('');
  const [authError, setAuthError] = useState('');
  const [authed, setAuthed] = useState(Boolean(sessionStorage.getItem('admin_secret')));

  const [events, setEvents] = useState<EventDetail[]>([]);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [inviteRequests, setInviteRequests] = useState<InviteRequest[]>([]);
  const [view, setView] = useState<'year' | 'invites'>('year');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [activeRegType, setActiveRegType] = useState<'return' | 'open'>('return');

  // Per-event data — always store both so Overview can show both
  const [returnParticipants, setReturnParticipants] = useState<Participant[]>([]);
  const [openParticipants, setOpenParticipants] = useState<Participant[]>([]);
  const [yearMeta, setYearMeta] = useState<YearMeta | null>(null);

  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'participants' | 'prices' | 'dates'>('overview');

  // Derived
  const years = useMemo(
    () => [...new Set(events.map((e) => e.year))].sort((a, b) => b - a),
    [events]
  );
  const yearEvents = events.filter((e) => e.year === selectedYear);
  const returnEvent = yearEvents.find((e) => e.reg_type === 'return') ?? null;
  const openEvent = yearEvents.find((e) => e.reg_type === 'open') ?? null;
  const activeEvent = yearEvents.find((e) => e.reg_type === activeRegType) ?? yearEvents[0] ?? null;
  const participants = activeRegType === 'return' ? returnParticipants : openParticipants;

  const loadEvents = useCallback(async (): Promise<EventDetail[]> => {
    if (!secret) return [];
    setLoading(true);
    try {
      const summaries = await api.events.list();
      const detailed = await Promise.all(summaries.map((s) => api.admin.events.getWithToken(secret, s.id)));
      setEvents(detailed);
      return detailed;
    } catch (e) {
      console.error(e);
      return [];
    } finally {
      setLoading(false);
    }
  }, [secret]);

  const loadYearData = useCallback(async (year: number, evts: EventDetail[]) => {
    const retEvt = evts.find((e) => e.year === year && e.reg_type === 'return');
    const openEvt = evts.find((e) => e.year === year && e.reg_type === 'open');

    const [retPs, openPs, meta] = await Promise.all([
      retEvt ? api.participants.list(retEvt.id, retEvt.access_token).catch(() => []) : Promise.resolve([]),
      openEvt ? api.participants.list(openEvt.id, openEvt.access_token).catch(() => []) : Promise.resolve([]),
      api.admin.yearMeta.get(secret, year).catch(() => null),
    ]);
    setReturnParticipants(retPs);
    setOpenParticipants(openPs);
    setYearMeta(meta);
  }, [secret]);

  const reloadAll = useCallback(async (year?: number) => {
    const fresh = await loadEvents();
    const yr = year ?? selectedYear;
    if (yr !== null) loadYearData(yr, fresh);
  }, [loadEvents, loadYearData, selectedYear]);

  const reloadEventData = useCallback(async (regType: 'return' | 'open', evts: EventDetail[], year: number) => {
    const evt = evts.find((e) => e.year === year && e.reg_type === regType);
    if (!evt) return;
    const ps = await api.participants.list(evt.id, evt.access_token).catch(() => []);
    if (regType === 'return') setReturnParticipants(ps);
    else setOpenParticipants(ps);
  }, []);

  const loadSponsors = useCallback(async () => {
    if (!secret) return;
    try {
      const list = await api.admin.sponsors.list(secret);
      setSponsors(list);
    } catch {
      setSponsors([]);
    }
  }, [secret]);

  const loadInvites = useCallback(async () => {
    if (!secret) return;
    try {
      const list = await api.admin.inviteRequests.list(secret);
      setInviteRequests(list);
    } catch {
      setInviteRequests([]);
    }
  }, [secret]);

  useEffect(() => {
    if (authed) { loadEvents(); loadSponsors(); loadInvites(); }
  }, [authed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select latest year when events first load
  useEffect(() => {
    if (events.length > 0 && selectedYear === null) {
      const latest = Math.max(...events.map((e) => e.year));
      setSelectedYear(latest);
      loadYearData(latest, events);
    }
  }, [events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleYearSelect = (year: number) => {
    setSelectedYear(year);
    setActiveRegType('return');
    setTab('overview');
    loadYearData(year, events);
  };

  const handleRegTypeSwitch = (type: 'return' | 'open') => {
    const targetEvt = yearEvents.find((e) => e.reg_type === type);
    if (!targetEvt) return;
    setActiveRegType(type);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setSecret(inputSecret);
    setAuthed(true);
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center halftone-bg">
        <form onSubmit={handleLogin} className="bg-gray-950 border-2 border-yellow-400 comic-shadow p-8 w-80">
          <h1 className="font-bangers text-4xl text-yellow-400 text-center tracking-wide leading-none mb-1">komikone</h1>
          <p className="text-gray-500 text-xs text-center uppercase tracking-widest mb-6">Admin Access</p>
          <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">Admin Secret</label>
          <input
            type="password"
            value={inputSecret}
            onChange={(e) => setInputSecret(e.target.value)}
            className="w-full bg-gray-800 border-2 border-gray-600 px-3 py-2 text-white mb-4 focus:outline-none focus:border-yellow-400"
            autoFocus
          />
          {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
          <button
            type="submit"
            className="w-full bg-yellow-400 hover:bg-yellow-300 text-black font-bangers tracking-wide text-xl py-2 border-2 border-black comic-shadow-sm transition-colors"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex">
      {/* Sidebar — years only */}
      <aside className="w-44 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-gray-800">
          <Link to="/" className="text-gray-500 hover:text-yellow-400 text-xs uppercase tracking-wider">← Public site</Link>
          <h1 className="font-bangers text-yellow-400 text-xl tracking-wide mt-1">komikone</h1>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">
          <div>
            <div className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Years</div>
            {loading && years.length === 0 && (
              <div className="text-gray-500 text-xs px-2">Loading…</div>
            )}
            {years.map((year) => {
              const yEvts = events.filter((e) => e.year === year);
              const hasReturn = yEvts.some((e) => e.reg_type === 'return');
              const hasOpen = yEvts.some((e) => e.reg_type === 'open');
              return (
                <button
                  key={year}
                  onClick={() => handleYearSelect(year)}
                  className={`w-full text-left px-2 py-2 rounded mb-0.5 transition-colors ${
                    selectedYear === year ? 'bg-blue-700 text-white' : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <div className="font-bold text-sm">{year}</div>
                  <div className="text-xs text-gray-400">
                    {[hasReturn && 'Return', hasOpen && 'Open'].filter(Boolean).join(' · ')}
                  </div>
                </button>
              );
            })}
            <InitializeYearButton secret={secret} onCreated={loadEvents} />
          </div>

          <SponsorsPanel secret={secret} sponsors={sponsors} onUpdate={loadSponsors} />

          {/* Invites */}
          <div className="border-t border-gray-800 pt-3">
            <button
              onClick={() => setView(view === 'invites' ? 'year' : 'invites')}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors flex items-center justify-between ${
                view === 'invites' ? 'bg-blue-700 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              <span className="text-xs uppercase tracking-wide font-medium">Invites</span>
              {inviteRequests.filter((r) => r.status === 'pending').length > 0 && (
                <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                  {inviteRequests.filter((r) => r.status === 'pending').length}
                </span>
              )}
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col">
        {view === 'invites' ? (
          <div className="flex-1 overflow-auto p-6">
            <InviteRequestsPanel
              secret={secret}
              requests={inviteRequests}
              onUpdate={loadInvites}
            />
          </div>
        ) : selectedYear === null ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {loading ? 'Loading…' : 'Select or initialize a year'}
          </div>
        ) : (
          <>
            {/* Detail header + tab bar */}
            <div className="border-b border-gray-800 bg-gray-900/50 px-6 pt-5 pb-0">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">SDCC {selectedYear}</h2>
                  <p className="text-sm text-gray-500">
                    {[returnEvent && 'Return Reg', openEvent && 'Open Reg'].filter(Boolean).join(' + ')}
                  </p>
                </div>
                {activeEvent && (
                  <div className="flex gap-2">
                    <a
                      href={api.admin.exportUrl(activeEvent.id, secret)}
                      className="text-sm bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition-colors"
                      download
                    >
                      Export CSV
                    </a>
                    <Link
                      to={`/live/${activeEvent.id}?token=${activeEvent.access_token}`}
                      target="_blank"
                      className="text-sm bg-yellow-600 hover:bg-yellow-500 text-white px-3 py-1.5 rounded transition-colors"
                    >
                      Live Board ↗
                    </Link>
                  </div>
                )}
              </div>
              {/* Tabs */}
              <div className="flex gap-1">
                {(['overview', 'participants', 'prices', 'dates'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                      tab === t
                        ? 'border-blue-500 text-white'
                        : 'border-transparent text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-auto p-6">
            {tab === 'overview' && (
              <OverviewTab
                returnEvent={returnEvent}
                openEvent={openEvent}
                secret={secret}
                returnParticipants={returnParticipants}
                openParticipants={openParticipants}
                allEvents={events}
                onUpdate={() => reloadAll()}
              />
            )}
            {tab === 'participants' && (
              <ParticipantsTab
                event={activeEvent}
                activeRegType={activeRegType}
                returnEvent={returnEvent}
                openEvent={openEvent}
                onRegTypeChange={handleRegTypeSwitch}
                secret={secret}
                participants={participants}
                allEvents={events}
                sponsors={sponsors}
                onUpdate={() => { if (selectedYear) reloadEventData(activeRegType, events, selectedYear); }}
              />
            )}
            {tab === 'prices' && (
              <PricesTab
                event={activeEvent}
                activeRegType={activeRegType}
                returnEvent={returnEvent}
                openEvent={openEvent}
                onRegTypeChange={handleRegTypeSwitch}
                secret={secret}
                onUpdate={loadEvents}
              />
            )}
            {tab === 'dates' && selectedYear !== null && (
              <DatesTab
                year={selectedYear}
                secret={secret}
                meta={yearMeta}
                onUpdate={() => selectedYear !== null && api.admin.yearMeta.get(secret, selectedYear).then(setYearMeta).catch(() => {})}
              />
            )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ─── Initialize Year ──────────────────────────────────────────────────────────

const SDCC_DEFAULTS = {
  price_preview_adult: 6400, price_thu_adult: 8500, price_fri_adult: 8500,
  price_sat_adult: 8500, price_sun_adult: 6400,
  price_preview_junior: 3200, price_thu_junior: 4300, price_fri_junior: 4300,
  price_sat_junior: 4300, price_sun_junior: 3200,
};

const PRICE_ROWS: { day: string; adultKey: keyof typeof SDCC_DEFAULTS; juniorKey: keyof typeof SDCC_DEFAULTS }[] = [
  { day: 'Preview', adultKey: 'price_preview_adult', juniorKey: 'price_preview_junior' },
  { day: 'Thursday', adultKey: 'price_thu_adult', juniorKey: 'price_thu_junior' },
  { day: 'Friday', adultKey: 'price_fri_adult', juniorKey: 'price_fri_junior' },
  { day: 'Saturday', adultKey: 'price_sat_adult', juniorKey: 'price_sat_junior' },
  { day: 'Sunday', adultKey: 'price_sun_adult', juniorKey: 'price_sun_junior' },
];

function InitializeYearButton({ secret, onCreated }: { secret: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const [prices, setPrices] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(SDCC_DEFAULTS).map(([k, v]) => [k, (v / 100).toFixed(2)]))
  );
  const [loading, setLoading] = useState(false);

  const setPrice = (key: string, val: string) => setPrices((p) => ({ ...p, [key]: val }));
  const centsOf = (key: string) => Math.round(parseFloat(prices[key] || '0') * 100);

  const handleInit = async () => {
    setLoading(true);
    try {
      await api.admin.initializeYear(secret, {
        year,
        price_preview_adult: centsOf('price_preview_adult'),
        price_thu_adult: centsOf('price_thu_adult'),
        price_fri_adult: centsOf('price_fri_adult'),
        price_sat_adult: centsOf('price_sat_adult'),
        price_sun_adult: centsOf('price_sun_adult'),
        price_preview_junior: centsOf('price_preview_junior'),
        price_thu_junior: centsOf('price_thu_junior'),
        price_fri_junior: centsOf('price_fri_junior'),
        price_sat_junior: centsOf('price_sat_junior'),
        price_sun_junior: centsOf('price_sun_junior'),
      });
      setOpen(false);
      onCreated();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left px-2 py-1.5 rounded text-sm text-blue-400 hover:bg-gray-800 mt-1"
      >
        + Initialize Year
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm">
        <div className="flex justify-between items-center mb-5">
          <h3 className="font-bold text-white">Initialize Year</h3>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <p className="text-gray-400 text-xs mb-4">
          Creates <span className="text-white font-medium">Return Reg</span> and{' '}
          <span className="text-white font-medium">Open Reg</span> events for the year, both in setup status.
        </p>

        <div className="mb-5">
          <label className="block text-xs text-gray-400 mb-1">Year</label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-28 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="mb-5">
          <div className="grid grid-cols-3 gap-1 mb-2 text-xs text-gray-400 text-center">
            <div className="text-left">Day</div>
            <div>Adult</div>
            <div>Jr / Mil / Sr</div>
          </div>
          {PRICE_ROWS.map(({ day, adultKey, juniorKey }) => (
            <div key={day} className="grid grid-cols-3 gap-1 mb-1.5 items-center">
              <div className="text-xs text-gray-300">{day}</div>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={prices[adultKey]}
                  onChange={(e) => setPrice(adultKey, e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded pl-5 pr-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={prices[juniorKey]}
                  onChange={(e) => setPrice(juniorKey, e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded pl-5 pr-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleInit}
            disabled={loading}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded text-sm font-medium transition-colors"
          >
            {loading ? 'Creating…' : `Initialize ${year}`}
          </button>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white px-4 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Event Toggle ─────────────────────────────────────────────────────────────

function EventToggle({
  returnEvent, openEvent, active, onChange,
}: {
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  active: 'return' | 'open';
  onChange: (t: 'return' | 'open') => void;
}) {
  if (!returnEvent && !openEvent) return null;
  return (
    <div className="flex gap-1 mb-5">
      {(['return', 'open'] as const).map((t) => {
        const exists = t === 'return' ? !!returnEvent : !!openEvent;
        return (
          <button
            key={t}
            onClick={() => exists && onChange(t)}
            disabled={!exists}
            className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
              active === t
                ? 'bg-blue-600 text-white'
                : exists
                ? 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                : 'bg-gray-900 text-gray-600 cursor-not-allowed'
            }`}
          >
            {t === 'return' ? 'Return Reg' : 'Open Reg'}
          </button>
        );
      })}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  returnEvent, openEvent, secret,
  returnParticipants, openParticipants,
  allEvents, onUpdate,
}: {
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  secret: string;
  returnParticipants: Participant[];
  openParticipants: Participant[];
  allEvents: EventDetail[];
  onUpdate: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Event cards side-by-side */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {returnEvent && (
          <EventCard
            event={returnEvent}
            secret={secret}
            participants={returnParticipants}
            allEvents={allEvents}
            onUpdate={onUpdate}
          />
        )}
        {openEvent && (
          <EventCard
            event={openEvent}
            secret={secret}
            participants={openParticipants}
            allEvents={allEvents}
            onUpdate={onUpdate}
          />
        )}
        {!returnEvent && (
          <div className="bg-gray-900/50 border border-dashed border-gray-700 rounded-xl p-8 flex items-center justify-center text-gray-600 text-sm">
            No Return Reg event
          </div>
        )}
        {!openEvent && (
          <div className="bg-gray-900/50 border border-dashed border-gray-700 rounded-xl p-8 flex items-center justify-center text-gray-600 text-sm">
            No Open Reg event
          </div>
        )}
      </div>
    </div>
  );
}

function EventCard({
  event, secret, participants, allEvents, onUpdate,
}: {
  event: EventDetail;
  secret: string;
  participants: Participant[];
  allEvents: EventDetail[];
  onUpdate: () => void;
}) {
  const [status, setStatus] = useState(event.status);
  const [name, setName] = useState(event.name);
  const [nameSaved, setNameSaved] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const complete = participants.filter((p) => p.all_purchased).length;
  const paid = participants.filter((p) => p.paid).length;
  const remaining = participants.filter((p) => !p.all_purchased).length;

  const handleStatusChange = async (s: EventDetail['status']) => {
    try {
      await api.admin.events.update(secret, event.id, { status: s });
      setStatus(s);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleNameSave = async () => {
    try {
      await api.admin.events.update(secret, event.id, { name });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const label = event.reg_type === 'return' ? 'Return Reg' : 'Open Reg';
  const origin = window.location.origin;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
          event.reg_type === 'return' ? 'bg-purple-900 text-purple-300' : 'bg-teal-900 text-teal-300'
        }`}>
          {label}
        </span>
        <div className="flex gap-1.5">
          <a
            href={api.admin.exportUrl(event.id, secret)}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded transition-colors"
            download
          >
            CSV
          </a>
          <Link
            to={`/live/${event.id}?token=${event.access_token}`}
            target="_blank"
            className="text-xs bg-yellow-700 hover:bg-yellow-600 text-white px-2 py-1 rounded transition-colors"
          >
            Live ↗
          </Link>
          <button
            onClick={() => setCopyOpen(true)}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded transition-colors"
          >
            Copy →
          </button>
        </div>
      </div>

      {/* Name */}
      <div className="flex gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleNameSave}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors whitespace-nowrap"
        >
          {nameSaved ? 'Saved ✓' : 'Save'}
        </button>
      </div>

      {/* Status */}
      <div className="flex flex-wrap gap-1">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => handleStatusChange(s)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors capitalize ${
              status === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: 'Total', value: participants.length, color: 'text-white' },
          { label: 'Complete', value: complete, color: 'text-green-400' },
          { label: 'Remaining', value: remaining, color: 'text-yellow-400' },
          { label: 'Paid', value: paid, color: 'text-green-400' },
          { label: 'Unpaid', value: participants.length - paid, color: 'text-red-400' },
        ].map(({ label: lbl, value, color }) => (
          <div key={lbl} className="bg-gray-800 rounded-lg p-2">
            <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
            <div className="text-gray-500 text-xs">{lbl}</div>
          </div>
        ))}
      </div>

      {/* Access token */}
      <AccessTokenSection event={event} secret={secret} onUpdate={onUpdate} compact />

      {/* Links */}
      <div className="space-y-1.5">
        <div className="flex gap-2 items-center">
          <code className="bg-gray-800 text-green-400 text-xs px-2 py-1.5 rounded flex-1 break-all">
            {origin}/register/{event.id}?token={event.access_token}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(`${origin}/register/${event.id}?token=${event.access_token}`)}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1.5 rounded shrink-0"
          >
            Copy
          </button>
        </div>
      </div>

      {copyOpen && (
        <CopyParticipantsModal
          event={event}
          secret={secret}
          allEvents={allEvents}
          onDone={() => { setCopyOpen(false); onUpdate(); }}
          onClose={() => setCopyOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Participants Tab ─────────────────────────────────────────────────────────

function ParticipantsTab({
  event, activeRegType, returnEvent, openEvent, onRegTypeChange,
  secret, participants, allEvents, sponsors, onUpdate,
}: {
  event: EventDetail | null;
  activeRegType: 'return' | 'open';
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  onRegTypeChange: (t: 'return' | 'open') => void;
  secret: string;
  participants: Participant[];
  allEvents: EventDetail[];
  sponsors: Sponsor[];
  onUpdate: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [newParticipant, setNewParticipant] = useState<Partial<Participant>>({ badge_type: 'ADULT' });
  const [groups, setGroups] = useState<Group[]>([]);
  const [localParticipantOrder, setLocalParticipantOrder] = useState<number[]>([]);
  const dragSrcP = useRef<number | null>(null);
  const [dragTargetP, setDragTargetP] = useState<number | null>(null);

  const loadGroups = async (evt: EventDetail) => {
    try {
      const gs = await api.groups.list(evt.id, evt.access_token);
      setGroups(gs);
    } catch {
      setGroups([]);
    }
  };

  useEffect(() => {
    if (event) loadGroups(event);
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadGroups = () => { if (event) loadGroups(event); };

  useEffect(() => {
    setLocalParticipantOrder(participants.map((p) => p.id));
  }, [participants]);

  const orderedParticipants = localParticipantOrder.length > 0
    ? (localParticipantOrder.map((id) => participants.find((p) => p.id === id)).filter(Boolean) as Participant[])
    : participants;

  if (!event) return <div className="text-gray-500">No event for this registration type.</div>;

  const handleDelete = async (p: Participant) => {
    if (!confirm(`Delete ${p.first_name} ${p.last_name}?`)) return;
    try {
      await api.admin.participants.delete(secret, event.id, p.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleAdd = async () => {
    if (!newParticipant.first_name?.trim() || !newParticipant.last_name?.trim()) {
      alert('First and last name required');
      return;
    }
    try {
      await api.admin.participants.add(secret, event.id, newParticipant);
      setNewParticipant({ badge_type: 'ADULT' });
      setAddOpen(false);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const onDragStartP = (id: number) => { dragSrcP.current = id; };
  const onDragOverP = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (dragSrcP.current !== null && dragSrcP.current !== id) setDragTargetP(id);
  };
  const onDropP = async (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    const srcId = dragSrcP.current;
    if (srcId === null || srcId === targetId) { dragSrcP.current = null; setDragTargetP(null); return; }
    const next = [...localParticipantOrder];
    const si = next.indexOf(srcId);
    const ti = next.indexOf(targetId);
    if (si !== -1 && ti !== -1) {
      next.splice(si, 1);
      next.splice(ti, 0, srcId);
      setLocalParticipantOrder(next);
      try {
        await api.admin.participants.reorder(secret, event!.id, next);
        onUpdate();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Failed');
      }
    }
    dragSrcP.current = null;
    setDragTargetP(null);
  };
  const onDragEndP = () => { dragSrcP.current = null; setDragTargetP(null); };

  return (
    <div>
      <EventToggle returnEvent={returnEvent} openEvent={openEvent} active={activeRegType} onChange={onRegTypeChange} />

      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-200">{participants.length} participants</h3>
        <div className="flex gap-2">
          <button
            onClick={() => setCopyOpen(true)}
            className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-1.5 rounded transition-colors"
          >
            Copy / Transfer →
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded"
          >
            + Add participant
          </button>
        </div>
      </div>

      <GroupsPanel
        eventId={event.id}
        secret={secret}
        groups={groups}
        onUpdate={() => { reloadGroups(); onUpdate(); }}
      />

      {addOpen && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-4">
          <h4 className="font-medium text-gray-200 mb-3">New Participant</h4>
          <ParticipantForm value={newParticipant} onChange={setNewParticipant} groups={groups} sponsors={sponsors} />
          <div className="flex gap-2 mt-3">
            <button onClick={handleAdd} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded">
              Add
            </button>
            <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-white text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="text-gray-400 text-xs border-b border-gray-700">
            <tr>
              <th className="px-2 py-2 text-left w-8"></th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Member ID</th>
              <th className="px-2 py-2 text-center">Type</th>
              <th className="px-2 py-2 text-center">Ret.</th>
              <th className="px-2 py-2 text-center">Requested</th>
              <th className="px-2 py-2 text-center">Purchased</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-center">Paid</th>
              <th className="px-2 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {orderedParticipants.map((p, idx) => (
              <tr
                key={p.id}
                draggable
                onDragStart={() => onDragStartP(p.id)}
                onDragOver={(e) => onDragOverP(e, p.id)}
                onDrop={(e) => onDropP(e, p.id)}
                onDragEnd={onDragEndP}
                className={`hover:bg-gray-900/50 ${p.all_purchased ? 'opacity-70' : ''} ${dragTargetP === p.id ? 'ring-2 ring-inset ring-blue-400' : ''}`}
              >
                <td className="px-2 py-2 cursor-grab active:cursor-grabbing">
                  <div className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-gray-400 select-none">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                      <circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/>
                      <circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/>
                      <circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/>
                    </svg>
                    <span className="text-[10px] text-gray-600">{idx + 1}</span>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="text-white font-medium flex items-center gap-1.5 flex-wrap">
                    {p.first_name} {p.last_name}
                    {p.group_name && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
                        style={{ backgroundColor: p.group_color ?? '#6366f1' }}
                      >
                        {p.group_name}
                      </span>
                    )}
                  </div>
                  {p.sponsor_name && p.sponsor_id !== 1 && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: sponsorColor(p.sponsor_id) }} />
                      <span className="text-xs text-gray-400">via {p.sponsor_name}</span>
                    </div>
                  )}
                  {p.notes && <div className="text-xs text-gray-500 italic">{p.notes}</div>}
                </td>
                <td className="px-2 py-2 font-mono text-xs text-gray-300">
                  {p.member_id || '—'}
                </td>
                <td className="px-2 py-2 text-center text-xs">
                  <span className={p.badge_type === 'JUNIOR' ? 'text-blue-400' : 'text-gray-300'}>
                    {p.badge_type}
                  </span>
                </td>
                <td className="px-2 py-2 text-center">
                  <ReturnToggle p={p} secret={secret} eventId={event.id} onUpdate={onUpdate} />
                </td>
                <td className="px-2 py-2 text-center text-xs text-gray-400">
                  {DAY_KEYS.filter((d) => p[`req_${d}` as keyof Participant]).map((d) => d.slice(0, 2).toUpperCase()).join(' ')}
                </td>
                <td className="px-2 py-2 text-center text-xs">
                  {p.all_purchased ? (
                    <span className="text-green-400">All ✓</span>
                  ) : p.any_purchased ? (
                    <span className="text-yellow-400">
                      {DAY_KEYS.filter((d) => p[`pur_${d}` as keyof Participant]).map((d) => d.slice(0, 2).toUpperCase()).join(' ')}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-xs">
                  {p.purchase_total > 0 ? formatDollars(p.purchase_total) : '—'}
                </td>
                <td className="px-2 py-2 text-center">
                  <span className={`text-xs ${p.paid ? 'text-green-400' : 'text-gray-500'}`}>
                    {p.paid ? '✓' : '—'}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <button
                      onClick={() => setEditingId(p.id)}
                      className="text-xs text-gray-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-gray-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="text-xs text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-gray-700"
                    >
                      Del
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {copyOpen && (
        <CopyParticipantsModal
          event={event}
          secret={secret}
          allEvents={allEvents}
          onDone={() => { setCopyOpen(false); onUpdate(); }}
          onClose={() => setCopyOpen(false)}
        />
      )}

      {editingId !== null && (
        <EditParticipantModal
          participant={participants.find((p) => p.id === editingId)!}
          secret={secret}
          eventId={event.id}
          groups={groups}
          sponsors={sponsors}
          onSave={() => { setEditingId(null); onUpdate(); }}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

// ─── Sponsors Panel ───────────────────────────────────────────────────────────

function SponsorsPanel({
  secret, sponsors, onUpdate,
}: {
  secret: string;
  sponsors: Sponsor[];
  onUpdate: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!addName.trim()) return;
    setSaving(true);
    try {
      await api.admin.sponsors.create(secret, { name: addName.trim() });
      setAddName('');
      setAddOpen(false);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const handleEditSave = async (id: number) => {
    try {
      await api.admin.sponsors.update(secret, id, { name: editName.trim() });
      setEditingId(null);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (s: Sponsor) => {
    if (!confirm(`Delete sponsor "${s.name}"? Participants will be set to Unassigned.`)) return;
    try {
      await api.admin.sponsors.delete(secret, s.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const displaySponsors = sponsors.filter((s) => s.id !== 1);

  return (
    <div className="border-t border-gray-800 pt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Sponsors</span>
        <button
          onClick={() => setAddOpen(!addOpen)}
          className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-1.5 py-0.5 rounded"
        >
          +
        </button>
      </div>

      {addOpen && (
        <div className="flex items-center gap-1 mb-2">
          <input
            autoFocus
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAddOpen(false); }}
            placeholder="Name"
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-white text-xs focus:outline-none focus:border-blue-500"
          />
          <button onClick={handleAdd} disabled={saving} className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2 py-0.5 rounded">Add</button>
          <button onClick={() => setAddOpen(false)} className="text-xs text-gray-400 hover:text-white">✕</button>
        </div>
      )}

      <div className="space-y-0.5">
        {displaySponsors.map((s) => (
          editingId === s.id ? (
            <div key={s.id} className="flex items-center gap-1">
              <input
                autoFocus
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(s.id); if (e.key === 'Escape') setEditingId(null); }}
                className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-white text-xs focus:outline-none focus:border-blue-500"
              />
              <button onClick={() => handleEditSave(s.id)} className="text-xs text-green-400 hover:text-green-300">✓</button>
              <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
          ) : (
            <div key={s.id} className="flex items-center gap-1.5 group px-1 py-0.5 rounded hover:bg-gray-800">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sponsorColor(s.id) }} />
              <span className="text-xs text-gray-300 flex-1 truncate">{s.name}</span>
              <button onClick={() => { setEditingId(s.id); setEditName(s.name); }} className="text-gray-600 hover:text-white text-xs opacity-0 group-hover:opacity-100">✎</button>
              <button onClick={() => handleDelete(s)} className="text-gray-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100">✕</button>
            </div>
          )
        ))}
        {displaySponsors.length === 0 && !addOpen && (
          <p className="text-xs text-gray-600 italic px-1">None yet</p>
        )}
      </div>
    </div>
  );
}

// ─── Groups Panel ─────────────────────────────────────────────────────────────

function GroupsPanel({
  eventId, secret, groups, onUpdate,
}: {
  eventId: number;
  secret: string;
  groups: Group[];
  onUpdate: () => void;
}) {
  const [addingName, setAddingName] = useState('');
  const [addingColor, setAddingColor] = useState('#6366f1');
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [saving, setSaving] = useState(false);
  const dragSrc = useRef<number | null>(null);
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  const [localOrder, setLocalOrder] = useState<number[]>([]);

  useEffect(() => {
    setLocalOrder(groups.map((g) => g.id));
  }, [groups]);

  const orderedGroups = localOrder.length > 0
    ? (localOrder.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as Group[])
    : groups;

  const handleAdd = async () => {
    if (!addingName.trim()) return;
    setSaving(true);
    try {
      await api.admin.groups.create(secret, eventId, { name: addingName.trim(), color: addingColor });
      setAddingName('');
      setAddingColor('#6366f1');
      setAddOpen(false);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (g: Group) => {
    if (!confirm(`Delete group "${g.name}"? Participants will be unassigned.`)) return;
    try {
      await api.admin.groups.delete(secret, eventId, g.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const startEdit = (g: Group) => {
    setEditingId(g.id);
    setEditName(g.name);
    setEditColor(g.color);
  };

  const handleEditSave = async (g: Group) => {
    try {
      await api.admin.groups.update(secret, eventId, g.id, { name: editName, color: editColor });
      setEditingId(null);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const onDragStart = (id: number) => { dragSrc.current = id; };
  const onDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (dragSrc.current !== null && dragSrc.current !== id) setDragTarget(id);
  };
  const onDrop = async (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    const srcId = dragSrc.current;
    if (srcId === null || srcId === targetId) { dragSrc.current = null; setDragTarget(null); return; }
    const next = [...localOrder];
    const si = next.indexOf(srcId);
    const ti = next.indexOf(targetId);
    if (si !== -1 && ti !== -1) {
      next.splice(si, 1);
      next.splice(ti, 0, srcId);
      setLocalOrder(next);
      try {
        await api.admin.groups.reorder(secret, eventId, next);
        onUpdate();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Failed');
      }
    }
    dragSrc.current = null;
    setDragTarget(null);
  };
  const onDragEnd = () => { dragSrc.current = null; setDragTarget(null); };

  return (
    <div className="mb-4 p-3 bg-gray-900 border border-gray-700 rounded-xl">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">Groups</span>
        <button
          onClick={() => setAddOpen(!addOpen)}
          className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-0.5 rounded"
        >
          +
        </button>
      </div>

      {addOpen && (
        <div className="flex items-center gap-2 mb-2">
          <input
            autoFocus
            type="text"
            value={addingName}
            onChange={(e) => setAddingName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAddOpen(false); }}
            placeholder="Group name"
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500 w-36"
          />
          <input
            type="color"
            value={addingColor}
            onChange={(e) => setAddingColor(e.target.value)}
            className="w-7 h-7 rounded cursor-pointer border border-gray-600"
          />
          <button
            onClick={handleAdd}
            disabled={saving}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2 py-1 rounded"
          >
            Add
          </button>
          <button onClick={() => setAddOpen(false)} className="text-xs text-gray-400 hover:text-white">Cancel</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {orderedGroups.map((g) => (
          editingId === g.id ? (
            <div key={g.id} className="flex items-center gap-1">
              <input
                autoFocus
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(g); if (e.key === 'Escape') setEditingId(null); }}
                className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-white text-xs focus:outline-none focus:border-blue-500 w-28"
              />
              <input
                type="color"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                className="w-6 h-6 rounded cursor-pointer border border-gray-600"
              />
              <button onClick={() => handleEditSave(g)} className="text-xs text-green-400 hover:text-green-300">✓</button>
              <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
          ) : (
            <div
              key={g.id}
              draggable
              onDragStart={() => onDragStart(g.id)}
              onDragOver={(e) => onDragOver(e, g.id)}
              onDrop={(e) => onDrop(e, g.id)}
              onDragEnd={onDragEnd}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs text-white font-medium cursor-grab ${
                dragTarget === g.id ? 'ring-2 ring-blue-400' : ''
              }`}
              style={{ backgroundColor: g.color }}
            >
              <button onClick={() => startEdit(g)} className="hover:opacity-80">{g.name}</button>
              <button
                onClick={() => handleDelete(g)}
                className="ml-0.5 opacity-70 hover:opacity-100 text-white"
                title="Delete group"
              >
                ✕
              </button>
            </div>
          )
        ))}
        {groups.length === 0 && !addOpen && (
          <span className="text-xs text-gray-600 italic">No groups yet — click + to add one</span>
        )}
      </div>
    </div>
  );
}

function ReturnToggle({
  p, secret, eventId, onUpdate,
}: { p: Participant; secret: string; eventId: number; onUpdate: () => void }) {
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    setLoading(true);
    try {
      await api.admin.participants.update(secret, eventId, p.id, { return_eligible: !p.return_eligible });
      onUpdate();
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`text-xs px-2 py-0.5 rounded ${
        p.return_eligible ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'
      }`}
    >
      {p.return_eligible ? '✓ Ret' : '○'}
    </button>
  );
}

function EditParticipantModal({
  participant, secret, eventId, groups, sponsors, onSave, onClose,
}: {
  participant: Participant;
  secret: string;
  eventId: number;
  groups: Group[];
  sponsors: Sponsor[];
  onSave: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Partial<Participant>>(participant);

  const handleSave = async () => {
    try {
      await api.admin.participants.update(secret, eventId, participant.id, form);
      onSave();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-white">Edit Participant</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <ParticipantForm value={form} onChange={setForm} showAdminFields groups={groups} sponsors={sponsors} />
        <div className="flex gap-2 mt-4">
          <button onClick={handleSave} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded">
            Save
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white px-4">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ParticipantForm({
  value, onChange, showAdminFields = false, groups = [], sponsors = [],
}: {
  value: Partial<Participant>;
  onChange: (v: Partial<Participant>) => void;
  showAdminFields?: boolean;
  groups?: Group[];
  sponsors?: Sponsor[];
}) {
  const set = (key: keyof Participant, val: unknown) => onChange({ ...value, [key]: val });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="First Name">
          <input type="text" value={value.first_name ?? ''} onChange={(e) => set('first_name', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Last Name">
          <input type="text" value={value.last_name ?? ''} onChange={(e) => set('last_name', e.target.value)} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Member ID">
          <input type="text" value={value.member_id ?? ''} onChange={(e) => set('member_id', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Badge Type">
          <select value={value.badge_type ?? 'ADULT'} onChange={(e) => set('badge_type', e.target.value)} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Junior / Military / Senior</option>
          </select>
        </Field>
      </div>
      <Field label="Sponsor">
        <select
          value={value.sponsor_id ?? 1}
          onChange={(e) => set('sponsor_id', Number(e.target.value))}
          className={inputCls}
        >
          {sponsors.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          {sponsors.length === 0 && <option value={1}>Unassigned</option>}
        </select>
      </Field>
      {groups.length > 0 && (
        <Field label="Group">
          <select
            value={value.group_id ?? ''}
            onChange={(e) => set('group_id', e.target.value === '' ? null : Number(e.target.value))}
            className={inputCls}
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Requested Days">
        <div className="flex flex-wrap gap-3">
          {DAY_KEYS.map((day) => (
            <label key={day} className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-300">
              <input
                type="checkbox"
                checked={Boolean(value[`req_${day}` as keyof Participant])}
                onChange={(e) => set(`req_${day}` as keyof Participant, e.target.checked)}
                className="accent-blue-500"
              />
              {dayLabel(day)}
            </label>
          ))}
        </div>
      </Field>
      {showAdminFields && (
        <>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
            <input
              type="checkbox" checked={Boolean(value.return_eligible)}
              onChange={(e) => set('return_eligible', e.target.checked)} className="accent-green-500"
            />
            Return Eligible
          </label>
          <Field label="Notes">
            <input type="text" value={value.notes ?? ''} onChange={(e) => set('notes', e.target.value)} className={inputCls} />
          </Field>
        </>
      )}
    </div>
  );
}

// ─── Prices Tab ───────────────────────────────────────────────────────────────

function PricesTab({
  event, activeRegType, returnEvent, openEvent, onRegTypeChange,
  secret, onUpdate,
}: {
  event: EventDetail | null;
  activeRegType: 'return' | 'open';
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  onRegTypeChange: (t: 'return' | 'open') => void;
  secret: string;
  onUpdate: () => void;
}) {
  const priceFields = [
    { key: 'price_preview_adult', label: 'Preview Night — Adult' },
    { key: 'price_thu_adult', label: 'Thursday — Adult' },
    { key: 'price_fri_adult', label: 'Friday — Adult' },
    { key: 'price_sat_adult', label: 'Saturday — Adult' },
    { key: 'price_sun_adult', label: 'Sunday — Adult' },
    { key: 'price_preview_junior', label: 'Preview Night — Junior / Military / Senior' },
    { key: 'price_thu_junior', label: 'Thursday — Junior / Military / Senior' },
    { key: 'price_fri_junior', label: 'Friday — Junior / Military / Senior' },
    { key: 'price_sat_junior', label: 'Saturday — Junior / Military / Senior' },
    { key: 'price_sun_junior', label: 'Sunday — Junior / Military / Senior' },
  ] as const;

  const centsToDollars = (c: number) => (c / 100).toFixed(2);
  const dollarsToCents = (d: string) => Math.round(parseFloat(d || '0') * 100);

  const [values, setValues] = useState<Record<string, string>>(
    event
      ? Object.fromEntries(priceFields.map(({ key }) => [key, centsToDollars(event[key] as number)]))
      : {}
  );
  const [saved, setSaved] = useState(false);

  // Reset when event changes
  useEffect(() => {
    if (event) setValues(Object.fromEntries(priceFields.map(({ key }) => [key, centsToDollars(event[key] as number)])));
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!event) return <div className="text-gray-500">No event for this registration type.</div>;

  const handleSave = async () => {
    const patch = Object.fromEntries(priceFields.map(({ key }) => [key, dollarsToCents(values[key])]));
    try {
      await api.admin.events.update(secret, event.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <EventToggle returnEvent={returnEvent} openEvent={openEvent} active={activeRegType} onChange={onRegTypeChange} />
      <div className="max-w-sm">
        <h3 className="font-semibold text-gray-200 mb-4">Badge Prices</h3>
        <div className="space-y-3">
          {priceFields.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <label className="text-sm text-gray-300 flex-1">{label}</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  className="bg-gray-800 border border-gray-600 rounded pl-7 pr-3 py-1.5 text-white text-sm w-28 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={handleSave}
          className="mt-5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-6 py-2 rounded transition-colors"
        >
          {saved ? 'Saved ✓' : 'Save Prices'}
        </button>
      </div>
    </div>
  );
}

// ─── Dates Tab ────────────────────────────────────────────────────────────────

type DateFields = Omit<YearMeta, 'year' | 'created_at' | 'updated_at'>;

const EMPTY_DATES: DateFields = {
  return_reg_start: '', return_reg_end: '',
  open_reg_start: '', open_reg_end: '',
  address_deadline: '', hotel_deadline: '',
  preview_date: '', thu_date: '', fri_date: '', sat_date: '', sun_date: '',
  notes: '',
};

function DatesTab({
  year, secret, meta, onUpdate,
}: {
  year: number;
  secret: string;
  meta: YearMeta | null;
  onUpdate: () => void;
}) {
  const [form, setForm] = useState<DateFields>(meta ? { ...EMPTY_DATES, ...meta } : EMPTY_DATES);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(meta ? { ...EMPTY_DATES, ...meta } : EMPTY_DATES);
  }, [meta]);

  const set = (k: keyof DateFields, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    try {
      await api.admin.yearMeta.upsert(secret, year, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const DateInput = ({ label, field }: { label: string; field: keyof DateFields }) => (
    <div className="flex items-center gap-3">
      <label className="text-sm text-gray-300 w-52 shrink-0">{label}</label>
      <input
        type="date"
        value={form[field]}
        onChange={(e) => set(field, e.target.value)}
        className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div className="max-w-2xl space-y-8">
      {/* Registration dates */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-4">Registration Dates</h3>
        <div className="space-y-3">
          <DateInput label="Return Registration" field="return_reg_start" />
          <DateInput label="Open Registration" field="open_reg_start" />
        </div>
      </div>

      {/* Deadlines */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-4">Deadlines</h3>
        <div className="space-y-3">
          <DateInput label="Address Deadline" field="address_deadline" />
          <DateInput label="Hotel Deadline" field="hotel_deadline" />
        </div>
      </div>

      {/* Event schedule */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-4">Event Schedule</h3>
        <div className="space-y-3">
          <DateInput label="Preview Night" field="preview_date" />
          <DateInput label="Thursday" field="thu_date" />
          <DateInput label="Friday" field="fri_date" />
          <DateInput label="Saturday" field="sat_date" />
          <DateInput label="Sunday" field="sun_date" />
        </div>
      </div>

      {/* Notes */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-3">Notes</h3>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={3}
          placeholder="Any notes for this year…"
          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      <button
        onClick={handleSave}
        className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-8 py-2.5 rounded transition-colors"
      >
        {saved ? 'Saved ✓' : 'Save Dates'}
      </button>
    </div>
  );
}

// ─── Access Token Section ─────────────────────────────────────────────────────

function AccessTokenSection({
  event, secret, onUpdate, compact = false,
}: { event: EventDetail; secret: string; onUpdate: () => void; compact?: boolean }) {
  const [token, setToken] = useState(event.access_token ?? '');
  const [regenerating, setRegenerating] = useState(false);

  const handleRegenerate = async () => {
    if (!confirm('Regenerate token? Existing links will stop working.')) return;
    setRegenerating(true);
    try {
      const res = await api.admin.events.regenerateToken(secret, event.id);
      setToken(res.access_token);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className={compact ? '' : 'bg-gray-900 border border-gray-700 rounded-xl p-5'}>
      {!compact && (
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Access Token</h3>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="text-xs text-gray-500 hover:text-red-400 disabled:opacity-50 transition-colors"
          >
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      )}
      {!token && (
        <p className="text-yellow-400 text-xs mb-2">⚠ No token — click Regenerate.</p>
      )}
      {compact ? (
        <div className="flex gap-1.5 items-center">
          <code className="bg-gray-800 text-gray-400 text-xs px-2 py-1 rounded flex-1 truncate">
            {token ? `…${token.slice(-8)}` : 'no token'}
          </code>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="text-xs text-gray-500 hover:text-red-400 shrink-0"
          >
            ↻
          </button>
        </div>
      ) : (
        <div className="flex gap-2 items-center">
          <code className="bg-gray-800 text-green-400 text-xs px-3 py-2 rounded flex-1 break-all">{token}</code>
          <button
            onClick={() => navigator.clipboard.writeText(token)}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Copy / Transfer Modal ────────────────────────────────────────────────────

function CopyParticipantsModal({
  event, secret, allEvents, onDone, onClose,
}: {
  event: EventDetail;
  secret: string;
  allEvents: EventDetail[];
  onDone: () => void;
  onClose: () => void;
}) {
  const otherEvents = allEvents.filter((e) => e.id !== event.id);
  const [targetId, setTargetId] = useState<number>(otherEvents[0]?.id ?? 0);
  const [mode, setMode] = useState<'copy' | 'transfer'>('copy');
  const [resetPurchasing, setResetPurchasing] = useState(true);
  const [carryover, setCarryover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');

  const handleConfirm = async () => {
    if (!targetId) { alert('Select a target event'); return; }
    const target = allEvents.find((e) => e.id === targetId);
    const action = mode === 'transfer' ? 'transfer' : 'copy';
    if (!confirm(`${action === 'transfer' ? 'Move' : 'Copy'} all ${event.name} participants to ${target?.name}?`)) return;
    setLoading(true);
    try {
      const res = await api.admin.participants.copy(secret, event.id, {
        target_event_id: targetId,
        reset_purchasing: resetPurchasing,
        transfer: mode === 'transfer',
        carryover,
      });
      setResult(`✓ ${action === 'transfer' ? 'Transferred' : 'Copied'} ${res.copied} participants`);
      setTimeout(onDone, 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-5">
          <h3 className="font-bold text-white">Copy / Transfer Participants</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <div className="text-sm text-gray-200 bg-gray-800 border border-gray-600 rounded px-3 py-2">{event.name}</div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(Number(e.target.value))}
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              {otherEvents.map((e) => (
                <option key={e.id} value={e.id}>{e.name} ({e.reg_type} / {e.status})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2">Action</label>
            <div className="flex gap-3">
              {(['copy', 'transfer'] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                  <input
                    type="radio" name="mode" value={m} checked={mode === m}
                    onChange={() => { setMode(m); setResetPurchasing(m === 'copy'); }}
                    className="accent-blue-500"
                  />
                  <span className="capitalize">{m}</span>
                  <span className="text-gray-500 text-xs">
                    {m === 'copy' ? '(keep originals)' : '(remove from source)'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
            <input
              type="checkbox" checked={resetPurchasing}
              onChange={(e) => setResetPurchasing(e.target.checked)}
              className="accent-blue-500"
            />
            Reset purchasing history (coordinator, purchased days, payment)
          </label>

          <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
            <input
              type="checkbox" checked={carryover}
              onChange={(e) => setCarryover(e.target.checked)}
              className="accent-blue-500 mt-0.5"
            />
            <span>
              Carry gap days only
              <span className="block text-xs text-gray-500 mt-0.5">
                Sets requested days to only the unfulfilled gaps from source (for Return → Open Reg handoff)
              </span>
            </span>
          </label>

          {result && <p className="text-green-400 text-sm">{result}</p>}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={handleConfirm}
            disabled={loading || !targetId}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded text-sm font-medium transition-colors"
          >
            {loading ? 'Working…' : mode === 'transfer' ? 'Transfer All' : 'Copy All'}
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white px-4 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Invite Requests Panel ────────────────────────────────────────────────────

function InviteRequestsPanel({
  secret, requests, onUpdate,
}: {
  secret: string;
  requests: InviteRequest[];
  onUpdate: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [editingNotes, setEditingNotes] = useState<{ id: number; value: string } | null>(null);

  const visible = filter === 'all' ? requests : requests.filter((r) => r.status === filter);

  const pending = requests.filter((r) => r.status === 'pending').length;
  const approved = requests.filter((r) => r.status === 'approved').length;
  const rejected = requests.filter((r) => r.status === 'rejected').length;

  const setStatus = async (id: number, status: InviteRequest['status']) => {
    try {
      await api.admin.inviteRequests.update(secret, id, { status });
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveNotes = async (id: number, admin_notes: string) => {
    try {
      await api.admin.inviteRequests.update(secret, id, { admin_notes });
      setEditingNotes(null);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (r: InviteRequest) => {
    if (!confirm(`Delete request from ${r.email}?`)) return;
    try {
      await api.admin.inviteRequests.delete(secret, r.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const statusChip = (s: InviteRequest['status']) => {
    const styles = {
      pending:  'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
      approved: 'bg-green-900/50 text-green-300 border border-green-700',
      rejected: 'bg-red-900/50 text-red-300 border border-red-700',
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[s]}`}>{s}</span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-white">Invite Requests</h2>
        <div className="flex gap-2 text-xs text-gray-400">
          <span className="text-yellow-400 font-bold">{pending} pending</span>
          <span>·</span>
          <span className="text-green-400">{approved} approved</span>
          <span>·</span>
          <span className="text-red-400">{rejected} rejected</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-5">
        {(['pending', 'approved', 'rejected', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
              filter === f ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-gray-500 text-sm">No {filter === 'all' ? '' : filter + ' '}requests.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((r) => (
            <div key={r.id} className="bg-gray-900 border border-gray-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-medium text-sm">{r.email}</span>
                    {statusChip(r.status)}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    via <span className="text-gray-200">{r.referred_by || '—'}</span>
                    <span className="mx-1.5 text-gray-600">·</span>
                    {new Date(r.created_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(r)}
                  className="text-gray-600 hover:text-red-400 text-xs shrink-0"
                >
                  Delete
                </button>
              </div>

              {r.notes && (
                <p className="text-xs text-gray-400 italic bg-gray-800 rounded px-3 py-2 mb-2">"{r.notes}"</p>
              )}

              {/* Admin notes */}
              {editingNotes?.id === r.id ? (
                <div className="flex gap-2 mb-2">
                  <input
                    autoFocus
                    type="text"
                    value={editingNotes.value}
                    onChange={(e) => setEditingNotes({ id: r.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveNotes(r.id, editingNotes.value);
                      if (e.key === 'Escape') setEditingNotes(null);
                    }}
                    placeholder="Admin notes…"
                    className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                  />
                  <button onClick={() => saveNotes(r.id, editingNotes.value)} className="text-xs text-green-400 hover:text-green-300">Save</button>
                  <button onClick={() => setEditingNotes(null)} className="text-xs text-gray-400 hover:text-white">Cancel</button>
                </div>
              ) : r.admin_notes ? (
                <button
                  onClick={() => setEditingNotes({ id: r.id, value: r.admin_notes })}
                  className="text-xs text-gray-500 italic mb-2 hover:text-gray-300 text-left w-full"
                >
                  Note: {r.admin_notes}
                </button>
              ) : (
                <button
                  onClick={() => setEditingNotes({ id: r.id, value: '' })}
                  className="text-xs text-gray-600 hover:text-gray-400 mb-2"
                >
                  + Add note
                </button>
              )}

              {/* Actions */}
              <div className="flex gap-1.5">
                {r.status !== 'approved' && (
                  <button
                    onClick={() => setStatus(r.id, 'approved')}
                    className="text-xs bg-green-800 hover:bg-green-700 text-green-200 px-3 py-1 rounded transition-colors"
                  >
                    Approve
                  </button>
                )}
                {r.status !== 'rejected' && (
                  <button
                    onClick={() => setStatus(r.id, 'rejected')}
                    className="text-xs bg-red-900 hover:bg-red-800 text-red-300 px-3 py-1 rounded transition-colors"
                  >
                    Reject
                  </button>
                )}
                {r.status !== 'pending' && (
                  <button
                    onClick={() => setStatus(r.id, 'pending')}
                    className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 px-3 py-1 rounded transition-colors"
                  >
                    Reset to Pending
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500';


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
