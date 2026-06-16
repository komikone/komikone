import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type EventDetail, type Participant, formatDollars, DAY_KEYS, type DayKey } from '../lib/api';
import { useTheme } from '../lib/useTheme';

const POLL_MS = 8000;

type RowStatus = 'complete' | 'claiming' | 'partial' | 'none';

function rowStatus(p: Participant): RowStatus {
  if (p.all_purchased) return 'complete';
  if (p.claim_active) return 'claiming';
  if (p.any_purchased) return 'partial';
  return 'none';
}

function rowBg(status: RowStatus): string {
  switch (status) {
    case 'complete': return 'bg-green-100 border-l-4 border-l-green-600 dark:bg-green-900/40 dark:border-l-green-500';
    case 'claiming': return 'bg-yellow-50 border-l-4 border-l-orange-500 dark:bg-yellow-900/40 dark:border-l-yellow-400';
    case 'partial': return 'bg-blue-50 border-l-4 border-l-blue-500 dark:bg-blue-900/20 dark:border-l-blue-500';
    default: return 'border-l-4 border-l-transparent';
  }
}

export default function LiveBoard() {
  const { eventId } = useParams<{ eventId: string }>();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { toggle, isDark } = useTheme();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [myName, setMyName] = useState(() => localStorage.getItem('komikone_myname') ?? '');
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [flash, setFlash] = useState<Record<number, boolean>>({});
  const prevIds = useRef<Set<number>>(new Set());

  const fetchAll = useCallback(async () => {
    if (!eventId) return;
    try {
      const [ev, ps] = await Promise.all([
        api.events.get(Number(eventId), token),
        api.participants.list(Number(eventId), token),
      ]);
      setEvent(ev);

      const newFlash: Record<number, boolean> = {};
      for (const p of ps) {
        if (prevIds.current.has(p.id)) {
          const old = participants.find((x) => x.id === p.id);
          if (old && old.updated_at !== p.updated_at) newFlash[p.id] = true;
        }
      }
      if (Object.keys(newFlash).length > 0) {
        setFlash(newFlash);
        setTimeout(() => setFlash({}), 1200);
      }
      prevIds.current = new Set(ps.map((p) => p.id));
      setParticipants(ps);
      setLastUpdated(new Date());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [eventId, token, participants]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(interval);
  }, [eventId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClaim = async (p: Participant) => {
    if (!myName.trim()) {
      const name = prompt('Enter your name (used to claim rows):');
      if (!name) return;
      localStorage.setItem('komikone_myname', name);
      setMyName(name);
    }
    const name = myName || (localStorage.getItem('komikone_myname') ?? '');
    try {
      await api.participants.claim(Number(eventId), p.id, token, name);
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to claim');
    }
  };

  const handleUnclaim = async (p: Participant) => {
    try {
      await api.participants.unclaim(Number(eventId), p.id, token);
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to unclaim');
    }
  };

  const handlePurchaseToggle = async (p: Participant, day: DayKey, checked: boolean) => {
    const data = {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun,
      who_purchased: p.who_purchased || myName,
      [`pur_${day}`]: checked,
    };
    try {
      await api.participants.updatePurchased(Number(eventId), p.id, token, data);
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  const handleWhoChange = async (p: Participant, who: string) => {
    const data = {
      pur_preview: p.pur_preview, pur_thu: p.pur_thu, pur_fri: p.pur_fri,
      pur_sat: p.pur_sat, pur_sun: p.pur_sun, who_purchased: who,
    };
    try {
      await api.participants.updatePurchased(Number(eventId), p.id, token, data);
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update');
    }
    setEditingRow(null);
  };

  const purchased = participants.filter((p) => p.all_purchased).length;
  const inProgress = participants.filter((p) => !p.all_purchased && p.claim_active).length;
  const remaining = participants.filter((p) => !p.all_purchased && !p.claim_active).length;
  const withGaps = participants.filter((p) => p.gaps.length > 0 && p.any_purchased).length;

  const myCandidates = participants.filter((p) => !p.all_purchased && !p.claim_active).slice(0, 3);

  if (!event && !error) {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-900 dark:text-white flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-900 dark:text-white flex items-center justify-center">
        <div className="text-red-600 dark:text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-amber-50 dark:bg-gray-950 text-gray-950 dark:text-white flex flex-col">

      {/* Top bar */}
      <div className="bg-red-600 border-b-4 border-black dark:bg-black dark:border-yellow-400 px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="font-bangers text-white dark:text-yellow-400 text-xl tracking-wide shrink-0">komikone</span>
        <span className="text-red-300 dark:text-gray-700 shrink-0">|</span>
        <div className="flex-1 min-w-0">
          <span className="font-bangers text-white text-lg tracking-wide">{event?.name}</span>
          <span className="ml-2 text-red-200 dark:text-gray-500 text-xs uppercase tracking-widest">
            {event?.reg_type === 'return' ? 'Return Reg' : 'Open Reg'} · Live Board
          </span>
        </div>

        {/* Stats */}
        <div className="flex gap-4 text-sm font-mono">
          <span className="text-green-200 font-bold dark:text-green-400 dark:font-normal">{purchased} complete</span>
          <span className="text-yellow-200 font-bold dark:text-yellow-400 dark:font-normal">{inProgress} in progress</span>
          <span className="text-white dark:text-gray-300">{remaining} remaining</span>
          {withGaps > 0 && <span className="text-red-200 font-bold dark:text-red-400 dark:font-normal">{withGaps} with gaps</span>}
        </div>

        {/* You: */}
        <div className="flex items-center gap-2">
          <span className="text-red-100 dark:text-gray-400 text-xs">You:</span>
          <input
            type="text"
            value={myName}
            onChange={(e) => {
              setMyName(e.target.value);
              localStorage.setItem('komikone_myname', e.target.value);
            }}
            placeholder="Your name"
            className="bg-white dark:bg-gray-800 border border-red-200 dark:border-gray-600 rounded px-2 py-1 text-xs text-gray-900 dark:text-white w-28 focus:outline-none focus:border-yellow-400"
          />
        </div>

        {/* Updated + theme toggle */}
        <div className="flex items-center gap-3">
          <span className="text-red-200 dark:text-gray-500 text-xs">
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading...'}
          </span>
          <button
            onClick={toggle}
            className="text-red-100 dark:text-gray-400 hover:text-white dark:hover:text-yellow-400 text-xs border border-red-300 dark:border-gray-700 px-2 py-0.5 rounded transition-colors"
          >
            {isDark ? '☀ Day' : '◑ Night'}
          </button>
        </div>
      </div>

      {/* Who should I buy for? */}
      {myCandidates.length > 0 && myName && (
        <div className="bg-blue-600 dark:bg-blue-950/40 border-b-2 border-black dark:border-blue-800 px-4 py-2">
          <span className="text-white font-bold dark:text-blue-300 dark:font-medium text-xs">Next to buy for: </span>
          {myCandidates.map((p, i) => (
            <span key={p.id} className="text-xs">
              {i > 0 && <span className="text-blue-300 dark:text-gray-600">, </span>}
              <button
                onClick={() => handleClaim(p)}
                className="text-yellow-300 dark:text-white underline hover:text-white dark:hover:text-blue-300"
              >
                {p.first_name} {p.last_name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="sticky top-0 bg-black dark:bg-gray-900 text-white dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left w-6">#</th>
              <th className="px-3 py-2 text-left">First</th>
              <th className="px-3 py-2 text-left">Last</th>
              <th className="px-3 py-2 text-left">Sponsor</th>
              <th className="px-3 py-2 text-left">Member ID</th>
              <th className="px-3 py-2 text-center">Requested</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-center">Purchased</th>
              <th className="px-3 py-2 text-center text-red-400">Gaps</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-left">Who Bought</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {participants.map((p, idx) => {
              const status = rowStatus(p);
              const isFlashing = flash[p.id];
              return (
                <tr
                  key={p.id}
                  className={`${rowBg(status)} ${isFlashing ? 'animate-pulse' : ''} hover:bg-black/5 dark:hover:bg-white/5 transition-colors`}
                >
                  {/* # */}
                  <td className="px-3 py-2 text-gray-400 dark:text-gray-500 text-xs">{idx + 1}</td>

                  {/* First name */}
                  <td className="px-3 py-2">
                    <div className="font-semibold text-gray-900 dark:text-white">{p.first_name}</div>
                    {p.badge_type === 'JUNIOR' && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-900/60 dark:text-blue-300 dark:border-blue-700">JR</span>
                    )}
                  </td>

                  {/* Last name */}
                  <td className="px-3 py-2">
                    <div className="font-semibold text-gray-900 dark:text-white">{p.last_name}</div>
                    {p.return_eligible && (
                      <span className="text-[10px] font-semibold text-green-700 dark:font-normal dark:text-green-400">✓ Return</span>
                    )}
                  </td>

                  {/* Sponsor */}
                  <td className="px-3 py-2">
                    {p.sponsor ? (
                      <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900/60 dark:text-purple-300 dark:border-purple-700">
                        {p.sponsor}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300 dark:text-gray-700">—</span>
                    )}
                  </td>

                  {/* Member ID */}
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">{p.member_id || '—'}</td>

                  {/* Requested days */}
                  <td className="px-3 py-2">
                    <DayPips days={{ preview: p.req_preview, thu: p.req_thu, fri: p.req_fri, sat: p.req_sat, sun: p.req_sun }} />
                  </td>

                  {/* Claim status */}
                  <td className="px-3 py-2 text-center">
                    {status === 'complete' ? (
                      <span className="text-xs font-bold text-green-700 dark:font-medium dark:text-green-400">Complete</span>
                    ) : p.claim_active ? (
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs font-bold text-orange-600 dark:font-medium dark:text-yellow-400">
                          {p.purchasing_claimed_by}
                        </span>
                        <button
                          onClick={() => handleUnclaim(p)}
                          className="text-xs underline text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
                        >
                          Release
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleClaim(p)}
                        className="text-xs font-bold px-3 py-1 rounded transition-colors bg-red-600 hover:bg-red-700 text-white border-2 border-black dark:bg-yellow-500 dark:hover:bg-yellow-400 dark:text-yellow-950 dark:border-transparent"
                      >
                        Claim
                      </button>
                    )}
                  </td>

                  {/* Purchased checkboxes */}
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-center items-center">
                      {DAY_KEYS.map((day) => {
                        const requested = p[`req_${day}` as keyof Participant] as boolean;
                        const purchased = p[`pur_${day}` as keyof Participant] as boolean;
                        if (!requested) return <span key={day} className="w-6" />;
                        return (
                          <label key={day} className="flex flex-col items-center cursor-pointer">
                            <span className="text-[10px] text-gray-500 leading-none mb-0.5">
                              {day === 'preview' ? 'PV' : day.charAt(0).toUpperCase() + day.slice(1, 3)}
                            </span>
                            <input
                              type="checkbox"
                              checked={purchased}
                              onChange={(e) => handlePurchaseToggle(p, day, e.target.checked)}
                              className="w-4 h-4 rounded accent-green-600 dark:accent-green-500 cursor-pointer"
                            />
                          </label>
                        );
                      })}
                    </div>
                  </td>

                  {/* Gaps */}
                  <td className="px-3 py-2 text-center">
                    {p.gaps.length > 0 ? (
                      <span className="text-xs font-bold text-red-700 dark:font-medium dark:text-red-400">{p.gaps.join(', ')}</span>
                    ) : p.any_purchased ? (
                      <span className="text-xs text-green-600 dark:text-green-500">—</span>
                    ) : (
                      <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Total */}
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-800 dark:text-gray-200">
                    {p.purchase_total > 0 ? formatDollars(p.purchase_total) : '—'}
                  </td>

                  {/* Who purchased */}
                  <td className="px-3 py-2">
                    {editingRow === p.id ? (
                      <WhoInput
                        initial={p.who_purchased}
                        onSave={(val) => handleWhoChange(p, val)}
                        onCancel={() => setEditingRow(null)}
                      />
                    ) : (
                      <button
                        onClick={() => setEditingRow(p.id)}
                        className="text-xs text-left text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                      >
                        {p.who_purchased || <span className="italic text-gray-400 dark:text-gray-600">tap to set</span>}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayPips({ days }: { days: Record<string, boolean> }) {
  const labels: [string, string][] = [
    ['preview', 'PV'], ['thu', 'Th'], ['fri', 'Fr'], ['sat', 'Sa'], ['sun', 'Su'],
  ];
  return (
    <div className="flex gap-0.5 justify-center">
      {labels.map(([key, label]) =>
        days[key] ? (
          <span key={key} className="bg-gray-700 dark:bg-gray-400 text-white text-[10px] rounded px-1 leading-4">
            {label}
          </span>
        ) : (
          <span key={key} className="w-5" />
        )
      )}
    </div>
  );
}

function WhoInput({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  return (
    <div className="flex gap-1">
      <input
        autoFocus
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(val);
          if (e.key === 'Escape') onCancel();
        }}
        className="bg-white dark:bg-gray-800 border border-gray-400 dark:border-gray-600 rounded px-1.5 py-0.5 text-xs text-gray-900 dark:text-white w-24 focus:outline-none"
      />
      <button onClick={() => onSave(val)} className="text-xs text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300">✓</button>
      <button onClick={onCancel} className="text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400">✕</button>
    </div>
  );
}
