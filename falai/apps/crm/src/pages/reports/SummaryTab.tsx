import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  UserPlus,
  Clock,
  Hourglass,
  Zap,
  ClipboardCheck,
  MessageSquare,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { reportsApi } from '@/lib/api';
import { Card, StatCard } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { KpiTile, DonutCard, SERIES } from '@/components/reports/charts';
import { formatAOA } from '@/lib/utils';

/**
 * Resumo (estilo painel): cartões com variação face ao período anterior e
 * tendência diária, anéis por grupo / estado / tipificação e chamadas por dia.
 * Os números vêm calculados de GET /tenant/reports/overview.
 */

const TILES: { key: string; icon: typeof Phone }[] = [
  { key: 'total', icon: Phone },
  { key: 'inbound', icon: PhoneIncoming },
  { key: 'outbound', icon: PhoneOutgoing },
  { key: 'newContacts', icon: UserPlus },
  { key: 'tma', icon: Clock },
  { key: 'tme', icon: Hourglass },
  { key: 'response', icon: Zap },
  { key: 'wrapUp', icon: ClipboardCheck },
];

export function SummaryTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'overview', from, to], queryFn: () => reportsApi.overview({ from, to }) });
  // SMS e "por resultado" continuam a vir do resumo de chamadas que já existia.
  const { data: summary } = useQuery({ queryKey: ['reports', from, to], queryFn: () => reportsApi.summary({ from, to }) });

  if (isLoading || !data) return <PageSpinner />;
  const dates = data.daily.map((d) => d.date);
  const tile = (key: string) => data.tiles.find((x) => x.key === key)!;
  const daily = data.daily.map((d) => ({
    date: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`,
    [t('reports.total')]: d.total,
    [t('reports.answered')]: d.answered,
  }));

  return (
    <div className="space-y-6">
      {data.limited && (
        <Card className="text-sm text-amber-700 bg-amber-50 border-amber-200">{t('reports.att.limited')}</Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map(({ key, icon: Icon }, i) => {
          const x = tile(key);
          return (
            <KpiTile
              key={key}
              label={t(`reports.tiles.${key}`)}
              sub={t(`reports.tilesSub.${key}`, { defaultValue: '' }) || undefined}
              value={x.value}
              unit={x.unit}
              deltaPct={x.deltaPct}
              good={x.good}
              series={x.series}
              dates={dates}
              color={SERIES[i % 4]!}
              icon={<Icon className="h-4 w-4" />}
              deltaLabel={t('reports.vsPrevious')}
              noCompare={t('reports.noCompare')}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DonutCard title={t('reports.donut.byGroup')} slices={data.donuts.byGroup} emptyText={t('reports.noData')} />
        <DonutCard title={t('reports.donut.byState')} slices={data.donuts.byState} emptyText={t('reports.noData')} />
        <DonutCard title={t('reports.donut.byTyping')} slices={data.donuts.byTyping} emptyText={t('reports.noData')} />
      </div>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('reports.byDay')}</h2>
        {daily.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">{t('reports.noData')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barGap={-12}>
              <CartesianGrid vertical={false} stroke="#efefec" />
              <XAxis dataKey="date" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip cursor={{ fill: '#f5f5f2' }} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e5e5e0' }} />
              <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              {/* Atendidas por cima do total (mesma coluna): o claro é o que ficou por atender. */}
              <Bar dataKey={t('reports.total')} fill="#a9c8ef" radius={[4, 4, 0, 0]} maxBarSize={12} isAnimationActive={false} />
              <Bar dataKey={t('reports.answered')} fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={12} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {summary && summary.sms.total > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label={t('reports.smsSent')} value={summary.sms.sent} icon={<MessageSquare className="h-5 w-5" />} />
          <StatCard label={t('reports.smsFailed')} value={summary.sms.failed} icon={<MessageSquare className="h-5 w-5" />} />
          <StatCard label={t('reports.smsCost')} value={formatAOA(summary.sms.costCents)} icon={<MessageSquare className="h-5 w-5" />} />
        </div>
      )}

      {summary && summary.byOutcome.length > 0 && (
        <Card>
          <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('reports.byOutcome')}</h2>
          <div className="space-y-2">
            {summary.byOutcome.map((o) => {
              const pct = summary.totals.total > 0 ? (o.count / summary.totals.total) * 100 : 0;
              return (
                <div key={o.outcome} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm text-gray-600">{o.outcome}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: SERIES[0] }} />
                  </div>
                  <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-gray-700">{o.count}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
