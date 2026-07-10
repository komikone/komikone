import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MemberId } from '../components/MemberId';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

type YearStat = {
  year: number;
  reg_type: 'return' | 'open';
  total: number;
  purchased_any: number;
  paid_count: number;
  req_preview: number; req_thu: number; req_fri: number; req_sat: number; req_sun: number;
  pur_preview: number; pur_thu: number; pur_fri: number; pur_sat: number; pur_sun: number;
  junior_count: number;
};

type Buyer = {
  name: string;
  participants_served: number;
  years_active: number;
  year_list: string;
};

type ReturnMember = {
  member_id: string;
  first_name: string;
  last_name: string;
  year_count: number;
  years: string;
};

type Stats = {
  years: YearStat[];
  top_buyers: Buyer[];
  retention: ReturnMember[];
};

const DAYS = ['preview', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = {
  preview: 'Preview', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

function pct(n: number, d: number) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

function Bar({ value, max, color = 'bg-blue-500', label }: { value: number; max: number; color?: string; label?: string }) {
  const w = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-800 rounded-full h-2.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      {label !== undefined && <span className="text-xs text-gray-400 w-8 text-right">{label}</span>}
    </div>
  );
}

export default function Stats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${BASE}/api/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      <div className="text-red-400">{error}</div>
    </div>
  );

  if (!stats) return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      <div className="text-gray-500">Loading…</div>
    </div>
  );

  // Group by year for combined view
  const yearMap = new Map<number, { return?: YearStat; open?: YearStat }>();
  for (const y of stats.years) {
    if (!yearMap.has(y.year)) yearMap.set(y.year, {});
    yearMap.get(y.year)![y.reg_type] = y;
  }
  void yearMap; // used implicitly via stats.years grouping

  const maxParticipants = Math.max(...stats.years.map((y) => y.total));

  // All-time totals
  const allComplete = stats.years.filter((y) => y.year < 2026);
  const totalEvents = allComplete.length;
  const totalParticipants = allComplete.reduce((s, y) => s + y.total, 0);
  const totalPurchased = allComplete.reduce((s, y) => s + y.purchased_any, 0);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">← Home</Link>
            <h1 className="font-bangers text-4xl text-yellow-400 tracking-wide mt-1">SDCC Stats</h1>
            <p className="text-gray-500 text-sm mt-1">Purchase train history · 2020 – 2026</p>
          </div>
          <Link
            to="/admin"
            className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 px-3 py-1.5 rounded"
          >
            Admin →
          </Link>
        </div>

        {/* Top-line KPIs */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          {[
            { label: 'Total events', value: totalEvents },
            { label: 'Participants served', value: totalParticipants },
            { label: 'Purchase success rate', value: `${pct(totalPurchased, totalParticipants)}%` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-center">
              <div className="text-4xl font-bold font-mono text-yellow-400">{value}</div>
              <div className="text-gray-500 text-sm mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* Year-by-year table */}
        <section className="mb-10">
          <h2 className="text-lg font-bold text-white mb-4">Year by Year</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b border-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left">Year</th>
                  <th className="px-4 py-3 text-left">Type</th>
                  <th className="px-4 py-3 text-right">Participants</th>
                  <th className="px-4 py-3 text-right">Got badges</th>
                  <th className="px-4 py-3 text-right">Success %</th>
                  <th className="px-4 py-3 text-right">Paid %</th>
                  <th className="px-4 py-3 text-right">Jr</th>
                  <th className="px-4 py-3 text-left w-48">Participants</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {stats.years.map((y) => (
                  <tr key={`${y.year}-${y.reg_type}`} className="hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-bold text-white">{y.year}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                        y.reg_type === 'return'
                          ? 'bg-purple-900/60 text-purple-300'
                          : 'bg-teal-900/60 text-teal-300'
                      }`}>
                        {y.reg_type === 'return' ? 'Return' : 'Open'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{y.total}</td>
                    <td className="px-4 py-3 text-right font-mono text-green-400">{y.purchased_any}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className={pct(y.purchased_any, y.total) >= 90 ? 'text-green-400' : pct(y.purchased_any, y.total) >= 75 ? 'text-yellow-400' : 'text-red-400'}>
                        {pct(y.purchased_any, y.total)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">{pct(y.paid_count, y.total)}%</td>
                    <td className="px-4 py-3 text-right text-xs text-gray-500">{y.junior_count}</td>
                    <td className="px-4 py-3">
                      <Bar value={y.total} max={maxParticipants} color={y.reg_type === 'return' ? 'bg-purple-500' : 'bg-teal-500'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Day popularity heatmap */}
        <section className="mb-10">
          <h2 className="text-lg font-bold text-white mb-4">Day Popularity</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b border-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left">Year / Type</th>
                  {DAYS.map((d) => (
                    <th key={d} className="px-3 py-3 text-center">{DAY_LABEL[d]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {stats.years.map((y) => (
                  <tr key={`${y.year}-${y.reg_type}-days`} className="hover:bg-gray-800/50">
                    <td className="px-4 py-3 text-gray-300">
                      {y.year} {y.reg_type === 'return' ? 'Return' : 'Open'}
                    </td>
                    {DAYS.map((d) => {
                      const req = y[`req_${d}` as keyof YearStat] as number;
                      const pur = y[`pur_${d}` as keyof YearStat] as number;
                      const pctReq = pct(req, y.total);
                      const pctPur = req > 0 ? pct(pur, req) : null;
                      return (
                        <td key={d} className="px-3 py-3 text-center">
                          <div className="text-xs text-gray-400">{req > 0 ? `${pctReq}% req` : <span className="text-gray-700">—</span>}</div>
                          {pctPur !== null && (
                            <div className={`text-xs font-medium ${pctPur >= 90 ? 'text-green-400' : pctPur >= 70 ? 'text-yellow-400' : 'text-red-400'}`}>
                              {pctPur}% got
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Two-column: top buyers + retention */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top buyers */}
          <section>
            <h2 className="text-lg font-bold text-white mb-4">Top Buyers</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
              {stats.top_buyers.slice(0, 15).map((b, i) => (
                <div key={b.name} className="flex items-center gap-3">
                  <span className="text-gray-600 text-sm w-5 text-right">{i + 1}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-white text-sm font-medium">{b.name}</span>
                      <span className="text-gray-400 text-xs">{b.participants_served} people · {b.years_active}yr</span>
                    </div>
                    <Bar
                      value={b.participants_served}
                      max={stats.top_buyers[0]?.participants_served ?? 1}
                      color="bg-yellow-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Retention */}
          <section>
            <h2 className="text-lg font-bold text-white mb-4">Multi-Year Members</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {stats.retention.map((m) => (
                  <div key={m.member_id} className="flex items-center justify-between py-1.5 border-b border-gray-800 last:border-0">
                    <div>
                      <span className="text-white text-sm">{m.first_name} {m.last_name}</span>
                      <span className="ml-2">
                        <MemberId
                          value={m.member_id}
                          letterClassName="text-gray-500"
                          digitClassName="text-amber-500"
                        />
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-0.5">
                        {m.years.split(',').map((yr) => (
                          <span key={yr} className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded">
                            {yr}
                          </span>
                        ))}
                      </div>
                      <span className={`text-xs font-bold w-4 text-right ${m.year_count >= 4 ? 'text-yellow-400' : 'text-gray-500'}`}>
                        ×{m.year_count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
