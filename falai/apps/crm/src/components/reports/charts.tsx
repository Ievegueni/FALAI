import type { ReactNode } from 'react';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { clsx } from '@/lib/utils';

/**
 * Peças dos gráficos dos Relatórios (estilo painel): cartão com valor,
 * variação face ao período anterior e tendência; cartão com anel.
 *
 * Cores: paleta categórica validada (dataviz, modo claro), em ordem fixa.
 * Três tons ficam abaixo de 3:1 no fundo branco — por isso os anéis levam
 * sempre a legenda com rótulo, valor e % (nunca só cor).
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];

/** "21h 43min" / "32min 27s" / "45s". */
export function fmtSecs(s: number | null): string {
  if (s === null) return '—';
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${m}min` : r > 0 ? `${m}min ${r}s` : `${m}min`;
}

const fmtInt = (n: number) => n.toLocaleString('pt-PT');

export interface KpiTileProps {
  label: string;
  value: number | null;
  unit: 'count' | 'secs';
  deltaPct: number | null;
  /** Se subir é bom, mau ou indiferente — decide a cor (texto + seta, nunca só cor). */
  good: 'up' | 'down' | 'neutral';
  series: (number | null)[];
  dates: string[];
  color: string;
  icon: ReactNode;
  sub?: string;
  deltaLabel: string; // "vs. período anterior"
  noCompare: string; // "sem comparação"
}

export function KpiTile({ label, value, unit, deltaPct, good, series, dates, color, icon, sub, deltaLabel, noCompare }: KpiTileProps) {
  const fmt = (v: number | null) => (v === null ? '—' : unit === 'secs' ? fmtSecs(v) : fmtInt(v));
  const up = (deltaPct ?? 0) > 0;
  const tone =
    deltaPct === null || deltaPct === 0 || good === 'neutral'
      ? 'text-gray-500'
      : (good === 'up') === up
        ? 'text-emerald-700'
        : 'text-red-600';
  const Arrow = deltaPct === null || deltaPct === 0 ? Minus : up ? TrendingUp : TrendingDown;
  const data = series.map((v, i) => ({ v, d: dates[i] }));
  const hasTrend = series.filter((v) => v !== null).length >= 2;
  const gid = `g-${label.replace(/\W/g, '')}`;

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-gray-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{fmt(value)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-2 text-gray-500">{icon}</div>
      </div>
      <p className={clsx('mt-1 flex items-center gap-1 text-xs', tone)}>
        <Arrow className="h-3.5 w-3.5" aria-hidden />
        {deltaPct === null ? noCompare : `${up ? '+' : ''}${deltaPct.toLocaleString('pt-PT')}% ${deltaLabel}`}
      </p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
      <div className="mt-2 h-12">
        {hasTrend && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Tooltip
                cursor={{ stroke: '#d4d4d0', strokeWidth: 1 }}
                contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e5e5e0', padding: '4px 8px' }}
                labelFormatter={(_, p) => (p?.[0]?.payload?.d ? new Date(p[0].payload.d).toLocaleDateString('pt-PT') : '')}
                formatter={(v) => [fmt(v as number), label]}
              />
              <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gid})`} connectNulls dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export function DonutCard({ title, slices, emptyText }: { title: string; slices: { label: string; value: number }[]; emptyText: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {total === 0 ? (
        <p className="py-16 text-center text-sm text-gray-400">{emptyText}</p>
      ) : (
        <>
          <div className="relative mx-auto mt-2 h-44 w-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="62%"
                  outerRadius="100%"
                  startAngle={90}
                  endAngle={-270}
                  stroke="#ffffff"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {slices.map((s, i) => (
                    <Cell key={s.label} fill={SERIES[i % SERIES.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e5e5e0', padding: '4px 8px' }}
                  formatter={(v, name) => [`${fmtInt(v as number)} · ${Math.round(((v as number) / total) * 100)}%`, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-semibold text-gray-900">{fmtInt(total)}</span>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5">
            {slices.map((s, i) => (
              <li key={s.label} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-gray-600">{s.label}</span>
                <span className="tabular-nums text-gray-900">{fmtInt(s.value)}</span>
                <span className="w-10 text-right tabular-nums text-gray-500">{Math.round((s.value / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
