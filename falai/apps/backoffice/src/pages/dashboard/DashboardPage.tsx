import { useQuery } from '@tanstack/react-query';
import { Users, Phone, Clock, TrendingUp, ShieldCheck, Activity } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { dashboardApi, tenantsApi } from '@/lib/api';
import { Card, StatCard, PageSpinner, Badge } from '@/components/ui';
import { formatAOA, formatDate } from '@/lib/utils';

export function DashboardPage() {
  const { data: metrics, isLoading } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: () => dashboardApi.metrics(),
    refetchInterval: 15_000,
  });

  const { data: tenantsList } = useQuery({
    queryKey: ['admin', 'tenants', 'recent'],
    queryFn: () => tenantsApi.list({ page: 1, perPage: 5 }),
    refetchInterval: 60_000,
  });

  if (isLoading) return <PageSpinner />;

  const m = metrics;
  const chart = m?.chartData ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">Visão geral do sistema Falaí</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Tenants activos" value={m?.tenantsActive ?? '–'} icon={<Users className="h-5 w-5" />} />
        <StatCard label="Chamadas hoje" value={m?.callsToday ?? '–'} icon={<Phone className="h-5 w-5" />} />
        <StatCard label="Minutos hoje" value={m?.minutesToday !== undefined ? `${m.minutesToday}m` : '–'} icon={<Clock className="h-5 w-5" />} />
        <StatCard label="Receita hoje" value={m?.revenueToday !== undefined ? formatAOA(m.revenueToday) : '–'} icon={<TrendingUp className="h-5 w-5" />} />
        <StatCard label="Ag. revisão" value={m?.agentsPendingReview ?? '–'} icon={<ShieldCheck className="h-5 w-5" />} />
        <StatCard
          label="Chamadas simultâneas"
          value={`${m?.concurrentNow ?? 0}/${m?.concurrentCapacity ?? '?'}`}
          icon={<Activity className="h-5 w-5" />}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2" padding={false}>
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Chamadas (últimas 24h)</h2>
          </div>
          <div className="p-4">
            {chart.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chart}>
                  <defs>
                    <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="calls" stroke="#6366f1" fill="url(#totalGrad)" name="Chamadas" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-gray-400">Sem dados disponíveis</div>
            )}
          </div>
        </Card>

        <Card padding={false}>
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Chamadas ao vivo</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {(m?.liveCalls ?? []).length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-gray-400">Nenhuma chamada activa</p>
            ) : (
              (m?.liveCalls ?? []).map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.to}</p>
                    <p className="text-xs text-gray-500 truncate">{c.tenantName}</p>
                  </div>
                  <span className="text-xs text-gray-400">{formatDate(c.startedAt)}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card padding={false}>
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Tenants recentes</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              {['Nome', 'Status', 'Saldo', 'Criado em'].map((h) => (
                <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(tenantsList?.data ?? []).map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">{t.name}</td>
                <td className="px-6 py-3">
                  <Badge className={t.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700' : t.status === 'SUSPENDED' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}>
                    {t.status}
                  </Badge>
                </td>
                <td className="px-6 py-3 text-gray-600">{formatAOA(t.balanceCents)}</td>
                <td className="px-6 py-3 text-gray-500">{formatDate(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
