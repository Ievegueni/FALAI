import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { financeApi } from '@/lib/api';
import { Card, StatCard, PageSpinner, Tabs } from '@/components/ui';
import { formatAOA, formatDateShort } from '@/lib/utils';
import { TrendingUp, DollarSign, Percent, Phone } from 'lucide-react';

export function FinancePage() {
  const [tab, setTab] = useState('summary');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const { data: summary, isLoading } = useQuery({
    queryKey: ['admin', 'finance', 'summary', from, to],
    queryFn: () => financeApi.summary({ from, to }),
  });

  const { data: margin } = useQuery({
    queryKey: ['admin', 'finance', 'margin', from, to],
    queryFn: () => financeApi.marginReport({ from, to }),
    enabled: tab === 'margin',
  });

  if (isLoading && !summary) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Financeiro</h1>
          <p className="text-sm text-gray-500">Receitas, custos e margens</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          <span className="text-gray-500 text-sm">–</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Receita"
          value={summary ? formatAOA(summary.revenueCents) : '–'}
          sub={summary ? `Subscrições ${formatAOA(summary.subscriptionRevenueCents)} · Chamadas ${formatAOA(summary.callRevenueCents)}` : undefined}
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard label="Custo fornecedores" value={summary ? formatAOA(summary.providerCostCents) : '–'} icon={<TrendingUp className="h-5 w-5" />} />
        <StatCard label="Margem" value={summary ? formatAOA(summary.marginCents) : '–'} icon={<TrendingUp className="h-5 w-5" />} />
        <StatCard
          label="Margem %"
          value={summary ? `${summary.marginPct.toFixed(1)}%` : '–'}
          icon={<Percent className="h-5 w-5" />}
          trend={summary ? { positive: summary.marginPct >= 30, label: summary.marginPct >= 30 ? 'Saudável' : 'Atenção' } : undefined}
        />
      </div>

      <Tabs tabs={[{ key: 'summary', label: 'Gráfico' }, { key: 'margin', label: 'Por tenant' }]} active={tab} onChange={setTab} />

      {tab === 'summary' && (
        <Card>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Receita vs Custo por dia</h2>
          {(summary?.chartData ?? []).length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={summary?.chartData ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDateShort(v)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 100).toFixed(0)} Kz`} />
                <Tooltip formatter={(v) => formatAOA(v as number)} labelFormatter={(l) => formatDateShort(l as string)} />
                <Legend />
                <Bar dataKey="revenueCents" fill="#6366f1" name="Receita" radius={[3, 3, 0, 0]} />
                <Bar dataKey="costCents" fill="#f59e0b" name="Custo" radius={[3, 3, 0, 0]} />
                <Bar dataKey="marginCents" fill="#10b981" name="Margem" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-sm text-gray-400">Sem dados para o período</div>
          )}
        </Card>
      )}

      {tab === 'margin' && (
        <Card padding={false}>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                {['Tenant', 'Receita', 'Custo', 'Margem', 'Margem %', 'Chamadas'].map((h) => (
                  <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(margin ?? []).map((r) => (
                <tr key={r.tenantId} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-gray-900">{r.tenantName}</td>
                  <td className="px-6 py-3 text-gray-600">{formatAOA(r.revenueCents)}</td>
                  <td className="px-6 py-3 text-gray-600">{formatAOA(r.costCents)}</td>
                  <td className="px-6 py-3 font-medium text-emerald-600">{formatAOA(r.marginCents)}</td>
                  <td className="px-6 py-3">
                    <span className={`font-medium ${r.marginPct >= 30 ? 'text-emerald-600' : r.marginPct >= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                      {r.marginPct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-500 flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{r.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
