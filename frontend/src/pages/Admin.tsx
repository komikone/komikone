import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type EventDetail,
  type Participant,
  type Coordinator,
  type YearMeta,
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
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [activeRegType, setActiveRegType] = useState<'return' | 'open'>('return');

  // Per-event data — always store both so Overview can show both
  const [returnParticipants, setReturnParticipants] = useState<Participant[]>([]);
  const [openParticipants, setOpenParticipants] = useState<Participant[]>([]);
  const [returnCoordinators, setReturnCoordinators] = useState<Coordinator[]>([]);
  const [openCoordinators, setOpenCoordinators] = useState<Coordinator[]>([]);
  const [yearMeta, setYearMeta] = useState<YearMeta | null>(null);

  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'participants' | 'coordinators' | 'prices' | 'dates'>('overview');

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
  const coordinators = activeRegType === 'return' ? returnCoordinators : openCoordinators;

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

  const reloadAll = useCallback(async (year?: number) => {
    const fresh = await loadEvents();
    const yr = year ?? selectedYear;
    if (yr !== null) loadYearData(yr, fresh);
  }, [loadEvents, loadYearData, selectedYear]);

  const loadYearData = useCallback(async (year: number, evts: EventDetail[]) => {
    const retEvt = evts.find((e) => e.year === year && e.reg_type === 'return');
    const openEvt = evts.find((e) => e.year === year && e.reg_type === 'open');

    const [retPs, openPs, retCs, openCs, meta] = await Promise.all([
      retEvt ? api.participants.list(retEvt.id, retEvt.access_token).catch(() => []) : Promise.resolve([]),
      openEvt ? api.participants.list(openEvt.id, openEvt.access_token).catch(() => []) : Promise.resolve([]),
      retEvt ? api.coordinators.list(retEvt.id, retEvt.access_token).catch(() => []) : Promise.resolve([]),
      openEvt ? api.coordinators.list(openEvt.id, openEvt.access_token).catch(() => []) : Promise.resolve([]),
      api.admin.yearMeta.get(secret, year).catch(() => null),
    ]);
    setReturnParticipants(retPs);
    setOpenParticipants(openPs);
    setReturnCoordinators(retCs);
    setOpenCoordinators(openCs);
    setYearMeta(meta);
  }, [secret]);

  const reloadEventData = useCallback(async (regType: 'return' | 'open', evts: EventDetail[], year: number) => {
    const evt = evts.find((e) => e.year === year && e.reg_type === regType);
    if (!evt) return;
    const [ps, cs] = await Promise.all([
      api.participants.list(evt.id, evt.access_token).catch(() => []),
      api.coordinators.list(evt.id, evt.access_token).catch(() => []),
    ]);
    if (regType === 'return') { setReturnParticipants(ps); setReturnCoordinators(cs); }
    else { setOpenParticipants(ps); setOpenCoordinators(cs); }
  }, []);

  useEffect(() => {
    if (authed) loadEvents();
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
      {/* Sidebar */}
      <aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-gray-800">
          <Link to="/" className="text-gray-500 hover:text-yellow-400 text-xs uppercase tracking-wider">← Public site</Link>
          <h1 className="font-bangers text-yellow-400 text-xl tracking-wide mt-1">komikone</h1>
        </div>

        {/* Year list */}
        <div className="px-3 py-3 border-b border-gray-800 overflow-y-auto">
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

        {/* Views */}
        {selectedYear !== null && (
          <div className="px-3 py-3">
            <div className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Views</div>
            {(['overview', 'participants', 'coordinators', 'prices', 'dates'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm mb-0.5 transition-colors capitalize ${
                  tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {selectedYear === null ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {loading ? 'Loading…' : 'Select or initialize a year'}
          </div>
        ) : (
          <div className="p-6">
            {/* Year header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">SDCC {selectedYear}</h2>
                <p className="text-sm text-gray-400">
                  {[returnEvent && 'Return Reg', openEvent && 'Open Reg'].filter(Boolean).join(' + ')}
                </p>
              </div>
              <div className="flex gap-2">
                {activeEvent && (
                  <>
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
                  </>
                )}
              </div>
            </div>

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
                onUpdate={() => { if (selectedYear) reloadEventData(activeRegType, events, selectedYear); }}
              />
            )}
            {tab === 'coordinators' && (
              <CoordinatorsTab
                event={activeEvent}
                activeRegType={activeRegType}
                returnEvent={returnEvent}
                openEvent={openEvent}
                onRegTypeChange={handleRegTypeSwitch}
                secret={secret}
                coordinators={coordinators}
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
  secret, participants, allEvents, onUpdate,
}: {
  event: EventDetail | null;
  activeRegType: 'return' | 'open';
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  onRegTypeChange: (t: 'return' | 'open') => void;
  secret: string;
  participants: Participant[];
  allEvents: EventDetail[];
  onUpdate: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [newParticipant, setNewParticipant] = useState<Partial<Participant>>({ badge_type: 'ADULT' });

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

  const handleMoveUp = async (_p: Participant, idx: number) => {
    if (idx === 0) return;
    const newOrder = [...participants];
    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
    try {
      await api.admin.participants.reorder(secret, event.id, newOrder.map((x) => x.id));
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleMoveDown = async (_p: Participant, idx: number) => {
    if (idx === participants.length - 1) return;
    const newOrder = [...participants];
    [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
    try {
      await api.admin.participants.reorder(secret, event.id, newOrder.map((x) => x.id));
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

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

      {addOpen && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-4">
          <h4 className="font-medium text-gray-200 mb-3">New Participant</h4>
          <ParticipantForm value={newParticipant} onChange={setNewParticipant} coordinatorNames={[]} />
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
              <th className="px-2 py-2 text-left w-12">Sort</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Member ID</th>
              <th className="px-2 py-2 text-center">Type</th>
              <th className="px-2 py-2 text-center">Ret.</th>
              <th className="px-2 py-2 text-center">Requested</th>
              <th className="px-2 py-2 text-left">Coordinator</th>
              <th className="px-2 py-2 text-center">Purchased</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-center">Paid</th>
              <th className="px-2 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {participants.map((p, idx) => (
              <tr key={p.id} className={`hover:bg-gray-900/50 ${p.all_purchased ? 'opacity-70' : ''}`}>
                <td className="px-2 py-2">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => handleMoveUp(p, idx)} className="text-gray-500 hover:text-white text-xs leading-none">▲</button>
                    <span className="text-gray-500 text-xs text-center">{idx + 1}</span>
                    <button onClick={() => handleMoveDown(p, idx)} className="text-gray-500 hover:text-white text-xs leading-none">▼</button>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="text-white font-medium">{p.first_name} {p.last_name}</div>
                  {p.sponsor && <div className="text-xs text-gray-500">via {p.sponsor}</div>}
                  {p.notes && <div className="text-xs text-gray-500 italic">{p.notes}</div>}
                </td>
                <td className="px-2 py-2 font-mono text-xs text-gray-300">{p.member_id || '—'}</td>
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
                <td className="px-2 py-2 text-xs text-gray-300">{p.purchasing_coordinator || '—'}</td>
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
          onSave={() => { setEditingId(null); onUpdate(); }}
          onClose={() => setEditingId(null)}
        />
      )}
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
  participant, secret, eventId, onSave, onClose,
}: {
  participant: Participant;
  secret: string;
  eventId: number;
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
        <ParticipantForm value={form} onChange={setForm} coordinatorNames={[]} showAdminFields />
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
  value, onChange, coordinatorNames, showAdminFields = false,
}: {
  value: Partial<Participant>;
  onChange: (v: Partial<Participant>) => void;
  coordinatorNames: string[];
  showAdminFields?: boolean;
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
      <div className="grid grid-cols-2 gap-2">
        <Field label="Sponsor">
          <input type="text" value={value.sponsor ?? ''} onChange={(e) => set('sponsor', e.target.value)} className={inputCls} />
        </Field>
        {showAdminFields && (
          <Field label="Coordinator">
            <input
              type="text" value={value.purchasing_coordinator ?? ''}
              onChange={(e) => set('purchasing_coordinator', e.target.value)}
              list="coord-names" className={inputCls}
            />
            <datalist id="coord-names">
              {coordinatorNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Field>
        )}
      </div>
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

// ─── Coordinators Tab ─────────────────────────────────────────────────────────

function CoordinatorsTab({
  event, activeRegType, returnEvent, openEvent, onRegTypeChange,
  secret, coordinators, onUpdate,
}: {
  event: EventDetail | null;
  activeRegType: 'return' | 'open';
  returnEvent: EventDetail | null;
  openEvent: EventDetail | null;
  onRegTypeChange: (t: 'return' | 'open') => void;
  secret: string;
  coordinators: Coordinator[];
  onUpdate: () => void;
}) {
  const [newName, setNewName] = useState('');

  if (!event) return <div className="text-gray-500">No event for this registration type.</div>;

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await api.admin.coordinators.add(secret, event.id, { name: newName.trim() });
      setNewName('');
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (c: Coordinator) => {
    if (!confirm(`Remove ${c.name}?`)) return;
    try {
      await api.admin.coordinators.delete(secret, event.id, c.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <EventToggle returnEvent={returnEvent} openEvent={openEvent} active={activeRegType} onChange={onRegTypeChange} />

      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-5">
        <h3 className="font-semibold text-gray-200 mb-3">Add Coordinator</h3>
        <div className="flex gap-2">
          <input
            type="text" placeholder="Name" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <button onClick={handleAdd} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded transition-colors">
            Add
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {coordinators.map((c) => (
          <div key={c.id} className="bg-gray-900 border border-gray-700 rounded-xl p-4 flex items-center justify-between">
            <div>
              <div className="text-white font-medium">{c.name}</div>
              <div className="flex gap-3 mt-1 text-xs text-gray-400">
                {c.venmo && <span>Venmo: {c.venmo}</span>}
                {c.zelle && <span>Zelle: {c.zelle}</span>}
                {c.paypal && <span>PayPal: {c.paypal}</span>}
                {c.phone_last4 && <span>Phone: ...{c.phone_last4}</span>}
                {!c.venmo && !c.zelle && !c.paypal && (
                  <span className="text-gray-600 italic">No payment info yet</span>
                )}
              </div>
            </div>
            <button onClick={() => handleDelete(c)} className="text-gray-500 hover:text-red-400 text-sm ml-4">
              Remove
            </button>
          </div>
        ))}
        {coordinators.length === 0 && (
          <p className="text-gray-500 text-sm">No coordinators added yet.</p>
        )}
      </div>
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

  const DateRange = ({ label, startField, endField }: { label: string; startField: keyof DateFields; endField: keyof DateFields }) => (
    <div className="flex items-center gap-3">
      <label className="text-sm text-gray-300 w-52 shrink-0">{label}</label>
      <input
        type="date" value={form[startField]}
        onChange={(e) => set(startField, e.target.value)}
        className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
      />
      <span className="text-gray-500 text-sm">to</span>
      <input
        type="date" value={form[endField]}
        onChange={(e) => set(endField, e.target.value)}
        className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div className="max-w-2xl space-y-8">
      {/* Registration windows */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-200 mb-4">Registration Windows</h3>
        <div className="space-y-3">
          <DateRange label="Return Registration" startField="return_reg_start" endField="return_reg_end" />
          <DateRange label="Open Registration" startField="open_reg_start" endField="open_reg_end" />
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
