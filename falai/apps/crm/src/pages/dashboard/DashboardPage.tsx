import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Phone, TrendingUp, Clock, DollarSign, Bot, Megaphone, Plus } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { dashboardApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Card, StatCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PageSpinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import {
  formatAOA,
  formatDuration,
  formatDate,
  callStatusLabel,
  callStatusColor,
} from '@/lib/utils';
import type { Call } from '@/types';

function CallRow({ call }: { call: Call }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer"
      onClick={() => navigate(`/calls/${call.id}`)}
    >
      <td className="px-4 py-3 text-sm text-gray-900">{call.contact?.name ?? call.to}</td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.kind === 'OTP' ? (
          <Badge className="bg-indigo-100 text-indigo-700">{t('dashboard.otpVerification')}</Badge>
        ) : call.kind === 'DIRECT' ? (
          <Badge className="bg-slate-100 text-slate-600">{t('dashboard.directCall')}</Badge>
        ) : (
          call.agent?.name || '—'
        )}
      </td>
      <td className="px-4 py-3">
        <Badge className={callStatusColor[call.status]}>{callStatusLabel(call.status)}</Badge>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.durationSecs !== null ? formatDuration(call.durationSecs) : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.costCents !== null ? formatAOA(call.costCents) : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400">{formatDate(call.createdAt)}</td>
    </tr>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardApi.metrics,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <>
        <Header title={t('nav.dashboard')} />
        <PageSpinner />
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <Header title={t('nav.dashboard')} />
        <div className="p-6 text-center text-sm text-gray-500">
          {t('dashboard.loadError')}
        </div>
      </>
    );
  }

  const chartData = data.chartData.map((p) => ({
    ...p,
    date: new Date(p.date).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit' }),
  }));

  return (
    <>
      <Header
        title={t('nav.dashboard')}
        actions={
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate('/calls/new')}>
            {t('dashboard.newCall')}
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label={t('dashboard.callsToday')}
            value={data.callsToday}
            icon={<Phone className="h-5 w-5" />}
          />
          <StatCard
            label={t('dashboard.answerRate')}
            value={`${data.answerRatePct.toFixed(1)}%`}
            sub={t('dashboard.thisMonth')}
            icon={<TrendingUp className="h-5 w-5" />}
          />
          <StatCard
            label={t('dashboard.avgDuration')}
            value={formatDuration(data.avgDurationSecs)}
            icon={<Clock className="h-5 w-5" />}
          />
          <StatCard
            label={t('dashboard.avgCost')}
            value={formatAOA(data.avgCostCents)}
            sub={t('dashboard.perCall')}
            icon={<DollarSign className="h-5 w-5" />}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <StatCard
            label={t('dashboard.activeAgents')}
            value={data.activeAgents}
            icon={<Bot className="h-5 w-5" />}
          />
          <StatCard
            label={t('dashboard.activeCampaigns')}
            value={data.activeCampaigns}
            icon={<Megaphone className="h-5 w-5" />}
          />
        </div>

        {/* Chart */}
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('dashboard.callsLast7Days')}</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="answeredGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                formatter={(value: number, name: string) => [
                  value,
                  name === 'total' ? t('dashboard.total') : t('dashboard.answered'),
                ]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#totalGrad)"
              />
              <Area
                type="monotone"
                dataKey="answered"
                stroke="#10b981"
                strokeWidth={2}
                fill="url(#answeredGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Recent calls */}
        <Card padding={false}>
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">{t('dashboard.recentCalls')}</h2>
            <button
              onClick={() => navigate('/calls')}
              className="text-xs text-blue-600 hover:underline"
            >
              {t('dashboard.viewAll')}
            </button>
          </div>
          {data.recentCalls.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">
              {t('dashboard.noCalls')} <button onClick={() => navigate('/calls/new')} className="text-blue-600 hover:underline">{t('dashboard.makeFirst')}</button>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {[t('dashboard.colContact'), t('dashboard.colAgent'), t('dashboard.colStatus'), t('dashboard.colDuration'), t('dashboard.colCost'), t('dashboard.colDate')].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.recentCalls.map((call) => (
                  <CallRow key={call.id} call={call} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
