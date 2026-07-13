import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { invalidateBackgroundCache } from '../lib/useBackgrounds';
import {
  api,
  type EventDetail,
  type Participant,
  type YearMeta,
  type Group,
  type Year,
  type YearMember,
  type Invite,
  type InviteRequest,
  type Background,
  formatDollars,
  DAY_KEYS,
  dayLabel,
} from '../lib/api';
import { MemberId, normalizeMemberIdInput } from '../components/MemberId';
import { AppHeader } from '../components/AppHeader';
import { ToggleSwitch } from '../components/ToggleSwitch';

const STATUS_OPTIONS: EventDetail['status'][] = ['setup', 'registration', 'purchasing', 'payment', 'complete'];

// ─── Admin ────────────────────────────────────────────────────────────────────

export default function Admin() {
  const { getToken } = useAuth();
  const { user, isLoaded: userLoaded } = useUser();
  const [secret, setSecret] = useState('');

  const [events, setEvents] = useState<EventDetail[]>([]);
  const [yearsData, setYearsData] = useState<Year[]>([]);
  const [yearInvites, setYearInvites] = useState<Invite[]>([]);
  const [invitePanelInvites, setInvitePanelInvites] = useState<Invite[]>([]);
  const [yearMembers, setYearMembers] = useState<YearMember[]>([]);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [activeRegType, setActiveRegType] = useState<'return' | 'open'>('return');

  // Per-event data — always store both so Overview can show both
  const [returnParticipants, setReturnParticipants] = useState<Participant[]>([]);
  const [openParticipants, setOpenParticipants] = useState<Participant[]>([]);
  const [yearMeta, setYearMeta] = useState<YearMeta | null>(null);

  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'people' | 'prices' | 'dates' | 'settings'>('overview');
  const [adminView, setAdminView] = useState<'year' | 'requests' | 'backgrounds' | 'invites'>('year');
  const [invitePanelYearId, setInvitePanelYearId] = useState<number | null>(null);
  const [accessRequests, setAccessRequests] = useState<InviteRequest[]>([]);

  // Derived — prefer events linked to the years row (year_id) so orphan duplicates are ignored
  const years = useMemo(
    () => [...new Set(events.map((e) => e.year).filter((y): y is number => y != null))].sort((a, b) => b - a),
    [events]
  );
  const activeYear = yearsData.find((y) => y.con_year === selectedYear) ?? null;
  const yearEvents = useMemo(() => {
    if (selectedYear == null) return [];
    if (activeYear) {
      const linked = events.filter((e) => e.year_id === activeYear.id);
      if (linked.length > 0) return linked;
    }
    // Fallback: lowest id per reg_type when year_id is missing (older DBs)
    const forYear = events.filter((e) => e.year === selectedYear);
    const pick = (reg: 'return' | 'open') =>
      [...forYear.filter((e) => e.reg_type === reg)].sort((a, b) => a.id - b.id)[0];
    return [pick('return'), pick('open')].filter(Boolean) as EventDetail[];
  }, [events, selectedYear, activeYear]);
  const returnEvent = yearEvents.find((e) => e.reg_type === 'return') ?? null;
  const openEvent = yearEvents.find((e) => e.reg_type === 'open') ?? null;
  const activeEvent = yearEvents.find((e) => e.reg_type === activeRegType) ?? yearEvents[0] ?? null;
  const participants = activeRegType === 'return' ? returnParticipants : openParticipants;

  const getAuth = useCallback(async (): Promise<string> => {
    const t = await getToken({ template: 'komikone' }) ?? await getToken() ?? '';
    if (t) setSecret(t);
    return t;
  }, [getToken]);

  const loadEvents = useCallback(async (): Promise<EventDetail[]> => {
    const tok = await getAuth();
    if (!tok) return [];
    setLoading(true);
    try {
      const summaries = await api.events.list();
      const detailed = await Promise.all(summaries.map((s) => api.admin.events.getWithToken(tok, s.id)));
      setEvents(detailed);
      return detailed;
    } catch (e) {
      console.error(e);
      return [];
    } finally {
      setLoading(false);
    }
  }, [getAuth]);

  const loadYearData = useCallback(async (year: number, evts: EventDetail[], yearRow?: Year | null) => {
    const tok = await getAuth();
    if (!tok) return;
    const linked = yearRow ? evts.filter((e) => e.year_id === yearRow.id) : [];
    const pool = linked.length > 0 ? linked : evts.filter((e) => e.year === year);
    const byId = (reg: 'return' | 'open') =>
      [...pool.filter((e) => e.reg_type === reg)].sort((a, b) => a.id - b.id)[0];
    const retEvt = byId('return');
    const openEvt = byId('open');

    const [retPs, openPs, meta] = await Promise.all([
      retEvt ? api.participants.list(retEvt.id, tok, { includeIneligible: true }).catch(() => []) : Promise.resolve([]),
      openEvt ? api.participants.list(openEvt.id, tok, { includeIneligible: true }).catch(() => []) : Promise.resolve([]),
      api.admin.yearMeta.get(tok, year).catch(() => null),
    ]);
    setReturnParticipants(retPs);
    setOpenParticipants(openPs);
    setYearMeta(meta);
  }, [getAuth]);

  const reloadEventData = useCallback(async (regType: 'return' | 'open', evts: EventDetail[], year: number) => {
    const tok = await getAuth();
    if (!tok) return;
    const evt = evts.find((e) => e.year === year && e.reg_type === regType);
    if (!evt) return;
    const ps = await api.participants.list(evt.id, tok, { includeIneligible: true }).catch(() => []);
    if (regType === 'return') setReturnParticipants(ps);
    else setOpenParticipants(ps);
  }, [getAuth]);

  const loadYearsData = useCallback(async (): Promise<Year[]> => {
    const tok = await getAuth();
    if (!tok) return [];
    try {
      const ys = await api.admin.years.list(tok);
      setYearsData(ys);
      return ys;
    } catch { return []; }
  }, [getAuth]);

  const loadYearExtras = useCallback(async (yearObj: Year) => {
    const tok = await getAuth();
    if (!tok) return;
    const [invs, mems] = await Promise.all([
      api.admin.invites.list(tok, yearObj.id).catch(() => []),
      api.admin.members.list(tok, yearObj.id).catch(() => []),
    ]);
    setYearInvites(invs);
    setYearMembers(mems);
  }, [getAuth]);

  const loadInvitePanel = useCallback(async (yearObj: Year) => {
    const tok = await getAuth();
    if (!tok) return;
    const invs = await api.admin.invites.list(tok, yearObj.id).catch(() => []);
    setInvitePanelInvites(invs);
  }, [getAuth]);

  const loadAccessRequests = useCallback(async () => {
    const tok = await getAuth();
    if (!tok) return;
    try {
      const list = await api.admin.inviteRequests.list(tok);
      setAccessRequests(list);
    } catch {
      setAccessRequests([]);
    }
  }, [getAuth]);

  const reloadAll = useCallback(async (year?: number) => {
    const [fresh, freshYears] = await Promise.all([loadEvents(), loadYearsData()]);
    const yr = year ?? selectedYear;
    if (yr !== null) {
      const yearObj = freshYears.find((y) => y.con_year === yr) ?? null;
      loadYearData(yr, fresh, yearObj);
      if (yearObj) loadYearExtras(yearObj);
    }
  }, [loadEvents, loadYearsData, loadYearData, loadYearExtras, selectedYear]);

  const handleYearDeleted = useCallback(async (deletedConYear: number) => {
    const [freshEvents, freshYears] = await Promise.all([loadEvents(), loadYearsData()]);
    const remaining = [...new Set(freshEvents.map((e) => e.year))].sort((a, b) => b - a);
    const nextYear = remaining.find((y) => y !== deletedConYear) ?? remaining[0] ?? null;
    setSelectedYear(nextYear);
    setTab('overview');
    if (nextYear !== null) {
      const yearObj = freshYears.find((y) => y.con_year === nextYear) ?? null;
      loadYearData(nextYear, freshEvents, yearObj);
      if (yearObj) loadYearExtras(yearObj);
    } else {
      setReturnParticipants([]);
      setOpenParticipants([]);
      setYearInvites([]);
      setYearMembers([]);
      setYearMeta(null);
    }
  }, [loadEvents, loadYearsData, loadYearData, loadYearExtras]);

  const isAdmin = userLoaded && user?.publicMetadata?.role === 'admin';

  useEffect(() => {
    if (isAdmin) { loadEvents(); loadYearsData(); loadAccessRequests(); }
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default invite panel year when years load
  useEffect(() => {
    if (yearsData.length === 0 || invitePanelYearId !== null) return;
    setInvitePanelYearId(yearsData[0].id);
  }, [yearsData, invitePanelYearId]);

  useEffect(() => {
    if (adminView !== 'invites' || invitePanelYearId === null) return;
    const yearObj = yearsData.find((y) => y.id === invitePanelYearId);
    if (yearObj) loadInvitePanel(yearObj);
  }, [adminView, invitePanelYearId, yearsData, loadInvitePanel]);

  const invitePanelYear = yearsData.find((y) => y.id === invitePanelYearId) ?? null;

  const pendingRequestCount = accessRequests.filter((r) => r.status === 'pending').length;

  // Auto-select latest year when events first load
  useEffect(() => {
    if (events.length > 0 && selectedYear === null) {
      const latest = Math.max(...events.map((e) => e.year));
      setSelectedYear(latest);
      const yearObj = yearsData.find((y) => y.con_year === latest) ?? null;
      loadYearData(latest, events, yearObj);
    }
  }, [events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load invites/members once years metadata is available for the selected year
  useEffect(() => {
    if (selectedYear === null || yearsData.length === 0) return;
    const yearObj = yearsData.find((y) => y.con_year === selectedYear);
    if (yearObj) {
      loadYearExtras(yearObj);
      // Re-resolve participants once years metadata is available (year_id linking)
      loadYearData(selectedYear, events, yearObj);
    }
  }, [selectedYear, yearsData]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleYearSelect = (year: number) => {
    setAdminView('year');
    setSelectedYear(year);
    setActiveRegType('return');
    setTab('overview');
    setYearInvites([]);
    setYearMembers([]);
    const yearObj = yearsData.find((y) => y.con_year === year) ?? null;
    loadYearData(year, events, yearObj);
    if (yearObj) loadYearExtras(yearObj);
  };

  const handleRegTypeSwitch = (type: 'return' | 'open') => {
    const targetEvt = yearEvents.find((e) => e.reg_type === type);
    if (!targetEvt) return;
    setActiveRegType(type);
  };

  if (!userLoaded) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
        <AppHeader title="Admin" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-500 text-sm">Loading…</div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-amber-50 text-gray-900 flex flex-col">
        <AppHeader title="Admin" />
        <div className="flex-1 flex items-center justify-center halftone-bg">
        <div className="bg-gray-50 border-2 border-red-500 comic-shadow p-8 w-80 text-center">
          <h1 className="font-bangers text-4xl text-yellow-400 tracking-wide leading-none mb-4">komikone</h1>
          <p className="text-red-400 text-sm mb-4">Access denied — admin role required.</p>
          <Link to="/" className="text-gray-400 hover:text-gray-900 text-sm underline">← Back to home</Link>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white flex flex-col">
      <AppHeader title="Admin" />

      <div className="flex flex-1 min-h-0">
      {/* Sidebar — years only */}
      <aside className="w-44 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700 dark:border-gray-800">
          <p className="text-gray-500 text-xs uppercase tracking-wider">Years &amp; tools</p>
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
                    selectedYear === year ? 'bg-blue-700 text-white' : 'text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  <div className="font-bold text-sm">{year}</div>
                  <div className="text-xs text-gray-400">
                    {[hasReturn && 'Return', hasOpen && 'Open'].filter(Boolean).join(' · ')}
                  </div>
                </button>
              );
            })}
            <CreateYearButton secret={secret} onCreated={() => reloadAll()} />
          </div>

          {/* Invites */}
          <div className="border-t border-gray-200 dark:border-gray-800 pt-3 space-y-0.5">
            <button
              onClick={() => setAdminView('backgrounds')}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors text-xs uppercase tracking-wide font-medium ${
                adminView === 'backgrounds' ? 'bg-blue-700 text-white' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              Backgrounds
            </button>
            <button
              onClick={() => setAdminView('requests')}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors text-xs uppercase tracking-wide font-medium flex items-center justify-between ${
                adminView === 'requests' ? 'bg-blue-700 text-white' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              <span>Access Requests</span>
              {pendingRequestCount > 0 && (
                <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                  {pendingRequestCount}
                </span>
              )}
            </button>
            <button
              onClick={() => {
                setAdminView('invites');
                if (invitePanelYearId === null && yearsData[0]) setInvitePanelYearId(yearsData[0].id);
              }}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors text-xs uppercase tracking-wide font-medium ${
                adminView === 'invites' ? 'bg-blue-700 text-white' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              Invite Codes
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col">
        {adminView === 'requests' ? (
          <div className="flex-1 overflow-auto p-6">
            <AccessRequestsPanel
              secret={secret}
              requests={accessRequests}
              inviteYear={activeYear ?? yearsData[0] ?? null}
              onUpdate={loadAccessRequests}
            />
          </div>
        ) : adminView === 'backgrounds' ? (
          <div className="flex-1 overflow-auto p-6">
            <BackgroundsPanel secret={secret} />
          </div>
        ) : adminView === 'invites' ? (
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-2xl space-y-4 mb-6">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Invite Codes</h2>
                <p className="text-gray-500 text-sm mt-1">
                  Codes are scoped to a con year. Pick which year the invite grants access to.
                </p>
              </div>
              {yearsData.length > 1 ? (
                <select
                  value={invitePanelYearId ?? ''}
                  onChange={(e) => setInvitePanelYearId(Number(e.target.value))}
                  className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2"
                >
                  {yearsData.map((y) => (
                    <option key={y.id} value={y.id}>{y.name}</option>
                  ))}
                </select>
              ) : invitePanelYear ? (
                <p className="text-gray-400 text-sm">{invitePanelYear.name}</p>
              ) : null}
            </div>
            {invitePanelYear ? (
              <InvitesTab
                year={invitePanelYear}
                invites={invitePanelInvites}
                secret={secret}
                onUpdate={() => loadInvitePanel(invitePanelYear)}
              />
            ) : (
              <p className="text-gray-500 text-sm">Create a year first to manage invite codes.</p>
            )}
          </div>
        ) : selectedYear === null ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {loading ? 'Loading…' : 'Select or initialize a year'}
          </div>
        ) : (
          <>
            {/* Detail header + tab bar */}
            <div className="border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 px-6 pt-5 pb-0">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white">SDCC {selectedYear}</h2>
                  <p className="text-sm text-gray-500">
                    {[returnEvent && 'Return Reg', openEvent && 'Open Reg'].filter(Boolean).join(' + ')}
                  </p>
                </div>
                {activeEvent && (
                  <div className="flex gap-2">
                    <a
                      href={api.admin.exportUrl(activeEvent.id, secret)}
                      className="text-sm bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-3 py-1.5 rounded transition-colors"
                      download
                    >
                      Export CSV
                    </a>
                    <Link
                      to={`/live/${activeEvent.id}`}
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
                {([
                  ['overview', 'Overview'],
                  ['people', 'People'],
                  ['prices', 'Prices'],
                  ['dates', 'Dates'],
                  ['settings', 'Settings'],
                ] as const).map(([t, label]) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTab(t);
                      if (t === 'people' && activeYear) loadYearExtras(activeYear);
                    }}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                      tab === t
                        ? 'border-blue-500 text-gray-900 dark:text-white'
                        : 'border-transparent text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                    }`}
                  >
                    {label}
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
            {tab === 'people' && (
              <PeopleTab
                members={yearMembers}
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
            {tab === 'settings' && activeYear && (
              <SettingsTab
                year={activeYear}
                eventCount={yearEvents.length}
                memberCount={yearMembers.length}
                inviteCount={yearInvites.length}
                getAuth={getAuth}
                onDeleted={() => handleYearDeleted(activeYear.con_year)}
                onDummiesChanged={() => reloadAll()}
              />
            )}
            {tab === 'settings' && !activeYear && (
              <div className="text-gray-500 text-sm">Select a year to manage settings.</div>
            )}
            </div>
          </>
        )}
      </main>
      </div>
    </div>
  );
}

// ─── Create Year Button ───────────────────────────────────────────────────────

const SDCC_DEFAULTS = {
  price_preview_adult: 6400, price_thu_adult: 8500, price_fri_adult: 8500,
  price_sat_adult: 8500, price_sun_adult: 6400,
  price_preview_junior: 3200, price_thu_junior: 4300, price_fri_junior: 4300,
  price_sat_junior: 4300, price_sun_junior: 3200,
};

function CreateYearButton({ secret, onCreated }: { secret: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      await api.admin.years.create(secret, { con_year: year });
      const summaries = await api.events.list();
      const newEvents = summaries.filter((e) => e.year === year);
      await Promise.all(
        newEvents.map((e) => api.admin.events.update(secret, e.id, SDCC_DEFAULTS))
      );
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
        className="w-full text-left px-2 py-1.5 rounded text-sm text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 mt-1"
      >
        + New Year
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-6 w-80">
        <div className="flex justify-between items-center mb-5">
          <h3 className="font-bold text-gray-900">New Year</h3>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-900">✕</button>
        </div>
        <div className="mb-5">
          <label className="block text-xs text-gray-400 mb-1">Con Year</label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-28 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-600 mt-2">
            Creates Return &amp; Open Reg events with default prices. Customize prices in the Prices tab.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCreate}
            disabled={loading}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded text-sm font-medium transition-colors"
          >
            {loading ? 'Creating…' : `Create ${year}`}
          </button>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-900 px-4 text-sm">Cancel</button>
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
                ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-300 dark:hover:bg-gray-700'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 cursor-not-allowed'
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
          <div className="bg-white/80 border border-dashed border-gray-300 rounded-xl p-8 flex items-center justify-center text-gray-600 text-sm">
            No Return Reg event
          </div>
        )}
        {!openEvent && (
          <div className="bg-white/80 border border-dashed border-gray-300 rounded-xl p-8 flex items-center justify-center text-gray-600 text-sm">
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
    <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-5 space-y-4">
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
            className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2 py-1 rounded transition-colors"
            download
          >
            CSV
          </a>
          <Link
            to={`/live/${event.id}`}
            target="_blank"
            className="text-xs bg-yellow-700 hover:bg-yellow-600 text-white px-2 py-1 rounded transition-colors"
          >
            Live ↗
          </Link>
          <button
            onClick={() => setCopyOpen(true)}
            className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2 py-1 rounded transition-colors"
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
          className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
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
              status === s
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: 'Total', value: participants.length, color: 'text-gray-900 dark:text-white' },
          { label: 'Complete', value: complete, color: 'text-green-600 dark:text-green-400' },
          { label: 'Remaining', value: remaining, color: 'text-amber-600 dark:text-yellow-400' },
          { label: 'Paid', value: paid, color: 'text-green-600 dark:text-green-400' },
          { label: 'Unpaid', value: participants.length - paid, color: 'text-red-600 dark:text-red-400' },
        ].map(({ label: lbl, value, color }) => (
          <div key={lbl} className="bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 rounded-lg p-2">
            <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
            <div className="text-gray-500 dark:text-gray-400 text-xs">{lbl}</div>
          </div>
        ))}
      </div>

      {/* Registration link */}
      <div className="space-y-1.5">
        <div className="flex gap-2 items-center">
          <code className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-emerald-700 dark:text-green-400 text-xs px-2 py-1.5 rounded flex-1 break-all">
            {origin}/register/{event.id}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(`${origin}/register/${event.id}`)}
            className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2 py-1.5 rounded shrink-0"
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

// ─── People Tab (members + event participants) ────────────────────────────────

function AccountMembersTable({ members }: { members: YearMember[] }) {
  if (members.length === 0) {
    return <p className="text-gray-500 text-sm">No account members for this year yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead className="text-gray-400 text-xs border-b border-gray-300">
          <tr>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Member ID</th>
            <th className="px-3 py-2 text-center">Badge</th>
            <th className="px-3 py-2 text-center">Return</th>
            <th className="px-3 py-2 text-left">Role</th>
            <th className="px-3 py-2 text-left">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {members.map((m) => (
            <tr key={m.id} className="hover:bg-white/80 dark:hover:bg-gray-800/60">
              <td className="px-3 py-2 text-gray-900 dark:text-white font-medium">{m.first_name} {m.last_name}</td>
              <td className="px-3 py-2">
                <MemberId
                  value={m.member_id}
                  letterClassName="text-gray-700 dark:text-gray-300"
                  digitClassName="text-amber-400"
                />
              </td>
              <td className="px-3 py-2 text-center text-xs">
                <span className={m.badge_type === 'JUNIOR' ? 'text-blue-400' : 'text-gray-700 dark:text-gray-300'}>{m.badge_type}</span>
              </td>
              <td className="px-3 py-2 text-center text-xs">
                <span className={m.return_eligible ? 'text-green-400' : 'text-gray-600'}>
                  {m.return_eligible ? '✓' : '—'}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  m.role === 'owner' ? 'bg-yellow-900/50 text-yellow-300' :
                  m.role === 'admin' ? 'bg-blue-900/50 text-blue-300' :
                  'bg-gray-100 text-gray-400'
                }`}>{m.role}</span>
              </td>
              <td className="px-3 py-2 text-xs text-gray-400">
                {new Date(m.joined_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PeopleTab({
  members,
  event, activeRegType, returnEvent, openEvent, onRegTypeChange,
  secret, participants, allEvents, onUpdate,
}: {
  members: YearMember[];
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [localParticipantOrder, setLocalParticipantOrder] = useState<number[]>([]);
  const dragSrcP = useRef<number | null>(null);
  const [dragTargetP, setDragTargetP] = useState<number | null>(null);

  const loadGroups = async (evt: EventDetail) => {
    try {
      const gs = await api.groups.list(evt.id, secret);
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

  const handleDelete = async (p: Participant) => {
    if (!event) return;
    if (!window.confirm(`Delete ${p.first_name} ${p.last_name}?`)) return;
    try {
      await api.admin.participants.delete(secret, event.id, p.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleAdd = async () => {
    if (!event) return;
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
    <div className="space-y-10">
      <section>
        <div className="mb-3">
          <h3 className="font-semibold text-gray-800 dark:text-gray-100">Account members</h3>
          <p className="text-gray-500 text-xs mt-1">
            Signed-in Komikone users for this year ({members.length})
          </p>
        </div>
        <AccountMembersTable members={members} />
      </section>

      <section>
        <EventToggle returnEvent={returnEvent} openEvent={openEvent} active={activeRegType} onChange={onRegTypeChange} />

        {!event ? (
          <p className="text-gray-500 text-sm mt-4">No event for this registration type.</p>
        ) : (
        <>
        <div className="flex justify-between items-center mb-4 mt-4">
          <div>
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Event roster</h3>
            <p className="text-gray-500 text-xs mt-1">
              Badge participants for {activeRegType === 'return' ? 'Return' : 'Open'} registration ({participants.length})
            </p>
          </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCopyOpen(true)}
            className="bg-gray-300 hover:bg-gray-600 text-gray-900 text-sm px-3 py-1.5 rounded transition-colors"
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
        <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-4 mb-4">
          <h4 className="font-medium text-gray-800 dark:text-gray-100 mb-3">New Participant</h4>
          <ParticipantForm value={newParticipant} onChange={setNewParticipant} groups={groups} />
          <div className="flex gap-2 mt-3">
            <button onClick={handleAdd} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded">
              Add
            </button>
            <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-gray-900 text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="text-gray-400 text-xs border-b border-gray-300">
            <tr>
              <th className="px-2 py-2 text-left w-8"></th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Kind</th>
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
                className={`hover:bg-white/80 dark:hover:bg-gray-800/60 ${p.all_purchased ? 'opacity-70' : ''} ${dragTargetP === p.id ? 'ring-2 ring-inset ring-blue-400' : ''}`}
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
                  <div className="text-gray-900 dark:text-white font-medium flex items-center gap-1.5 flex-wrap">
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
                  {p.notes && <div className="text-xs text-gray-500 italic">{p.notes}</div>}
                </td>
                <td className="px-2 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    p.clerk_user_id
                      ? 'bg-blue-900/50 text-blue-300 border border-blue-800'
                      : 'bg-gray-100 text-gray-400 border border-gray-300'
                  }`}>
                    {p.clerk_user_id ? 'Account' : 'Family'}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <MemberId
                    value={p.member_id}
                    letterClassName="text-gray-700 dark:text-gray-300"
                    digitClassName="text-amber-400"
                  />
                </td>
                <td className="px-2 py-2 text-center text-xs">
                  <span className={p.badge_type === 'JUNIOR' ? 'text-blue-400' : 'text-gray-700 dark:text-gray-300'}>
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
                      className="text-xs text-gray-400 hover:text-gray-900 px-1.5 py-0.5 rounded hover:bg-gray-300"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="text-xs text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-gray-300"
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

      {editingId !== null && event && (
        <EditParticipantModal
          participant={participants.find((p) => p.id === editingId)!}
          secret={secret}
          eventId={event.id}
          groups={groups}
          onSave={() => { setEditingId(null); onUpdate(); }}
          onClose={() => setEditingId(null)}
        />
      )}
        </>
        )}
      </section>
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
    <div className="mb-4 p-3 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">Groups</span>
        <button
          onClick={() => setAddOpen(!addOpen)}
          className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2 py-0.5 rounded"
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
            className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-gray-900 dark:text-white text-xs focus:outline-none focus:border-blue-500 w-36"
          />
          <input
            type="color"
            value={addingColor}
            onChange={(e) => setAddingColor(e.target.value)}
            className="w-7 h-7 rounded cursor-pointer border border-gray-300"
          />
          <button
            onClick={handleAdd}
            disabled={saving}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2 py-1 rounded"
          >
            Add
          </button>
          <button onClick={() => setAddOpen(false)} className="text-xs text-gray-400 hover:text-gray-900">Cancel</button>
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
                className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 text-gray-900 dark:text-white text-xs focus:outline-none focus:border-blue-500 w-28"
              />
              <input
                type="color"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                className="w-6 h-6 rounded cursor-pointer border border-gray-300"
              />
              <button onClick={() => handleEditSave(g)} className="text-xs text-green-400 hover:text-green-300">✓</button>
              <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-900">✕</button>
            </div>
          ) : (
            <div
              key={g.id}
              draggable
              onDragStart={() => onDragStart(g.id)}
              onDragOver={(e) => onDragOver(e, g.id)}
              onDrop={(e) => onDrop(e, g.id)}
              onDragEnd={onDragEnd}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs text-gray-900 dark:text-white font-medium cursor-grab ${
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
  participant, secret, eventId, groups, onSave, onClose,
}: {
  participant: Participant;
  secret: string;
  eventId: number;
  groups: Group[];
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
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-gray-900">Edit Participant</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">✕</button>
        </div>
        <ParticipantForm value={form} onChange={setForm} showAdminFields groups={groups} />
        <div className="flex gap-2 mt-4">
          <button onClick={handleSave} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded">
            Save
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 px-4">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ParticipantForm({
  value, onChange, showAdminFields = false, groups = [],
}: {
  value: Partial<Participant>;
  onChange: (v: Partial<Participant>) => void;
  showAdminFields?: boolean;
  groups?: Group[];
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
          <input
            type="text"
            value={value.member_id ?? ''}
            onChange={(e) => set('member_id', normalizeMemberIdInput(e.target.value))}
            className={`${inputCls} font-mono uppercase tracking-wide`}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>
        <Field label="Badge Type">
          <select value={value.badge_type ?? 'ADULT'} onChange={(e) => set('badge_type', e.target.value)} className={inputCls}>
            <option value="ADULT">Adult</option>
            <option value="JUNIOR">Junior / Military / Senior</option>
          </select>
        </Field>
      </div>
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
            <label key={day} className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-700">
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
          <ToggleSwitch
            checked={Boolean(value.return_eligible)}
            onChange={(v) => set('return_eligible', v)}
            label="Return eligible"
          />
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
  const priceDays = [
    { day: 'Preview Night', adult: 'price_preview_adult', junior: 'price_preview_junior' },
    { day: 'Thursday', adult: 'price_thu_adult', junior: 'price_thu_junior' },
    { day: 'Friday', adult: 'price_fri_adult', junior: 'price_fri_junior' },
    { day: 'Saturday', adult: 'price_sat_adult', junior: 'price_sat_junior' },
    { day: 'Sunday', adult: 'price_sun_adult', junior: 'price_sun_junior' },
  ] as const;

  type PriceKey = typeof priceDays[number]['adult'] | typeof priceDays[number]['junior'];
  const allPriceKeys = priceDays.flatMap((d) => [d.adult, d.junior]);

  const centsToDollars = (c: number) => (c / 100).toFixed(2);
  const dollarsToCents = (d: string) => Math.round(parseFloat(d || '0') * 100);

  const [values, setValues] = useState<Record<string, string>>(
    event
      ? Object.fromEntries(allPriceKeys.map((key) => [key, centsToDollars(event[key as PriceKey] as number)]))
      : {}
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (event) {
      setValues(Object.fromEntries(allPriceKeys.map((key) => [key, centsToDollars(event[key as PriceKey] as number)])));
    }
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!event) return <div className="text-gray-500">No event for this registration type.</div>;

  const setPrice = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  const handleSave = async () => {
    const patch = Object.fromEntries(allPriceKeys.map((key) => [key, dollarsToCents(values[key])]));
    try {
      await api.admin.events.update(secret, event.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const priceInput = (key: string) => (
    <div className="relative inline-block">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
      <input
        type="number"
        step="0.01"
        min="0"
        value={values[key] ?? ''}
        onChange={(e) => setPrice(key, e.target.value)}
        className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded pl-6 pr-2 py-1.5 text-gray-900 dark:text-white text-sm w-24 focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div>
      <EventToggle returnEvent={returnEvent} openEvent={openEvent} active={activeRegType} onChange={onRegTypeChange} />
      <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-4">Badge Prices</h3>
      <div className="overflow-x-auto max-w-2xl">
        <table className="w-full text-sm">
          <thead className="text-gray-400 text-xs border-b border-gray-300">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Day</th>
              <th className="px-3 py-2 text-left font-medium">Adult</th>
              <th className="px-3 py-2 text-left font-medium">Junior / Military / Senior</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {priceDays.map(({ day, adult, junior }) => (
              <tr key={day} className="hover:bg-white/70">
                <td className="px-3 py-2.5 text-gray-800 dark:text-gray-200 font-medium whitespace-nowrap">{day}</td>
                <td className="px-3 py-2.5">{priceInput(adult)}</td>
                <td className="px-3 py-2.5">{priceInput(junior)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={handleSave}
        className="mt-5 bg-blue-600 hover:bg-blue-500 text-white dark:text-white text-sm font-medium px-6 py-2 rounded transition-colors"
      >
        {saved ? 'Saved ✓' : 'Save Prices'}
      </button>
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
      <label className="text-sm text-gray-700 dark:text-gray-300 w-52 shrink-0">{label}</label>
      <input
        type="date"
        value={form[field]}
        onChange={(e) => set(field, e.target.value)}
        className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div className="max-w-2xl space-y-8">
      {/* Registration dates */}
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-4">Registration Dates</h3>
        <div className="space-y-3">
          <DateInput label="Return Registration" field="return_reg_start" />
          <DateInput label="Open Registration" field="open_reg_start" />
        </div>
      </div>

      {/* Deadlines */}
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-4">Deadlines</h3>
        <div className="space-y-3">
          <DateInput label="Address Deadline" field="address_deadline" />
          <DateInput label="Hotel Deadline" field="hotel_deadline" />
        </div>
      </div>

      {/* Event schedule */}
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-4">Event Schedule</h3>
        <div className="space-y-3">
          <DateInput label="Preview Night" field="preview_date" />
          <DateInput label="Thursday" field="thu_date" />
          <DateInput label="Friday" field="fri_date" />
          <DateInput label="Saturday" field="sat_date" />
          <DateInput label="Sunday" field="sun_date" />
        </div>
      </div>

      {/* Notes */}
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-3">Notes</h3>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={3}
          placeholder="Any notes for this year…"
          className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      <button
        onClick={handleSave}
        className="bg-blue-600 hover:bg-blue-500 text-white dark:text-white text-sm font-medium px-8 py-2.5 rounded transition-colors"
      >
        {saved ? 'Saved ✓' : 'Save Dates'}
      </button>
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
      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-5">
          <h3 className="font-bold text-gray-900">Copy / Transfer Participants</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">✕</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <div className="text-sm text-gray-800 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2">{event.name}</div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(Number(e.target.value))}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
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
                <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
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

          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input
              type="checkbox" checked={resetPurchasing}
              onChange={(e) => setResetPurchasing(e.target.checked)}
              className="accent-blue-500"
            />
            Reset purchasing history (coordinator, purchased days, payment)
          </label>

          <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-700">
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
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 px-4 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Access Requests Panel ────────────────────────────────────────────────────

function AccessRequestsPanel({
  secret, requests, inviteYear, onUpdate,
}: {
  secret: string;
  requests: InviteRequest[];
  inviteYear: Year | null;
  onUpdate: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);

  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter);
  const origin = window.location.origin;

  const handleApprove = async (req: InviteRequest) => {
    if (!inviteYear) {
      alert('Create or select a year first (sidebar) before approving requests.');
      return;
    }
    setApprovingId(req.id);
    try {
      await api.admin.inviteRequests.update(secret, req.id, { status: 'approved' });
      const res = await api.admin.invites.create(secret, inviteYear.id, {
        label: req.email,
        email: req.email,
      });
      const url = res.join_url || `${origin}/join/${res.invite.code}`;
      setLastInviteUrl(url);
      if (res.email_sent) {
        setLastInviteUrl(null);
        alert(`Invite created and email sent to ${req.email}.`);
      } else {
        await navigator.clipboard.writeText(url);
        if (res.email_error) {
          alert(`Invite created, but email failed: ${res.email_error}\n\nLink copied to clipboard.`);
        }
      }
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to approve');
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async (id: number) => {
    try {
      await api.admin.inviteRequests.update(secret, id, { status: 'rejected' });
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this request?')) return;
    try {
      await api.admin.inviteRequests.delete(secret, id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Access Requests</h2>
        <p className="text-gray-500 text-sm mt-1">
          Approve to create an invite for {inviteYear?.name ?? '— select a year in sidebar'}.
        </p>
      </div>

      {lastInviteUrl && (
        <div className="bg-green-950/40 border border-green-800 rounded-xl p-4 text-sm">
          <p className="text-green-300 font-medium mb-1">Invite created — link copied to clipboard</p>
          <p className="text-gray-400 font-mono text-xs break-all">{lastInviteUrl}</p>
          <button onClick={() => setLastInviteUrl(null)} className="text-xs text-gray-500 hover:text-gray-700 mt-2">Dismiss</button>
        </div>
      )}

      <div className="flex gap-2">
        {(['pending', 'approved', 'rejected', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded capitalize transition-colors ${
              filter === f ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-400 hover:text-gray-900'
            }`}
          >
            {f}
            {f === 'pending' && requests.filter((r) => r.status === 'pending').length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white px-1.5 rounded-full text-[10px]">
                {requests.filter((r) => r.status === 'pending').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm">No {filter === 'all' ? '' : filter} requests.</p>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <div key={r.id} className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-gray-900 dark:text-white font-medium">{r.email}</p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    Referred by {r.referred_by || '—'} · {new Date(r.created_at + 'Z').toLocaleDateString()}
                  </p>
                  {r.notes && <p className="text-gray-400 text-sm mt-2 italic">&ldquo;{r.notes}&rdquo;</p>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                  r.status === 'pending' ? 'bg-yellow-900/50 text-yellow-300' :
                  r.status === 'approved' ? 'bg-green-900/50 text-green-300' :
                  'bg-red-900/50 text-red-700'
                }`}>{r.status}</span>
              </div>
              {r.status === 'pending' && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => handleApprove(r)}
                    disabled={approvingId === r.id || !inviteYear}
                    className="text-xs bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-100 px-3 py-1.5 rounded"
                  >
                    {approvingId === r.id ? 'Creating…' : 'Approve & copy invite link'}
                  </button>
                  <button
                    onClick={() => handleReject(r.id)}
                    className="text-xs bg-red-900 hover:bg-red-800 text-red-200 px-3 py-1.5 rounded"
                  >
                    Reject
                  </button>
                  <button onClick={() => handleDelete(r.id)} className="text-xs text-gray-500 hover:text-red-400 ml-auto">Delete</button>
                </div>
              )}
              {r.status !== 'pending' && (
                <button onClick={() => handleDelete(r.id)} className="text-xs text-gray-500 hover:text-red-400 mt-2">Delete</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Invites Tab ──────────────────────────────────────────────────────────────

function InvitesTab({
  year, invites, secret, onUpdate,
}: {
  year: Year;
  invites: Invite[];
  secret: string;
  onUpdate: () => void;
}) {
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'warn'; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [bulkCount, setBulkCount] = useState(50);
  const [bulkPrefix, setBulkPrefix] = useState('');
  const [bulkCreating, setBulkCreating] = useState(false);

  const origin = window.location.origin;
  const inviteUrl = (code: string) => `${origin}/join/${code}`;

  const downloadCsv = (rows: Invite[], filename: string) => {
    const header = ['label', 'code', 'url'];
    const lines = [
      header.join(','),
      ...rows.map((inv) => {
        const url = inviteUrl(inv.code);
        return [inv.label, inv.code, url]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',');
      }),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleBulkCreate = async () => {
    setBulkCreating(true);
    try {
      const { invites: created } = await api.admin.invites.bulkCreate(secret, year.id, {
        count: bulkCount,
        label_prefix: bulkPrefix.trim() || undefined,
      });
      onUpdate();
      downloadCsv(created, `${year.name.replace(/\s+/g, '-')}-invites.csv`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to bulk create');
    } finally {
      setBulkCreating(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setStatus(null);
    try {
      const payload: { label?: string; email?: string } = {};
      if (label.trim()) payload.label = label.trim();
      if (email.trim()) payload.email = email.trim().toLowerCase();

      const res = await api.admin.invites.create(secret, year.id, payload);
      setLabel('');
      setEmail('');
      onUpdate();

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

  const sendByEmail = email.trim().length > 0;

  const handleDelete = async (inv: Invite) => {
    if (inv.used_by_clerk_user_id && !confirm(`This invite has been used. Delete "${inv.label || inv.code}" anyway?`)) return;
    try {
      await api.admin.invites.delete(secret, year.id, inv.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const copyLink = (inv: Invite) => {
    navigator.clipboard.writeText(inviteUrl(inv.code));
    setCopiedId(inv.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const unused = invites.filter((i) => !i.used_by_clerk_user_id);
  const used = invites.filter((i) => i.used_by_clerk_user_id);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-800 dark:text-gray-100">Invite Codes — {year.name}</h3>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-500">{unused.length} unused · {used.length} used</div>
          {unused.length > 0 && (
            <button
              onClick={() => downloadCsv(unused, `${year.name.replace(/\s+/g, '-')}-unused-invites.csv`)}
              className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2.5 py-1 rounded transition-colors"
            >
              Download CSV
            </button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-4 space-y-3">
        <h4 className="text-xs text-gray-400 uppercase tracking-wide">Bulk Generate</h4>
        <p className="text-xs text-gray-500">
          Create many single-use codes at once. A CSV downloads automatically for mail merge.
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Count</label>
            <input
              type="number"
              min={1}
              max={100}
              value={bulkCount}
              onChange={(e) => setBulkCount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
              className="w-20 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex-1 min-w-[12rem]">
            <label className="block text-xs text-gray-500 mb-1">Label prefix (optional)</label>
            <input
              type="text"
              value={bulkPrefix}
              onChange={(e) => setBulkPrefix(e.target.value)}
              placeholder="e.g. Return 2027"
              className={inputCls}
            />
          </div>
          <button
            onClick={handleBulkCreate}
            disabled={bulkCreating}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-gray-900 text-sm px-4 py-2 rounded whitespace-nowrap transition-colors"
          >
            {bulkCreating ? 'Generating…' : `Generate ${bulkCount}`}
          </button>
        </div>
        <p className="text-xs text-gray-600">Labels: &quot;{bulkPrefix.trim() || 'Invite'} 1&quot;, &quot;{bulkPrefix.trim() || 'Invite'} 2&quot;, … — rename in your spreadsheet before sending.</p>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl p-4 space-y-3">
        <h4 className="text-xs text-gray-400 uppercase tracking-wide">Invite someone</h4>
        <p className="text-xs text-gray-500">
          Add an email to send the invitation automatically. After sign-up, they land on your join link.
        </p>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name (for your reference)"
          className={inputCls}
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          placeholder="Email (optional — we'll send the invite)"
          className={inputCls}
        />
        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white dark:text-white text-sm font-medium px-4 py-2 rounded transition-colors"
        >
          {creating
            ? 'Working…'
            : sendByEmail
              ? 'Create invite & send email'
              : 'Create invite link'}
        </button>
        {status && (
          <p className={`text-sm ${status.type === 'ok' ? 'text-green-400' : 'text-amber-400'}`}>
            {status.text}
          </p>
        )}
      </div>

      {invites.length === 0 ? (
        <p className="text-gray-500 text-sm">No invites yet for {year.name}.</p>
      ) : (
        <div className="space-y-2">
          {invites.map((inv) => (
            <div
              key={inv.id}
              className={`bg-white dark:bg-gray-900 border rounded-xl p-4 flex items-center gap-4 ${
                inv.used_by_clerk_user_id ? 'border-gray-200 dark:border-gray-700 opacity-70' : 'border-gray-300 dark:border-gray-600'
              }`}
            >
              <div className={`w-2 h-2 rounded-full shrink-0 ${inv.used_by_clerk_user_id ? 'bg-green-500' : 'bg-yellow-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm text-gray-900 dark:text-white font-medium">{inv.code}</span>
                  {inv.label && <span className="text-gray-400 text-sm">{inv.label}</span>}
                  {inv.invited_email && (
                    <span className="text-gray-500 text-xs">{inv.invited_email}</span>
                  )}
                  {inv.used_by_clerk_user_id ? (
                    <span className="text-xs bg-green-900/50 text-green-300 border border-green-800 px-1.5 py-0.5 rounded">used</span>
                  ) : (
                    <span className="text-xs bg-yellow-900/50 text-yellow-300 border border-yellow-800 px-1.5 py-0.5 rounded">unused</span>
                  )}
                </div>
                {inv.used_at && (
                  <div className="text-xs text-gray-500 mt-0.5">
                    Used {new Date(inv.used_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                )}
                <div className="text-xs text-gray-600 mt-0.5 truncate">{inviteUrl(inv.code)}</div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => copyLink(inv)}
                  className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white px-2.5 py-1 rounded transition-colors"
                >
                  {copiedId === inv.id ? 'Copied ✓' : 'Copy Link'}
                </button>
                <button
                  onClick={() => handleDelete(inv)}
                  className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Del
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsTab({
  year,
  eventCount,
  memberCount,
  inviteCount,
  getAuth,
  onDeleted,
  onDummiesChanged,
}: {
  year: Year;
  eventCount: number;
  memberCount: number;
  inviteCount: number;
  getAuth: () => Promise<string>;
  onDeleted: () => void;
  onDummiesChanged: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [dummyCount, setDummyCount] = useState<{ participants: number; groups: number } | null>(null);
  const [seedCount, setSeedCount] = useState(40);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [dummyMsg, setDummyMsg] = useState('');

  const canDelete = confirmText === String(year.con_year);

  const requireAuth = useCallback(async () => {
    const tok = await getAuth();
    if (!tok) throw new Error('Not signed in — refresh the page and try again');
    return tok;
  }, [getAuth]);

  const refreshDummies = useCallback(async () => {
    try {
      const tok = await requireAuth();
      const c = await api.admin.years.dummies.count(tok, year.id);
      setDummyCount({ participants: c.participants, groups: c.groups });
    } catch {
      setDummyCount(null);
    }
  }, [requireAuth, year.id]);

  useEffect(() => { refreshDummies(); }, [refreshDummies]);

  const handleSeed = async () => {
    setSeeding(true);
    setDummyMsg('');
    try {
      const tok = await requireAuth();
      const res = await api.admin.years.dummies.seed(tok, year.id, {
        count: seedCount,
        clear_existing: true,
      });
      setDummyMsg(`Seeded ${res.created} participants and ${res.groups_created} groups across ${res.event_ids.length} event(s).`);
      await refreshDummies();
      onDummiesChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to seed dummies');
    } finally {
      setSeeding(false);
    }
  };

  const handleClearDummies = async () => {
    if (!window.confirm(`Delete all dummy test participants for ${year.name}? Real members are not affected.`)) return;
    setClearing(true);
    setDummyMsg('');
    try {
      const tok = await requireAuth();
      const res = await api.admin.years.dummies.clear(tok, year.id);
      setDummyMsg(`Removed ${res.participants_deleted} participants and ${res.groups_deleted} groups.`);
      await refreshDummies();
      onDummiesChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to clear dummies');
    } finally {
      setClearing(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete) return;
    if (!window.confirm(
      `Permanently delete ${year.name}? This removes events, participants, members, and invites. This cannot be undone.`,
    )) return;

    setDeleting(true);
    try {
      const tok = await requireAuth();
      await api.admin.years.delete(tok, year.id);
      onDeleted();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete year');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-2">Settings</h3>
        <p className="text-gray-500 text-sm">
          Manage configuration for <span className="text-gray-700 dark:text-gray-300">{year.name}</span>.
        </p>
      </div>

      {/* Test data */}
      <div className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 rounded-xl p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Test data</p>
        <h4 className="text-gray-900 dark:text-white font-semibold mb-1">Dummy participants</h4>
        <p className="text-gray-500 text-sm mb-4">
          Seed fake roster rows for Live Board practice. Tagged with notes <code className="text-xs">[DUMMY]</code> and
          Member IDs like <code className="text-xs">DUMMY-0001</code> — safe to wipe without touching real people.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Current dummies:{' '}
          <span className="font-medium text-gray-900 dark:text-white">
            {dummyCount == null ? '…' : `${dummyCount.participants} people / ${dummyCount.groups} groups`}
          </span>
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">People per event</label>
            <input
              type="number"
              min={1}
              max={120}
              value={seedCount}
              onChange={(e) => setSeedCount(Math.min(120, Math.max(1, Number(e.target.value) || 1)))}
              className="w-24 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-white text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleSeed}
            disabled={seeding || clearing || eventCount === 0}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {seeding ? 'Seeding…' : 'Seed dummies'}
          </button>
          <button
            type="button"
            onClick={handleClearDummies}
            disabled={seeding || clearing || (dummyCount?.participants ?? 0) === 0}
            className="bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white disabled:opacity-40 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {clearing ? 'Clearing…' : 'Clear dummies'}
          </button>
        </div>
        {eventCount === 0 && (
          <p className="text-amber-600 dark:text-amber-400 text-xs">This year has no events yet.</p>
        )}
        {dummyMsg && <p className="text-green-600 dark:text-green-400 text-sm mt-2">{dummyMsg}</p>}
      </div>

      <div className="border-2 border-red-200/80 bg-red-950/30 rounded-xl p-5">
        <p className="text-red-700 text-xs font-semibold uppercase tracking-wider mb-2">Danger zone</p>
        <h4 className="text-white font-semibold mb-1">Delete this year</h4>
        <p className="text-red-200/80 text-sm mb-4">
          Permanently removes <strong className="text-red-100">{year.name}</strong> and all associated data:
          {' '}{eventCount} event{eventCount !== 1 ? 's' : ''}, {memberCount} member{memberCount !== 1 ? 's' : ''},
          {' '}{inviteCount} invite{inviteCount !== 1 ? 's' : ''}, participants, groups, and registration dates.
          This cannot be undone.
        </p>
        <label className="block text-sm text-red-200/90 mb-2">
          Type <span className="font-mono text-red-100">{year.con_year}</span> to confirm
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={String(year.con_year)}
          className="w-full bg-red-50 border border-red-800 text-white rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleDelete}
          disabled={!canDelete || deleting}
          className="bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-900 dark:text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {deleting ? 'Deleting…' : 'Delete year permanently'}
        </button>
      </div>
    </div>
  );
}

// ─── Backgrounds Panel ────────────────────────────────────────────────────────

function BackgroundsPanel({ secret }: { secret: string }) {
  const [items, setItems] = useState<Background[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.admin.backgrounds.list(secret);
      setItems(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setErr('');
    try {
      await api.admin.backgrounds.create(secret, { url: url.trim(), label: label.trim() || undefined });
      setUrl('');
      setLabel('');
      invalidateBackgroundCache();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (bg: Background) => {
    try {
      await api.admin.backgrounds.update(secret, bg.id, { active: !bg.active });
      invalidateBackgroundCache();
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  const handleDelete = async (bg: Background) => {
    if (!confirm('Remove this background URL?')) return;
    try {
      await api.admin.backgrounds.delete(secret, bg.id);
      invalidateBackgroundCache();
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Background Images</h2>
        <p className="text-gray-500 text-sm mt-1">
          Add image URLs to rotate on the dashboard and other pages. Use direct links (https) to hosted photos.
        </p>
      </div>

      {err && <p className="text-red-400 text-sm">{err}</p>}

      <form onSubmit={handleAdd} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Image URL *</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Label (optional)</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. SDCC hall"
            className={inputCls}
          />
        </div>
        <button
          type="submit"
          disabled={adding || !url.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white dark:text-white text-sm font-medium px-4 py-2 rounded-lg"
        >
          {adding ? 'Adding…' : 'Add background'}
        </button>
      </form>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No backgrounds yet. Add URLs above — until you do, the app uses built-in fallbacks.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((bg) => (
            <div
              key={bg.id}
              className={`bg-white dark:bg-gray-900 border rounded-xl overflow-hidden ${
                bg.active ? 'border-gray-300 dark:border-gray-600' : 'border-gray-200 dark:border-gray-700 opacity-60'
              }`}
            >
              <div className="aspect-video bg-gray-100 relative">
                <img
                  src={bg.url}
                  alt={bg.label || 'Background'}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
              <div className="p-3 space-y-2">
                {bg.label && <p className="text-gray-900 dark:text-white text-sm font-medium truncate">{bg.label}</p>}
                <p className="text-gray-500 text-xs font-mono break-all line-clamp-2">{bg.url}</p>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => handleToggle(bg)}
                    className={`text-xs px-2.5 py-1 rounded ${
                      bg.active
                        ? 'bg-green-950 text-green-400 border border-green-800'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-400 border border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {bg.active ? 'Active' : 'Inactive'}
                  </button>
                  <button
                    onClick={() => handleDelete(bg)}
                    className="text-xs text-red-500 hover:text-red-400 px-2"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-gray-900 dark:text-gray-50 text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:border-blue-500';


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
