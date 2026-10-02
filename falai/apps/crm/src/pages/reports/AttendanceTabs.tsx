import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle, PhoneMissed, PhoneOff, Clock, Timer, Zap, PhoneIncoming } from 'lucide-react';
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label={t('reports.att.tma')} value={dur(c.tmaSecs)} sub={t('reports.att.tmaHint')} icon={<Clock className="h-5 w-5" />} />
        <StatCard label={t('reports.att.tme')} value={dur(c.tmeSecs)} sub={t('reports.att.tmeHint')} icon={<Timer className="h-5 w-5" />} />
        {!r.limited && (
          <StatCard label={t('reports.att.response')} value={dur(a.responseSecs)} sub={t('reports.att.responseHint')} icon={<Zap className="h-5 w-5" />} />
        )}
      </div>
      {filtered && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-900">{t('reports.att.vsTenant')}</h2>
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            {[
              [t('reports.att.answerRate'), pct(c.answerRate), pct(r.tenant.calls.answerRate)],
              [t('reports.att.tma'), dur(c.tmaSecs), dur(r.tenant.calls.tmaSecs)],
              [t('reports.att.tme'), dur(c.tmeSecs), dur(r.tenant.calls.tmeSecs)],
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
            <Th right>{t('reports.att.rejected')}</Th>
            <Th right>{t('reports.att.answerRate')}</Th>
            <Th right>{t('reports.att.tma')}</Th>
            <Th right>{t('reports.att.tme')}</Th>
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
              <Td right>{g.rejected}</Td>
              <Td right>{pct(g.answerRate)} <Delta value={g.vsTenant.answerRate} unit="%" /></Td>
              <Td right>{dur(g.tmaSecs)} <Delta value={g.vsTenant.tmaSecs} unit="s" lowerIsBetter /></Td>
              <Td right>{dur(g.tmeSecs)} <Delta value={g.vsTenant.tmeSecs} unit="s" lowerIsBetter /></Td>
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
              <Td>{formatPhone(c.from)}</Td>
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
