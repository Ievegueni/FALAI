import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle, PhoneMissed, PhoneOff, Clock, Timer, Zap, PhoneIncoming, Target, Hourglass, LogOut } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SERIES } from '@/components/reports/charts';
import { reportsApi, type AttendanceFilters, type AttendanceReport, type CallLegOutcome } from '@/lib/api';
import { Card, StatCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { clsx, formatDuration, formatPhone } from '@/lib/utils';

/**
 * Separadores de atendimento da aba Relatórios. Os números vêm calculados do
 * backend (GET /tenant/reports/attendance) — aqui só se mostram.
 */

export type AttendanceView = 'attendance' | 'agents' | 'groups' | 'reasons' | 'typing' | 'calls';

const dur = (s: number | null) => (s === null ? '—' : formatDuration(s));
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/**
 * Diferença para a média do tenant. `lowerIsBetter` para tempos: um TMA
 * abaixo da média aparece a verde.
 */
function Delta({ value, unit, lowerIsBetter }: { value: number | null; unit: 's' | '%'; lowerIsBetter?: boolean }) {
  if (value === null || value === 0) return <span className="text-xs text-gray-400">=</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  return (
    <span className={clsx('text-xs font-medium', good ? 'text-emerald-600' : 'text-red-600')}>
      {value > 0 ? '+' : ''}
      {unit === 's' ? `${value}s` : `${value} p.p.`}
    </span>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={clsx('px-4 py-2.5 font-medium', right && 'text-right')}>{children}</th>;
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={clsx('px-4 py-2.5 text-gray-700', right && 'text-right tabular-nums')}>{children}</td>;
}

function Empty() {
  const { t } = useTranslation();
  return <p className="py-8 text-center text-sm text-gray-400">{t('reports.noData')}</p>;
}

function Overview({ r, filtered }: { r: AttendanceReport; filtered: boolean }) {
  const { t } = useTranslation();
  const c = r.selection.calls;
  const a = r.selection.agents;
  return (
    <div className="space-y-4">
      {r.limited && (
        <Card className="text-sm text-amber-700 bg-amber-50 border-amber-200">{t('reports.att.limited')}</Card>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('reports.att.calls')} value={c.total} icon={<PhoneIncoming className="h-5 w-5" />} />
        <StatCard label={t('reports.answered')} value={c.answered} sub={pct(c.answerRate)} icon={<CheckCircle className="h-5 w-5" />} />
        <StatCard
          label={t('reports.missed')}
          value={c.missed}
          sub={t('reports.att.abandonedSub', { count: c.abandoned })}
          icon={<PhoneMissed className="h-5 w-5" />}
        />
        {!r.limited && (
          <StatCard label={t('reports.att.rejected')} value={a.rejected} sub={pct(a.rejectRate)} icon={<PhoneOff className="h-5 w-5" />} />
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('reports.att.sla')}
          value={<span className={slaTone(c.slaPct, r.slaTargetPct)}>{pct(c.slaPct)}</span>}
          sub={r.slaTargetPct !== null ? t('reports.att.slaHintTarget', { secs: r.slaSecs, target: r.slaTargetPct }) : t('reports.att.slaHint', { secs: r.slaSecs })}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard label={t('reports.att.tme')} value={dur(c.tmeSecs)} sub={t('reports.att.tmeHint')} icon={<Timer className="h-5 w-5" />} />
        <StatCard label={t('reports.att.asaP90')} value={dur(c.asaP90Secs)} sub={t('reports.att.asaP90Hint')} icon={<Hourglass className="h-5 w-5" />} />
        <StatCard label={t('reports.att.maxWait')} value={dur(c.maxWaitSecs)} sub={t('reports.att.maxWaitHint')} icon={<Hourglass className="h-5 w-5" />} />
        <StatCard label={t('reports.att.tma')} value={dur(c.tmaSecs)} sub={t('reports.att.tmaHint')} icon={<Clock className="h-5 w-5" />} />
        {!r.limited && (
          <StatCard label={t('reports.att.response')} value={dur(a.responseSecs)} sub={t('reports.att.responseHint')} icon={<Zap className="h-5 w-5" />} />
        )}
        {!r.limited && (
          <StatCard label={t('reports.att.abandonRate')} value={pct(c.abandonRate)} sub={t('reports.att.abandonRateHint', { count: c.abandoned - c.shortAbandoned })} icon={<LogOut className="h-5 w-5" />} />
        )}
        {!r.limited && r.shortAbandonSecs > 0 && (
          <StatCard label={t('reports.att.shortAbandoned')} value={c.shortAbandoned} sub={t('reports.att.shortAbandonedHint', { secs: r.shortAbandonSecs })} icon={<PhoneMissed className="h-5 w-5" />} />
        )}
      </div>
      {!r.limited && <SlaTrend r={r} />}
      {!r.limited && <HourlyChart r={r} />}
      {!r.limited && <Heatmap grid={r.byWeekdayHour} />}
      {filtered && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-900">{t('reports.att.vsTenant')}</h2>
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
            {[
              [t('reports.att.answerRate'), pct(c.answerRate), pct(r.tenant.calls.answerRate)],
              [t('reports.att.sla'), pct(c.slaPct), pct(r.tenant.calls.slaPct)],
              [t('reports.att.tma'), dur(c.tmaSecs), dur(r.tenant.calls.tmaSecs)],
              [t('reports.att.tme'), dur(c.tmeSecs), dur(r.tenant.calls.tmeSecs)],
              [t('reports.att.asaP90'), dur(c.asaP90Secs), dur(r.tenant.calls.asaP90Secs)],
              [t('reports.att.response'), dur(a.responseSecs), dur(r.tenant.agents.responseSecs)],
            ].map(([label, sel, ten]) => (
              <div key={label}>
                <p className="text-gray-500">{label}</p>
                <p className="font-semibold text-gray-900">{sel}</p>
                <p className="text-xs text-gray-400">{t('reports.att.tenantAvg', { value: ten })}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** Verde se cumpre a meta, vermelho se não; sem meta, sem cor. */
function slaTone(v: number | null, target: number | null) {
  if (v === null || target === null) return undefined;
  return v >= target ? 'text-emerald-700' : 'text-red-600';
}

const TOOLTIP = { fontSize: 12, borderRadius: 8, borderColor: '#e5e5e0', padding: '4px 8px' };
const AXIS = { fontSize: 11, fill: '#6b6b66' };

/** SLA por dia contra a meta (linha tracejada). */
function SlaTrend({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  const data = r.byDay.filter((d) => d.total > 0).map((d) => ({ d: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, sla: d.slaPct, asa: d.tmeSecs }));
  if (data.length < 2) return null;
  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">{t('reports.att.slaTrend')}</h2>
      <p className="mb-3 text-xs text-gray-400">{r.slaTargetPct !== null ? t('reports.att.slaTrendHint') : t('reports.att.slaHint', { secs: r.slaSecs })}</p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#eeeeea" vertical={false} />
            <XAxis dataKey="d" tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} unit="%" />
            <Tooltip contentStyle={TOOLTIP} formatter={(v) => [`${v}%`, t('reports.att.sla')]} />
            {r.slaTargetPct !== null && <ReferenceLine y={r.slaTargetPct} stroke="#d03b3b" strokeDasharray="4 4" label={{ value: `${t('reports.att.target')} ${r.slaTargetPct}%`, fontSize: 11, fill: '#d03b3b', position: 'insideTopRight' }} />}
            <Line type="monotone" dataKey="sla" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** Atendidas/perdidas por hora (barras) e o SLA dessa hora (linha, eixo da direita). */
function HourlyChart({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  const active = r.byHour.filter((h) => h.total > 0);
  if (!active.length) return null;
  // Só das primeiras às últimas horas com chamadas (sem a madrugada vazia).
  const first = active[0]!.hour;
  const last = active[active.length - 1]!.hour;
  const data = r.byHour.slice(first, last + 1).map((h) => ({ h: `${String(h.hour).padStart(2, '0')}h`, answered: h.answered, missed: h.missed, sla: h.slaPct, asa: h.tmeSecs }));
  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">{t('reports.att.byHour')}</h2>
      <p className="mb-3 text-xs text-gray-400">{t('reports.att.byHourHint')}</p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#eeeeea" vertical={false} />
            <XAxis dataKey="h" tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis yAxisId="n" allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis yAxisId="p" orientation="right" domain={[0, 100]} unit="%" tick={AXIS} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={TOOLTIP}
              formatter={(v, name, item) => {
                if (name === t('reports.att.sla')) return [`${v ?? '—'}% · ${t('reports.att.tme')} ${dur((item.payload as { asa: number | null }).asa)}`, name];
                return [v as number, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="n" dataKey="answered" stackId="c" name={t('reports.answered')} fill={SERIES[0]} isAnimationActive={false} />
            <Bar yAxisId="n" dataKey="missed" stackId="c" name={t('reports.missed')} fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Line yAxisId="p" type="monotone" dataKey="sla" name={t('reports.att.sla')} stroke={SERIES[2]} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            {r.slaTargetPct !== null && <ReferenceLine yAxisId="p" y={r.slaTargetPct} stroke="#d03b3b" strokeDasharray="4 4" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** Mapa de calor dia da semana × hora; o número vai sempre na célula (nunca só cor). */
function Heatmap({ grid }: { grid: number[][] }) {
  const { t } = useTranslation();
  const max = Math.max(0, ...grid.flat());
  if (!max) return null;
  const days = t('reports.att.weekdays', { returnObjects: true }) as string[];
  return (
    <Card className="overflow-x-auto">
      <h2 className="text-sm font-semibold text-gray-900">{t('reports.att.heatmap')}</h2>
      <p className="mb-3 text-xs text-gray-400">{t('reports.att.heatmapHint')}</p>
      <table className="border-separate border-spacing-0.5 text-[11px] tabular-nums">
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => <th key={h} className="w-7 font-normal text-gray-400">{String(h).padStart(2, '0')}</th>)}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, d) => (
            <tr key={d}>
              <th className="pr-2 text-left font-normal text-gray-500">{days[d]}</th>
              {row.map((n, h) => {
                const k = n / max;
                return (
                  <td
                    key={h}
                    title={`${days[d]} ${String(h).padStart(2, '0')}h: ${n}`}
                    className="h-7 w-7 rounded text-center"
                    style={{ background: n ? `rgba(42, 120, 214, ${0.12 + k * 0.88})` : '#f5f5f2', color: k > 0.55 ? '#fff' : '#3d3d3a' }}
                  >
                    {n || ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function AgentsTable({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  if (r.byAgent.length === 0) return <Card><Empty /></Card>;
  return (
    <Card padding={false} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            <Th>{t('reports.att.agent')}</Th>
            <Th right>{t('reports.att.offered')}</Th>
            <Th right>{t('reports.answered')}</Th>
            <Th right>{t('reports.att.rejected')}</Th>
            <Th right>{t('reports.att.noAnswer')}</Th>
            <Th right>{t('reports.att.answerRate')}</Th>
            <Th right>{t('reports.att.tma')}</Th>
            <Th right>{t('reports.att.response')}</Th>
            <Th right>{t('reports.att.untypedRate')}</Th>
            <Th right>{t('reports.att.wrapUp')}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {r.byAgent.map((a) => (
            <tr key={a.extensionId ?? a.number}>
              <Td>
                <span className="font-medium text-gray-900">{a.number}</span>
                {a.name && a.name !== a.number && <span className="ml-2 text-gray-400">{a.name}</span>}
              </Td>
              <Td right>{a.offered}</Td>
              <Td right>{a.answered}</Td>
              <Td right>{a.rejected}</Td>
              <Td right>{a.noAnswer + a.busy}</Td>
              <Td right>{pct(a.answerRate)} <Delta value={a.vsTenant.answerRate} unit="%" /></Td>
              <Td right>{dur(a.tmaSecs)} <Delta value={a.vsTenant.tmaSecs} unit="s" lowerIsBetter /></Td>
              <Td right>{dur(a.responseSecs)} <Delta value={a.vsTenant.responseSecs} unit="s" lowerIsBetter /></Td>
              <Td right>{pct(a.untypedRate)}</Td>
              <Td right>{dur(a.wrapUpSecs)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-gray-400">{t('reports.att.deltaHint')}</p>
    </Card>
  );
}

function GroupsTable({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  if (r.byGroup.length === 0) return <Card><Empty /></Card>;
  return (
    <Card padding={false} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            <Th>{t('reports.att.group')}</Th>
            <Th right>{t('reports.att.calls')}</Th>
            <Th right>{t('reports.answered')}</Th>
            <Th right>{t('reports.missed')}</Th>
            <Th right>{t('reports.att.abandoned')}</Th>
            <Th right>{t('reports.att.shortAbandoned')}</Th>
            <Th right>{t('reports.att.rejected')}</Th>
            <Th right>{t('reports.att.sla')}</Th>
            <Th right>{t('reports.att.slaTarget')}</Th>
            <Th right>{t('reports.att.answerRate')}</Th>
            <Th right>{t('reports.att.abandonRate')}</Th>
            <Th right>{t('reports.att.tma')}</Th>
            <Th right>{t('reports.att.tme')}</Th>
            <Th right>{t('reports.att.asaP90')}</Th>
            <Th right>{t('reports.att.maxWait')}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {r.byGroup.map((g) => (
            <tr key={g.groupId ?? 'direct'}>
              <Td><span className="font-medium text-gray-900">{g.groupId ? g.name : t('reports.att.direct')}</span></Td>
              <Td right>{g.total}</Td>
              <Td right>{g.answered}</Td>
              <Td right>{g.missed}</Td>
              <Td right>{g.abandoned}</Td>
              <Td right>{g.shortAbandoned}</Td>
              <Td right>{g.rejected}</Td>
              <Td right><span className={clsx('font-medium', slaTone(g.slaPct, g.slaTargetPct))}>{pct(g.slaPct)}</span> <Delta value={g.vsTenant.slaPct} unit="%" /></Td>
              <Td right>{g.slaTargetPct === null ? '—' : `${g.slaTargetPct}% · ${g.slaSecs}s`}</Td>
              <Td right>{pct(g.answerRate)} <Delta value={g.vsTenant.answerRate} unit="%" /></Td>
              <Td right>{pct(g.abandonRate)}</Td>
              <Td right>{dur(g.tmaSecs)} <Delta value={g.vsTenant.tmaSecs} unit="s" lowerIsBetter /></Td>
              <Td right>{dur(g.tmeSecs)} <Delta value={g.vsTenant.tmeSecs} unit="s" lowerIsBetter /></Td>
              <Td right>{dur(g.asaP90Secs)}</Td>
              <Td right>{dur(g.maxWaitSecs)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-gray-400">{t('reports.att.deltaHint')}</p>
    </Card>
  );
}

function Reasons({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  if (r.reasons.length === 0) return <Card><Empty /></Card>;
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-gray-900">{t('reports.att.reasonsTitle')}</h2>
      <p className="mb-4 text-xs text-gray-400">{t('reports.att.reasonsHint')}</p>
      <div className="space-y-2">
        {r.reasons.map((x) => (
          <div key={x.reason} className="flex items-center gap-3">
            <span className="w-48 shrink-0 truncate text-sm text-gray-600">{x.reason}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-red-400" style={{ width: `${x.pct}%` }} />
            </div>
            <span className="w-24 shrink-0 text-right text-sm font-medium text-gray-700 tabular-nums">
              {x.count} · {x.pct}%
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Volume por categoria/subcategoria (melhoria 2). */
function Typing({ r }: { r: AttendanceReport }) {
  const { t } = useTranslation();
  const a = r.selection.agents;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label={t('reports.att.typed')} value={a.typed} icon={<CheckCircle className="h-5 w-5" />} />
        <StatCard label={t('reports.att.untyped')} value={a.untyped} sub={pct(a.untypedRate)} icon={<PhoneMissed className="h-5 w-5" />} />
        <StatCard label={t('reports.att.wrapUp')} value={dur(a.wrapUpSecs)} sub={t('reports.att.wrapUpHint')} icon={<Timer className="h-5 w-5" />} />
      </div>
      <Card>
        <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('reports.att.typingTitle')}</h2>
        {r.typing.length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-2">
            {r.typing.map((x) => (
              <div key={`${x.category}|${x.subcategory ?? ''}`} className="flex items-center gap-3">
                <span className="w-64 shrink-0 truncate text-sm text-gray-600">
                  {x.category}
                  {x.subcategory && <span className="text-gray-400"> › {x.subcategory}</span>}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-blue-400" style={{ width: `${x.pct}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right text-sm font-medium text-gray-700 tabular-nums">
                  {x.count} · {x.pct}%
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const GREY = 'bg-gray-100 text-gray-600';
const OUTCOME_CLASS: Record<CallLegOutcome, string> = {
  ANSWERED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-red-50 text-red-700',
  BUSY: 'bg-amber-50 text-amber-700',
  NO_ANSWER: 'bg-amber-50 text-amber-700',
  CANCELLED: GREY,
  FAILED: GREY,
};

function CallsList({ filters }: { filters: AttendanceFilters }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'attendance', 'calls', filters, page],
    queryFn: () => reportsApi.attendanceCalls({ ...filters, page, pageSize }),
  });
  if (isLoading || !data) return <PageSpinner />;
  if (data.total === 0) return <Card><Empty /></Card>;
  return (
    <Card padding={false} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            <Th>{t('reports.att.when')}</Th>
            <Th>{t('reports.att.caller')}</Th>
            <Th>{t('reports.att.group')}</Th>
            <Th right>{t('reports.att.wait')}</Th>
            <Th right>{t('reports.att.talk')}</Th>
            <Th>{t('reports.att.legs')}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {data.data.map((c) => (
            <tr key={c.id}>
              <Td>{new Date(c.startedAt).toLocaleString()}</Td>
              <Td>
                {c.contactId ? (
                  <Link to={`/contacts/${c.contactId}`} className="text-blue-600 hover:underline" title={t('profile.open')}>
                    {c.contactName || formatPhone(c.from)}
                  </Link>
                ) : formatPhone(c.from)}
                {c.contactId && c.contactName && <span className="block text-xs text-gray-400">{formatPhone(c.from)}</span>}
              </Td>
              <Td>{c.group ?? '—'}</Td>
              <Td right>{dur(c.waitSecs)}</Td>
              <Td right>{c.answered ? dur(c.talkSecs) : <Badge className="bg-red-50 text-red-700">{t('reports.att.missedShort')}</Badge>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {c.legs.map((l, i) => (
                    <Badge key={i} className={l.outcome ? OUTCOME_CLASS[l.outcome] : GREY}>
                      {l.extension} · {t(`reports.att.outcome.${l.outcome ?? 'RINGING'}`)}
                      {l.reason ? ` (${l.reason})` : ''}
                      {l.typing ? ` · ${l.typing}` : ''}
                    </Badge>
                  ))}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-3">
        <Pagination page={page} total={data.total} perPage={pageSize} onPage={setPage} />
      </div>
    </Card>
  );
}

export function AttendanceTab({ view, filters }: { view: AttendanceView; filters: AttendanceFilters }) {
  const filtered = Boolean(filters.extensionId || filters.groupId || filters.categoryId);
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'attendance', filters],
    queryFn: () => reportsApi.attendance(filters),
    enabled: view !== 'calls',
  });
  if (view === 'calls') return <CallsList filters={filters} />;
  if (isLoading || !data) return <PageSpinner />;
  if (view === 'agents') return data.limited ? <Overview r={data} filtered={filtered} /> : <AgentsTable r={data} />;
  if (view === 'groups') return data.limited ? <Overview r={data} filtered={filtered} /> : <GroupsTable r={data} />;
  if (view === 'reasons') return data.limited ? <Overview r={data} filtered={filtered} /> : <Reasons r={data} />;
  if (view === 'typing') return data.limited ? <Overview r={data} filtered={filtered} /> : <Typing r={data} />;
  return <Overview r={data} filtered={filtered} />;
}
