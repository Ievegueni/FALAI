import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Phone, AlertCircle, PhoneOff, CheckCircle2, Ban } from 'lucide-react';
import { callsApi, tenantsApi } from '@/lib/api';
import { Card, Badge, Pagination, EmptyState, PageSpinner, StatCard } from '@/components/ui';
import { formatDate, formatDuration, formatAOA, callStatusColor, callStatusLabel } from '@/lib/utils';
import type { CallStatus } from '@/types';

function FailReasonBadge({ reason }: { reason: string }) {
  return (
    <span className="group relative inline-flex items-center gap-1 cursor-help">
      <AlertCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
      <span className="max-w-[140px] truncate text-red-600 text-xs">{reason}</span>
      <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden w-72 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg group-hover:block whitespace-pre-wrap">
        {reason}
      </span>
    </span>
  );
}

type DatePreset = 'today' | '7d' | '30d' | 'all';

function presetRange(preset: DatePreset): { dateFrom?: string; dateTo?: string } {
  if (preset === 'all') return {};
  const now = new Date();
  const from = new Date(now);
  if (preset === 'today') from.setHours(0, 0, 0, 0);
  if (preset === '7d') from.setDate(from.getDate() - 7);
  if (preset === '30d') from.setDate(from.getDate() - 30);
  return { dateFrom: from.toISOString() };
}

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: 'all', label: 'Tudo' },
];

export function CallsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CallStatus | ''>('');
  const [tenantId, setTenantId] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');

  const { dateFrom, dateTo } = useMemo(() => presetRange(datePreset), [datePreset]);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'calls', page, status, tenantId, datePreset],
    queryFn: () => callsApi.list({ page, status: status || undefined, tenantId: tenantId || undefined, dateFrom, dateTo }),
  });

  const { data: tenantPage } = useQuery({
    queryKey: ['admin', 'tenants', 'for-calls-filter'],
    queryFn: () => tenantsApi.list({ perPage: 200 }),
  });

  const stats = data?.stats;
  const answered = (stats?.COMPLETED ?? 0) + (stats?.ESCALATED ?? 0);
  const unanswered = (stats?.NO_ANSWER ?? 0) + (stats?.BUSY ?? 0) + (stats?.FAILED ?? 0);

  if (isLoading && !data) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Chamadas</h1>
          <p className="text-sm text-gray-500">{data?.total ?? 0} chamadas no período seleccionado</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => { setDatePreset(p.value); setPage(1); }}
                className={`px-3 py-2 text-sm ${datePreset === p.value ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <select
            value={tenantId}
            onChange={(e) => { setTenantId(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">Todos os tenants</option>
            {(tenantPage?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value as CallStatus | ''); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">Todos os status</option>
            <option value="QUEUED">Na fila</option>
            <option value="DIALING">A ligar</option>
            <option value="RINGING">A chamar</option>
            <option value="IN_PROGRESS">Em curso</option>
            <option value="COMPLETED">Concluída</option>
            <option value="NO_ANSWER">Sem resposta</option>
            <option value="BUSY">Ocupado</option>
            <option value="FAILED">Falhou</option>
            <option value="CANCELLED">Cancelada</option>
            <option value="ESCALATED">Escalada</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Chamadas feitas" value={stats?.total ?? 0} icon={<Phone className="h-5 w-5" />} />
        <StatCard
          label="Atendidas"
          value={answered}
          sub={stats?.total ? `${Math.round((answered / stats.total) * 100)}% do total` : undefined}
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
        <StatCard label="Ocupado" value={stats?.BUSY ?? 0} icon={<Ban className="h-5 w-5" />} />
        <StatCard
          label="Não atendidas"
          value={unanswered}
          sub={`Sem resposta: ${stats?.NO_ANSWER ?? 0} · Falhou: ${stats?.FAILED ?? 0}`}
          icon={<PhoneOff className="h-5 w-5" />}
        />
      </div>

      <Card padding={false}>
        {(data?.data ?? []).length === 0 ? (
          <EmptyState icon={<Phone className="h-8 w-8" />} title="Nenhuma chamada encontrada" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {['Destino', 'Status / Erro', 'Tenant', 'Agente', 'Duração', 'Custo', 'Criada em'].map((h) => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.data ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/calls/${c.id}`)}
                  >
                    <td className="px-6 py-3 font-medium text-gray-900">{c.to}</td>
                    <td className="px-6 py-3">
                      <div className="flex flex-col gap-1">
                        <Badge className={callStatusColor[c.status as CallStatus]}>
                          {callStatusLabel[c.status as CallStatus] ?? c.status}
                        </Badge>
                        {c.failReason && <FailReasonBadge reason={c.failReason} />}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{c.tenant?.name ?? '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.agent?.name ?? '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.durationSecs !== undefined ? formatDuration(c.durationSecs) : '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.costCents !== undefined ? formatAOA(c.costCents) : '–'}</td>
                    <td className="px-6 py-3 text-gray-500">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} total={data?.total ?? 0} perPage={data?.perPage ?? 20} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
